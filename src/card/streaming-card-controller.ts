/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Streaming card controller for the Lark/Feishu channel plugin.
 *
 * Manages the full lifecycle of a streaming CardKit card:
 * idle → creating → streaming → completed / aborted / terminated.
 *
 * Delegates throttling to FlushController and message-unavailable
 * detection to UnavailableGuard.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import type { ReplyPayload } from 'openclaw/plugin-sdk';
import { SILENT_REPLY_TOKEN } from 'openclaw/plugin-sdk/reply-runtime';
import { extractLarkApiCode } from '../core/api-error';
import { larkLogger } from '../core/lark-logger';
import { LarkClient } from '../core/lark-client';
import { registerShutdownHook } from '../core/shutdown-hooks';
import { sendCardFeishu, updateCardFeishu } from '../messaging/outbound/send';
import {
  STREAMING_ELEMENT_ID,
  buildCardContent,
  buildStreamingPreAnswerCard,
  buildStreamingThinkingCard,
  splitReasoningText,
  stripReasoningTags,
  toCardKit2,
} from './builder';
import {
  FEISHU_CARD_TABLE_LIMIT,
  isCardRateLimitError,
  isCardTableLimitError,
  sanitizeTextSegmentsForCard,
} from './card-error';
import {
  createCardEntity,
  sendCardByCardId,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from './cardkit';
import { FlushController } from './flush-controller';
import { ImageResolver } from './image-resolver';
import { optimizeMarkdownStyle } from './markdown-style';
import { type ToolUseDisplayResult, buildToolUseTitleSuffix, normalizeToolUseDisplay } from './tool-use-display';
import { clearToolUseTraceRun, getToolUseTraceSteps } from './tool-use-trace-store';
import { StreamingFooter } from './streaming-footer';
import { registerPauseTarget, unregisterPauseTarget } from './pause-registry';
import { incrementSessionStats, resolveSessionStatsKey } from './session-stats';

import type {
  CardKitState,
  CardPhase,
  FooterSessionMetrics,
  ReasoningState,
  StreamingCardDeps,
  StreamingTextState,
  TerminalReason,
  ToolUseState,
} from './reply-dispatcher-types';
import {
  EMPTY_REPLY_FALLBACK_TEXT,
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  THROTTLE_CONSTANTS,
} from './reply-dispatcher-types';
import { UnavailableGuard } from './unavailable-guard';

const log = larkLogger('card/streaming');

interface TerminalCardTextImageResolver {
  resolveImages(text: string): string;
}

interface TerminalCardContentInput {
  text: string;
  reasoningText?: string;
}

// ---------------------------------------------------------------------------
// StreamingCardController
// ---------------------------------------------------------------------------

export class StreamingCardController {
  // ---- Explicit state machine ----
  private phase: CardPhase = 'idle';

  // ---- Structured state ----
  private cardKit: CardKitState = {
    cardKitCardId: null,
    originalCardKitCardId: null,
    cardKitSequence: 0,
    cardMessageId: null,
  };
  private text: StreamingTextState = {
    accumulatedText: '',
    completedText: '',
    streamingPrefix: '',
    lastPartialText: '',
    lastFlushedText: '',
  };

  private reasoning: ReasoningState = {
    accumulatedReasoningText: '',
    reasoningStartTime: null,
    reasoningElapsedMs: 0,
    isReasoningPhase: false,
  };

  /** Completed reasoning phases (for collapsible thinking blocks). */
  private completedReasonings: Array<{ text: string; elapsedMs: number }> = [];
  /** Text accumulated at each reasoning boundary (for calculating output per round). */
  private outputAtReasoningBoundary: string[] = [];
  /** Text accumulated before the current reasoning phase started. */
  private textBeforeReasoning = '';

  private toolUse: ToolUseState = {
    startedAt: null,
    elapsedMs: 0,
    isActive: false,
  };
  /** 累计工具调用耗时（用于从 reasoningElapsedMs 中扣除） */
  private totalToolUseElapsedMs = 0;
  // ---- Sub-controllers ----
  private readonly flush: FlushController;
  private readonly guard: UnavailableGuard;
  private readonly imageResolver: ImageResolver;
  private readonly streamingFooter: StreamingFooter;

  // ---- Lifecycle ----
  private createEpoch = 0;
  private _terminalReason: TerminalReason | null = null;
  private dispatchFullyComplete = false;
  /** Set when the user clicks the stop button, preventing onIdle from overwriting the abort card. */
  private abortRequested = false;
  /** Set when onDeliver just populated streamingPrefix, to prevent onPartialReply from duplicating. */
  private deliverJustSetPrefix = false;
  /** Cached transcript cache usage (accumulated across all LLM calls in the turn). */
  private transcriptCacheUsage: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number } | null = null;
  private cardCreationPromise: Promise<void> | null = null;
  private disposeShutdownHook: (() => void) | null = null;
  // sessionId-based key for session stats (resolved at runtime)
  private sessionStatsKey: string | null = null;

  private readonly dispatchStartTime = Date.now();

  // ---- Injected dependencies ----
  private readonly deps: StreamingCardDeps;

  private elapsed(): number {
    return Date.now() - this.dispatchStartTime;
  }

  private needsFooterMetrics(): boolean {
    const footer = this.deps.resolvedFooter;
    return footer.tokens || footer.cache || footer.context || footer.model;
  }

  /** Read token usage from session store as fallback. */
  private readSessionStoreTokens(): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined {
    try {
      const runtime = LarkClient.runtime as Record<string, unknown> | null;
      if (!runtime) return undefined;

      const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
      const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
      const key = this.deps.sessionKey.trim().toLowerCase();
      const defaultAgentId = resolveDefaultAgentId(this.deps.cfg as Record<string, unknown>) || 'main';
      const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
      const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];

      const agentAny = (runtime as Record<string, unknown>).agent as Record<string, unknown> | undefined;
      const sessionApi = agentAny?.session as Record<string, unknown> | undefined;
      const resolveStorePath = sessionApi?.resolveStorePath as ((storePath?: string, opts?: { agentId?: string }) => string) | undefined;
      const loadSessionStore = sessionApi?.loadSessionStore as ((storePath: string) => Record<string, Record<string, unknown>>) | undefined;

      if (resolveStorePath && loadSessionStore) {
        const storePath = resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
        const store = loadSessionStore(storePath);

        for (const candidate of candidateKeys) {
          const val = store[candidate];
          if (val && typeof val === 'object') {
            const entry = val as Record<string, unknown>;
            const input = typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined;
            const output = typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined;
            const cacheRead = typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined;
            const cacheWrite = typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined;
            if (input != null || output != null || cacheRead != null || cacheWrite != null) {
              return { input, output, cacheRead, cacheWrite };
            }
          }
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  /**
   * Get last known metrics (synchronous, for terminal state recording).
   */
  private recordSessionStats(allowStoreFallback = true, footerMetrics?: FooterSessionMetrics): void {
    try {
      const runtime = LarkClient.runtime as Record<string, unknown> | null;
      if (!runtime) { incrementSessionStats(this.deps.sessionKey, {}); return; }

      // 从 session store 读取 sessionId，用作统计主键
      let statsKey = this.deps.sessionKey;
      try {
        const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
        const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
        const agent = runtime.agent as Record<string, unknown> | undefined;
        const sessionApi = agent?.session as Record<string, unknown> | undefined;
        const resolveStorePath = sessionApi?.resolveStorePath as ((storePath?: string, opts?: { agentId?: string }) => string) | undefined;
        const loadSessionStore = sessionApi?.loadSessionStore as ((storePath: string) => Record<string, Record<string, unknown>>) | undefined;
        if (resolveStorePath && loadSessionStore) {
          const storePath = resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
          const store = loadSessionStore(storePath);
          const key = this.deps.sessionKey.trim().toLowerCase();
          const entry = store[key] as Record<string, unknown> | undefined;
          const sessionId = entry?.sessionId as string | undefined;
          statsKey = resolveSessionStatsKey(this.deps.sessionKey, sessionId);
          this.sessionStatsKey = statsKey;
          this.streamingFooter.setSessionKey(statsKey);
        }
      } catch { /* 检测失败使用原始 sessionKey */ }

      // Priority 1: 使用 transcript 累加数据（最权威的当前轮数据源）
      if (this.transcriptCacheUsage && (this.transcriptCacheUsage.input != null || this.transcriptCacheUsage.cacheRead != null)) {
        const transcriptInput = this.transcriptCacheUsage.input ?? 0;
        const transcriptCacheRead = this.transcriptCacheUsage.cacheRead ?? 0;
        // input = 非缓存 input（不含 cacheRead），与 lastUsage 路径语义一致
        // 数据库中 input_tokens + cache_read = prompt_tokens
        const input = transcriptInput;
        const output = this.transcriptCacheUsage.output;
        const cacheRead = this.transcriptCacheUsage.cacheRead;
        const cacheWrite = this.transcriptCacheUsage.cacheWrite;
        log.info('recordSessionStats: using transcript data', { input, output, cacheRead, cacheWrite });
        incrementSessionStats(statsKey, { input, output, cacheRead, cacheWrite });
        return;
      }

      // Priority 2: Fallback to lastUsage (runtime data, may be inaccurate)
      const agent = runtime.agent as Record<string, unknown> | undefined;
      const session = agent?.session as Record<string, unknown> | undefined;
      const lastUsage = session?.lastUsage as Record<string, unknown> | undefined;

      if (lastUsage) {
        const input = typeof lastUsage.input === 'number' ? lastUsage.input : undefined;
        const output = typeof lastUsage.output === 'number' ? lastUsage.output : undefined;
        let cacheRead = typeof lastUsage.cacheRead === 'number' ? lastUsage.cacheRead : undefined;
        let cacheWrite = typeof lastUsage.cacheWrite === 'number' ? lastUsage.cacheWrite : undefined;
        if (input != null || output != null || cacheRead != null || cacheWrite != null) {
          log.info('recordSessionStats: using lastUsage (fallback)', { input, output, cacheRead, cacheWrite });
          incrementSessionStats(statsKey, { input, output, cacheRead, cacheWrite });
          return;
        }
      }

      // Fallback 1: 使用 footer 已经获取到的 metrics（由 getFooterSessionMetrics 计算好的差值）
      if (footerMetrics && (footerMetrics.inputTokens || footerMetrics.outputTokens)) {
        const input = footerMetrics.inputTokens ?? 0;
        const output = footerMetrics.outputTokens ?? 0;
        const cacheRead = footerMetrics.cacheRead ?? 0;
        const cacheWrite = footerMetrics.cacheWrite ?? 0;
        log.info('recordSessionStats: using footer metrics (pre-computed delta)', { input, output, cacheRead, cacheWrite });
        incrementSessionStats(statsKey, { input, output, cacheRead, cacheWrite });
        return;
      }

      // Fallback 2: 从 session store 读取当前 run 的 token 数据
      if (!allowStoreFallback) {
        log.warn('recordSessionStats: no lastUsage data, incrementing turn count only (abort context)');
        incrementSessionStats(statsKey, {});
        return;
      }
      const storeTokens = this.readSessionStoreTokens();
      if (storeTokens && (storeTokens.input || storeTokens.output)) {
        // 使用 transcript 累加的缓存数据修正 session store 的单次调用值
        if (this.transcriptCacheUsage) {
          if (this.transcriptCacheUsage.cacheRead != null) storeTokens.cacheRead = this.transcriptCacheUsage.cacheRead;
          if (this.transcriptCacheUsage.cacheWrite != null) storeTokens.cacheWrite = this.transcriptCacheUsage.cacheWrite;
        }
        log.info('recordSessionStats: using session store tokens', storeTokens);
        incrementSessionStats(statsKey, storeTokens);
        return;
      }

      log.warn('recordSessionStats: no token data available, incrementing turn count only');
      incrementSessionStats(statsKey, {});
    } catch (err) {
      log.error('recordSessionStats failed', { error: String(err) });
      incrementSessionStats(this.deps.sessionKey, {});
    }
  }

  /** Get last known metrics (synchronous, for terminal state recording). */
  /**
   * Calculate the output text for each completed reasoning round.
   *
   * Uses outputAtReasoningBoundary to compute the delta between reasoning rounds.
   * Returns an array parallel to completedReasonings.
   */
  private getCompletedOutputTexts(): string[] {
    // Use accumulatedText consistently since outputAtReasoningBoundary is built from it
    const finalText = this.text.accumulatedText || this.text.completedText || '';
    const outputs: string[] = [];
    for (let i = 0; i < this.completedReasonings.length; i++) {
      const start = this.outputAtReasoningBoundary[i] || '';
      const end = (i + 1 < this.outputAtReasoningBoundary.length)
        ? this.outputAtReasoningBoundary[i + 1]
        : finalText;
      const output = end.slice(start.length).trim();
      outputs.push(output);
    }
    return outputs;
  }

  /**
   * Read the session transcript file and accumulate cacheRead/cacheWrite from
   * all assistant messages. This corrects the runtime bug where the session
   * store only has the last LLM call's cache values instead of the accumulated
   * total for the entire turn.
   */
  private async accumulateTranscriptCacheUsage(sessionFile: string): Promise<{ cacheRead?: number; cacheWrite?: number; input?: number; output?: number }> {
    try {
      // Only accumulate assistant messages AFTER the last user message (current turn only).
      // The transcript file may contain multiple turns; we need just the current one.
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let foundCache = false;
      let foundToken = false;

      const rl = createInterface({
        input: createReadStream(sessionFile, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const msg = parsed?.message;
          if (!msg) continue;

          // Reset counters when we see a user message (new turn starts)
          if (msg.role === 'user') {
            totalCacheRead = 0;
            totalCacheWrite = 0;
            totalInput = 0;
            totalOutput = 0;
            foundCache = false;
            foundToken = false;
            continue;
          }

          if (msg.role === 'assistant' && msg.usage) {
            const u = msg.usage;
            const cr = typeof u.cacheRead === 'number' ? u.cacheRead : 0;
            const cw = typeof u.cacheWrite === 'number' ? u.cacheWrite : 0;
            if (cr > 0 || cw > 0) {
              totalCacheRead += cr;
              totalCacheWrite += cw;
              foundCache = true;
            }
            const inp = typeof u.input === 'number' ? u.input : 0;
            const out = typeof u.output === 'number' ? u.output : 0;
            if (inp > 0 || out > 0) {
              totalInput += inp;
              totalOutput += out;
              foundToken = true;
            }
          }
        } catch { /* skip malformed lines */ }
      }

      if (!foundCache && !foundToken) return {};
      return {
        cacheRead: totalCacheRead > 0 ? totalCacheRead : undefined,
        cacheWrite: totalCacheWrite > 0 ? totalCacheWrite : undefined,
        input: totalInput > 0 ? totalInput : undefined,
        output: totalOutput > 0 ? totalOutput : undefined,
      };
    } catch {
      return {};
    }
  }

  private async getFooterSessionMetrics(): Promise<FooterSessionMetrics | undefined> {
    try {
      const runtime = LarkClient.runtime as Record<string, unknown> | null;
      if (!runtime) return undefined;

      // Helper: read contextTokens + model + cache from session store (fallback)
      const readSessionStoreFallback = (): { contextTokens?: number; model?: string; cacheRead?: number; cacheWrite?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number } => {
        try {
          const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
          const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
          const key = this.deps.sessionKey.trim().toLowerCase();
          const defaultAgentId = resolveDefaultAgentId(this.deps.cfg as Record<string, unknown>) || 'main';
          const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
          const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];

          const agentAny = (runtime as Record<string, unknown>).agent as Record<string, unknown> | undefined;
          const sessionApi = agentAny?.session as Record<string, unknown> | undefined;
          const resolveStorePath = sessionApi?.resolveStorePath as ((storePath?: string, opts?: { agentId?: string }) => string) | undefined;
          const loadSessionStore = sessionApi?.loadSessionStore as ((storePath: string) => Record<string, Record<string, unknown>>) | undefined;

          if (resolveStorePath && loadSessionStore) {
            const storePath = resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
            const store = loadSessionStore(storePath);

            for (const candidate of candidateKeys) {
              const val = store[candidate];
              if (val && typeof val === 'object') {
                const entry = val as Record<string, unknown>;
                return {
                  contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
                  model: typeof entry.model === 'string' ? entry.model : undefined,
                  cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
                  cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
                  inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
                  outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
                  totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
                };
              }
            }
          }
        } catch { /* ignore */ }
        return {};
      };

      // Priority 1: Read token data from transcript file (per-turn, authoritative source)
      // Read transcript FIRST to get the sessionFile path, then accumulate all LLM call data.
      const cfgForTranscript = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
      const sessionStorePathForTranscript = cfgForTranscript.sessions?.store ?? cfgForTranscript.session?.store;
      const keyForTranscript = this.deps.sessionKey.trim().toLowerCase();
      const defaultAgentIdForTranscript = resolveDefaultAgentId(this.deps.cfg as Record<string, unknown>) || 'main';
      const fallbackKeyForTranscript = keyForTranscript.replace(/^(agent):[^:]+:/, `$1:${defaultAgentIdForTranscript}:`);
      const candidateKeysForTranscript = fallbackKeyForTranscript !== keyForTranscript ? [keyForTranscript, fallbackKeyForTranscript] : [keyForTranscript];

      const agentForTranscript = runtime.agent as Record<string, unknown> | undefined;
      const sessionForTranscript = agentForTranscript?.session as Record<string, unknown> | undefined;
      const resolveStorePathForTranscript = sessionForTranscript?.resolveStorePath as ((storePath?: string, opts?: { agentId?: string }) => string) | undefined;
      const loadSessionStoreForTranscript = sessionForTranscript?.loadSessionStore as ((storePath: string) => Record<string, Record<string, unknown>>) | undefined;

      let transcriptData: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number } | undefined;
      if (resolveStorePathForTranscript && loadSessionStoreForTranscript) {
        try {
          const storePath = resolveStorePathForTranscript(sessionStorePathForTranscript, { agentId: this.deps.agentId });
          const store = loadSessionStoreForTranscript(storePath);
          for (const candidate of candidateKeysForTranscript) {
            const val = store[candidate];
            if (val && typeof val === 'object') {
              const entry = val as Record<string, unknown>;
              const sessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : undefined;
              if (sessionFile) {
                transcriptData = await this.accumulateTranscriptCacheUsage(sessionFile);
                this.transcriptCacheUsage = transcriptData;
              }
              break;
            }
          }
        } catch { /* ignore */ }
      }

      // Use transcript data: input (non-cached) + cacheRead = total prompt tokens
      if (transcriptData && (transcriptData.input != null || transcriptData.cacheRead != null)) {
        const transcriptInput = transcriptData.input ?? 0;           // 非缓存 input
        const transcriptCacheRead = transcriptData.cacheRead ?? 0;    // 缓存命中
        const outputTokens = transcriptData.output;
        const resolvedCacheRead = transcriptData.cacheRead;
        const resolvedCacheWrite = transcriptData.cacheWrite;

        // Get contextTokens and model from session store or lastUsage
        const fallback = readSessionStoreFallback();
        const lastUsage = (runtime.agent as Record<string, unknown> | undefined)?.session &&
          ((runtime.agent as Record<string, unknown>).session as Record<string, unknown>).lastUsage as Record<string, unknown> | undefined;
        const contextTokens = (typeof lastUsage?.contextTokens === 'number' ? lastUsage.contextTokens : undefined) ?? fallback.contextTokens;
        const model = (typeof lastUsage?.model === 'string' ? lastUsage.model : undefined) ?? fallback.model;

        // inputTokens = 非缓存 input（不含 cacheRead）
        // 与 lastUsage 路径语义一致：footer 的 inputTokens + cacheRead = prompt_tokens
        // totalTokens 从 lastUsage / session store 获取（runtime 更新的准确值，考虑了上下文压缩）
        // 不用 transcript 累加值（会忽略上下文压缩，导致越累积越大）
        const lastUsageTotal = (typeof lastUsage?.total === 'number' ? lastUsage.total : undefined) ?? fallback.totalTokens;
        log.info('footer metrics: using transcript (current turn)', { transcriptInput, transcriptCacheRead, outputTokens, cacheRead: resolvedCacheRead, cacheWrite: resolvedCacheWrite, contextTokens, model, lastUsageTotal });
        return {
          inputTokens: transcriptInput > 0 ? transcriptInput : undefined,
          outputTokens,
          cacheRead: resolvedCacheRead,
          cacheWrite: resolvedCacheWrite,
          totalTokens: lastUsageTotal,
          contextTokens,
          model,
        };
      }

      // Priority 1b: Transcript unavailable — fallback to lastUsage (runtime data)
      const agent = runtime.agent as Record<string, unknown> | undefined;
      const session = agent?.session as Record<string, unknown> | undefined;
      const lastUsage = session?.lastUsage as Record<string, unknown> | undefined;

      if (lastUsage) {
        const inputTokens = typeof lastUsage.input === 'number' ? lastUsage.input : undefined;
        const outputTokens = typeof lastUsage.output === 'number' ? lastUsage.output : undefined;
        const cacheRead = typeof lastUsage.cacheRead === 'number' ? lastUsage.cacheRead : undefined;
        const cacheWrite = typeof lastUsage.cacheWrite === 'number' ? lastUsage.cacheWrite : undefined;
        const totalTokens = typeof lastUsage.total === 'number' ? lastUsage.total : undefined;
        const contextTokens = typeof lastUsage.contextTokens === 'number' ? lastUsage.contextTokens : undefined;
        const model = typeof lastUsage.model === 'string' ? lastUsage.model : undefined;

        if (inputTokens != null || outputTokens != null) {
          const fallback = readSessionStoreFallback();
          const resolvedContextTokens = contextTokens ?? fallback.contextTokens;
          const resolvedModel = model ?? fallback.model;
          let resolvedCacheRead = (cacheRead != null && cacheRead > 0) ? cacheRead : (fallback.cacheRead ?? cacheRead);
          let resolvedCacheWrite = (cacheWrite != null && cacheWrite > 0) ? cacheWrite : (fallback.cacheWrite ?? cacheWrite);
          const resolvedTotalTokens = totalTokens ?? (
            (inputTokens != null || outputTokens != null) ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined
          );
          log.debug('footer metrics: using lastUsage (fallback)', { inputTokens, outputTokens, cacheRead: resolvedCacheRead, cacheWrite: resolvedCacheWrite, contextTokens: resolvedContextTokens, totalTokens: resolvedTotalTokens });
          return { inputTokens, outputTokens, cacheRead: resolvedCacheRead, cacheWrite: resolvedCacheWrite, totalTokens: resolvedTotalTokens, contextTokens: resolvedContextTokens, model: resolvedModel };
        }
      }

      // Priority 2: Read contextTokens and model from session store (NOT token data)
      // Token data should only come from lastUsage (per-turn), not session store (cumulative)
      const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
      const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
      const key = this.deps.sessionKey.trim().toLowerCase();
      const defaultAgentId = resolveDefaultAgentId(this.deps.cfg as Record<string, unknown>) || 'main';
      const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
      const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];

      const runtimeAny = runtime as Record<string, unknown>;
      const agentAny = runtimeAny.agent as Record<string, unknown> | undefined;
      const sessionApi = agentAny?.session as Record<string, unknown> | undefined;
      const resolveStorePath = sessionApi?.resolveStorePath as ((storePath?: string, opts?: { agentId?: string }) => string) | undefined;
      const loadSessionStore = sessionApi?.loadSessionStore as ((storePath: string) => Record<string, Record<string, unknown>>) | undefined;

      if (resolveStorePath && loadSessionStore) {
        const storePath = resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
        const store = loadSessionStore(storePath);

        let entry: Record<string, unknown> | undefined;
        for (const candidate of candidateKeys) {
          const val = store[candidate];
          if (val && typeof val === 'object') {
            entry = val as Record<string, unknown>;
            break;
          }
        }

        if (entry) {
          // Priority 2: Transcript unavailable — read from session store
          const storeModel = typeof entry.model === 'string' ? entry.model : undefined;
          const report = entry.systemPromptReport as Record<string, unknown> | undefined;
          const resolvedModel = storeModel ?? (typeof report?.model === 'string' ? report.model : undefined);
          // Read transcript for cache data even in this fallback path
          let resolvedCacheRead = typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined;
          let resolvedCacheWrite = typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined;
          const sessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : undefined;
          if (sessionFile) {
            try {
              const transcriptCache = await this.accumulateTranscriptCacheUsage(sessionFile);
              if (transcriptCache.cacheRead != null) resolvedCacheRead = transcriptCache.cacheRead;
              if (transcriptCache.cacheWrite != null) resolvedCacheWrite = transcriptCache.cacheWrite;
              // Also use transcript input/output if available
              if (transcriptCache.input != null || transcriptCache.cacheRead != null) {
                const transcriptNonCached = transcriptCache.input ?? 0;
                const transcriptCached = transcriptCache.cacheRead ?? 0;
                log.info('footer metrics: using transcript from session store fallback', { transcriptNonCached, transcriptCached, output: transcriptCache.output, cacheRead: resolvedCacheRead, cacheWrite: resolvedCacheWrite });
                // totalTokens 从 session store 获取（runtime 更新的准确值，考虑了上下文压缩）
                return {
                  inputTokens: transcriptNonCached > 0 ? transcriptNonCached : undefined,
                  outputTokens: transcriptCache.output,
                  cacheRead: resolvedCacheRead,
                  cacheWrite: resolvedCacheWrite,
                  totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
                  contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
                  model: resolvedModel,
                };
              }
            } catch { /* fallback to session store values */ }
          }
          // Final fallback: use session store values directly
          const rawStoreInput = typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined;
          return {
            inputTokens: rawStoreInput,
            outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
            cacheRead: resolvedCacheRead,
            cacheWrite: resolvedCacheWrite,
            totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
            contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
            model: resolvedModel,
          };
        }
      }

      return undefined;
    } catch (err) {
      log.warn('footer metrics lookup failed', { error: String(err), sessionKey: this.deps.sessionKey });
      return undefined;
    }
  }

  constructor(deps: StreamingCardDeps) {
    this.deps = deps;

    this.guard = new UnavailableGuard({
      replyToMessageId: deps.replyToMessageId,
      getCardMessageId: () => this.cardKit.cardMessageId,
      onTerminate: () => {
        this.transition('terminated', 'UnavailableGuard', 'unavailable');
      },
    });

    this.flush = new FlushController(() => this.performFlush());

    this.imageResolver = new ImageResolver({
      cfg: deps.cfg,
      accountId: deps.accountId,
      onImageResolved: () => {
        if (!this.isTerminalPhase && this.cardKit.cardMessageId) {
          void this.throttledCardUpdate();
        }
      },
    });

    this.streamingFooter = new StreamingFooter(
      {
        status: deps.resolvedFooter.status,
        elapsed: deps.resolvedFooter.elapsed,
        tokens: deps.resolvedFooter.tokens,
        cache: deps.resolvedFooter.cache,
        context: deps.resolvedFooter.context,
        model: deps.resolvedFooter.model,
        sessionStats: deps.resolvedFooter.sessionStats,
        dailyStats: deps.resolvedFooter.dailyStats,
        monthlyStats: deps.resolvedFooter.monthlyStats,
      },
      deps.sessionKey,
    );

    // 设置默认模型名：当 session store 中没有 model 时作为兜底
    try {
      const runtime = LarkClient.runtime;
      if (runtime) {
        const sessionApi = runtime.agent?.session;
        const cfgWithSession = deps.cfg as Record<string, unknown>;
        const sessionStorePath = (cfgWithSession.sessions as Record<string, unknown>)?.store as string | undefined
          ?? (cfgWithSession.session as Record<string, unknown>)?.store as string | undefined;
        const resolveStorePath = sessionApi?.resolveStorePath;
        const loadSessionStore = sessionApi?.loadSessionStore;
        if (resolveStorePath && loadSessionStore) {
          const store = loadSessionStore(resolveStorePath(sessionStorePath, { agentId: deps.agentId }));
          const key = deps.sessionKey.trim().toLowerCase();
          const defaultAgentId = resolveDefaultAgentId(deps.cfg) || 'main';
          const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
          const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];
          for (const candidate of candidateKeys) {
            const entry = store[candidate] as Record<string, unknown> | undefined;
            if (entry && typeof entry === 'object') {
              const report = entry.systemPromptReport as Record<string, unknown> | undefined;
              const provider = report?.provider as string | undefined;
              const model = report?.model as string | undefined ?? entry.model as string | undefined;
              if (model) {
                // 拼接 provider 前缀，确保与 models-context-window.json 的 key 格式一致
                // session store 中 model 为 "mimo-v2.5-pro"，JSON 中 key 为 "mimo/mimo-v2.5-pro"
                const fullModel = provider && !model.includes('/') ? `${provider}/${model}` : model;
                this.streamingFooter.setDefaultModel(fullModel);
                break;
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Public accessors
  // ------------------------------------------------------------------

  get cardMessageId(): string | null {
    return this.cardKit.cardMessageId;
  }

  get isTerminalPhase(): boolean {
    return TERMINAL_PHASES.has(this.phase);
  }

  /**
   * Whether the card has been explicitly aborted (via abortCard()).
   *
   * Distinct from isTerminalPhase — creation_failed is NOT an abort;
   * it should allow fallthrough to static delivery in the factory.
   */
  get isAborted(): boolean {
    return this.phase === 'aborted';
  }

  /** Whether the reply pipeline was terminated due to an unavailable message. */
  get isTerminated(): boolean {
    return this.guard.isTerminated;
  }

  /** Check if the pipeline should skip further operations for this source. */
  shouldSkipForUnavailable(source: string): boolean {
    return this.guard.shouldSkip(source);
  }

  /** Attempt to terminate the pipeline due to an unavailable message error. */
  terminateIfUnavailable(source: string, err?: unknown): boolean {
    return this.guard.terminate(source, err);
  }

  /** Why the controller entered a terminal phase, or null if still active. */
  get terminalReason(): TerminalReason | null {
    return this._terminalReason;
  }

  /** @internal — exposed for test assertions only. */
  get currentPhase(): CardPhase {
    return this.phase;
  }

  private get shouldDisplayToolUse(): boolean {
    return this.deps.toolUseDisplay.showToolUse;
  }

  private computeToolUseDisplay(): ToolUseDisplayResult | null {
    if (!this.shouldDisplayToolUse) return null;
    const traceSteps = getToolUseTraceSteps(this.deps.sessionKey);
    return normalizeToolUseDisplay({
      traceSteps,
      showFullPaths: this.deps.toolUseDisplay.showFullPaths,
      showResultDetails: this.deps.toolUseDisplay.showToolResultDetails,
    });
  }

  private get visibleToolUseElapsedMs(): number | undefined {
    if (!this.shouldDisplayToolUse || !this.toolUse.startedAt) {
      return undefined;
    }
    return this.toolUse.elapsedMs || Date.now() - this.toolUse.startedAt;
  }

  private computeToolUseTitleSuffix(display: ToolUseDisplayResult | null): { zh: string; en: string } | undefined {
    if (!this.shouldDisplayToolUse) return undefined;
    const stepCount = display?.stepCount ?? 0;
    return stepCount > 0 ? buildToolUseTitleSuffix({ stepCount }) : undefined;
  }

  // ------------------------------------------------------------------
  // Unified callback guard
  // ------------------------------------------------------------------

  /**
   * Unified callback guard — returns true if the pipeline is active
   * and the callback should proceed.
   *
   * Combines three checks:
   * 1. guard.isTerminated — message recalled/deleted
   * 2. guard.shouldSkip(source) — eagerly detect unavailable messages
   * 3. isTerminalPhase — completed/aborted/terminated/creation_failed
   */
  private shouldProceed(source: string): boolean {
    if (this.guard.isTerminated || this.guard.shouldSkip(source)) return false;
    return !this.isTerminalPhase;
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------

  private isStaleCreate(epoch: number): boolean {
    return epoch !== this.createEpoch;
  }

  private transition(to: CardPhase, source: string, reason?: TerminalReason): boolean {
    const from = this.phase;
    if (from === to) return false;
    if (!PHASE_TRANSITIONS[from].has(to)) {
      log.warn('phase transition rejected', { from, to, source });
      return false;
    }
    this.phase = to;
    log.info('phase transition', { from, to, source, reason });
    if (TERMINAL_PHASES.has(to)) {
      this._terminalReason = reason ?? null;
      this.onEnterTerminalPhase();
    }
    return true;
  }

  private onEnterTerminalPhase(): void {
    this.createEpoch += 1;
    this.flush.cancelPendingFlush();
    this.flush.complete();
    this.disposeShutdownHook?.();
    this.disposeShutdownHook = null;

    // Unregister pause button target
    if (this.cardKit.cardMessageId) {
      unregisterPauseTarget(this.cardKit.cardMessageId);
    }

    // Note: recordSessionStats() is called in onIdle() after getFooterSessionMetrics()

    if (this.phase === 'terminated' || this.phase === 'creation_failed') {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  private markToolUseActivity(): void {
    if (!this.toolUse.startedAt) {
      this.toolUse.startedAt = Date.now();
    }
    this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
    this.toolUse.isActive = true;
  }

  private captureToolUseElapsed(): void {
    if (!this.toolUse.startedAt) return;
    const elapsed = Date.now() - this.toolUse.startedAt;
    if (this.toolUse.isActive) {
      this.totalToolUseElapsedMs += elapsed;
    }
    this.toolUse.elapsedMs = elapsed;
    this.toolUse.isActive = false;
  }

  // ------------------------------------------------------------------
  // SDK callback bindings
  // ------------------------------------------------------------------

  /**
   * Handle a deliver() call in streaming card mode.
   *
   * Accumulates text from the SDK's deliver callbacks to build the
   * authoritative "completedText" for the final card.
   */
  async onDeliver(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onDeliver')) return;

    const text = payload.text ?? '';
    if (!text.trim()) return;

    await this.ensureCardCreated();
    if (!this.shouldProceed('onDeliver.postCreate')) return;

    if (!this.cardKit.cardMessageId) return;
    this.captureToolUseElapsed();

    const split = splitReasoningText(text);

    if (split.reasoningText && !split.answerText) {
      // Pure reasoning payload
      if (!this.reasoning.isReasoningPhase && this.text.accumulatedText) {
        // Save text accumulated before reasoning started
        this.textBeforeReasoning = this.text.accumulatedText;
      }
      // Ensure reasoningStartTime is set (may not be set if reasoning arrives via deliver instead of stream)
      if (!this.reasoning.reasoningStartTime) {
        this.reasoning.reasoningStartTime = Date.now();
      }
      this.reasoning.reasoningElapsedMs = Date.now() - this.reasoning.reasoningStartTime - this.totalToolUseElapsedMs;
      this.reasoning.accumulatedReasoningText = split.reasoningText;
      this.reasoning.isReasoningPhase = true;
      await this.throttledCardUpdate();
      return;
    }

    // Answer payload (may also contain inline reasoning from tags)
    if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
      // Save completed reasoning round (deduplicate: skip if already pushed)
      const elapsed = this.reasoning.reasoningStartTime ? Date.now() - this.reasoning.reasoningStartTime - this.totalToolUseElapsedMs : 0;
      // 同步更新 reasoningElapsedMs，确保终态卡片显示正确的思考耗时
      this.reasoning.reasoningElapsedMs = elapsed;
      const lastReasoning = this.completedReasonings[this.completedReasonings.length - 1];
      if (!lastReasoning || lastReasoning.text !== this.reasoning.accumulatedReasoningText) {
        this.completedReasonings.push({ text: this.reasoning.accumulatedReasoningText, elapsedMs: elapsed });
        // Save the accumulated text at this reasoning boundary for output delta calculation
        this.outputAtReasoningBoundary.push(this.textBeforeReasoning || this.text.accumulatedText || '');
      }
    }
    this.textBeforeReasoning = '';
    this.reasoning.isReasoningPhase = false;
    this.reasoning.accumulatedReasoningText = '';
    this.reasoning.reasoningStartTime = null;
    this.totalToolUseElapsedMs = 0;
    const answerText = split.answerText ?? text;

    // 累积 deliver 文本用于最终卡片
    // 当 onPartialReply 已处理过文本时（lastPartialText 非空），跳过 completedText 更新
    // 避免 onDeliver 和 onPartialReply 同时累积导致文本重复
    if (!this.text.lastPartialText) {
      this.text.completedText += (this.text.completedText ? '\n\n' : '') + answerText;
    }

    // 没有流式数据时，用 deliver 文本显示在卡片上
    if (!this.text.lastPartialText && !this.text.streamingPrefix) {
      // 首次 deliver：设置 prefix
      this.text.accumulatedText += (this.text.accumulatedText ? '\n\n' : '') + answerText;
      this.text.streamingPrefix = this.text.accumulatedText;
      this.deliverJustSetPrefix = true;
      await this.throttledCardUpdate();
    } else if (!this.text.lastPartialText && this.text.streamingPrefix) {
      // 后续 deliver：保留现有 prefix，只拼接到 accumulatedText
      this.text.accumulatedText = this.text.streamingPrefix + '\n\n' + answerText;
      await this.throttledCardUpdate();
    }
  }

  async onReasoningStream(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onReasoningStream')) return;

    await this.ensureCardCreated();
    if (!this.shouldProceed('onReasoningStream.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;

    const rawText = payload.text ?? '';
    if (!rawText) return;

    // Capture text before reasoning starts (for output delta calculation)
    if (!this.reasoning.isReasoningPhase && this.text.accumulatedText) {
      this.textBeforeReasoning = this.text.accumulatedText;
    }
    if (!this.reasoning.reasoningStartTime) {
      this.reasoning.reasoningStartTime = Date.now();
    }
    this.reasoning.isReasoningPhase = true;
    const split = splitReasoningText(rawText);
    // Replace (not append) — the framework sends the full accumulated
    // reasoning text on each callback, not incremental deltas.
    this.reasoning.accumulatedReasoningText = split.reasoningText ?? rawText;
    await this.throttledCardUpdate();
  }

  async onToolStart(payload: { name?: string; phase?: string }): Promise<void> {
    if (!this.shouldProceed('onToolStart')) return;
    if (!this.shouldDisplayToolUse) return;
    if (payload.phase && payload.phase !== 'start') return;

    this.markToolUseActivity();

    await this.ensureCardCreated();
    if (!this.shouldProceed('onToolStart.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    if (!this.text.accumulatedText && this.cardKit.cardKitCardId) {
      await this.throttledToolUseStatusUpdate();
      return;
    }
    await this.throttledCardUpdate();
  }

  async onToolPayload(_payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onToolPayload')) return;
    if (!this.shouldDisplayToolUse) return;

    this.markToolUseActivity();

    await this.ensureCardCreated();
    if (!this.shouldProceed('onToolPayload.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    if (!this.text.accumulatedText && this.cardKit.cardKitCardId) {
      await this.throttledToolUseStatusUpdate();
      return;
    }
    await this.throttledCardUpdate();
  }

  async onPartialReply(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onPartialReply')) return;

    // Strip <think> tags from partial reply text — reasoning content is
    // already handled by onReasoningStream and onDeliver callbacks.
    // Processing <think> tags here would create duplicate/fragmented thinking
    // entries because every partial reply with both thinking and answer text
    // would save the reasoning again.
    const rawText = payload.text ?? '';
    const text = stripReasoningTags(rawText);
    log.debug('onPartialReply', { len: text.length });
    if (!text) return;

    this.captureToolUseElapsed();
    if (this.reasoning.isReasoningPhase) {
      this.reasoning.isReasoningPhase = false;
      this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime
        ? Date.now() - this.reasoning.reasoningStartTime - this.totalToolUseElapsedMs
        : 0;
      // Save completed reasoning round (deduplicate: skip if already pushed)
      if (this.reasoning.accumulatedReasoningText) {
        const lastReasoning = this.completedReasonings[this.completedReasonings.length - 1];
        if (!lastReasoning || lastReasoning.text !== this.reasoning.accumulatedReasoningText) {
          this.completedReasonings.push({
            text: this.reasoning.accumulatedReasoningText,
            elapsedMs: this.reasoning.reasoningElapsedMs,
          });
          // Save the accumulated text at this reasoning boundary
          this.outputAtReasoningBoundary.push(this.textBeforeReasoning || '');
        }
      }
      // Restore text that was accumulated before reasoning started.
      // Without this, the first output chunk (delivered before thinking)
      // would be lost because onDeliver set streamingPrefix but
      // onReasoningStream saved it to textBeforeReasoning and cleared
      // accumulatedText. We need to restore it so the full output is shown.
      if (this.textBeforeReasoning && !this.text.streamingPrefix) {
        this.text.streamingPrefix = this.textBeforeReasoning;
      }
      this.textBeforeReasoning = '';
      this.reasoning.accumulatedReasoningText = '';
      this.reasoning.reasoningStartTime = null;
      this.totalToolUseElapsedMs = 0;
    }

    // 注意：已移除“回复边界检测”逻辑（text.length < lastPartialText.length → streamingPrefix += lastPartialText）
    // 原因：OpenClaw runtime 传入累积文本（非 delta），流式输出中长度波动是正常现象（LLM re-sampling），
    // 边界检测会误触发导致整段文本重复。streamingPrefix 的恢复由 reasoning 结束时的独立逻辑处理。
    this.text.lastPartialText = text;
    // 防止 onDeliver 设置的 streamingPrefix 与 onPartialReply 的 text 重复拼接
    // 当 onDeliver 先处理了初始文本并设置 streamingPrefix，onPartialReply 收到相同文本时不应重复拼接
    if (this.deliverJustSetPrefix) {
      this.deliverJustSetPrefix = false;
      this.text.accumulatedText = this.text.streamingPrefix;
    } else if (this.text.streamingPrefix) {
      this.text.accumulatedText = this.text.streamingPrefix + '\n\n' + text;
    } else {
      this.text.accumulatedText = text;
    }

    // NO_REPLY 缓冲
    if (!this.text.streamingPrefix && SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim())) {
      log.debug('onPartialReply: buffering NO_REPLY prefix');
      return;
    }

    await this.ensureCardCreated();
    if (!this.shouldProceed('onPartialReply.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    await this.throttledCardUpdate();
  }

  async onError(err: unknown, info: { kind: string }): Promise<void> {
    if (this.guard.terminate('onError', err)) return;

    log.error(`${info.kind} reply failed`, { error: String(err) });

    this.captureToolUseElapsed();
    this.finalizeCard('onError', 'error');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) await this.cardCreationPromise;

    const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
    // Record session stats AFTER getFooterSessionMetrics() to ensure lastUsage is available
    this.recordSessionStats(true, footerMetrics);
    const toolUseDisplay = this.computeToolUseDisplay();
    try {
      if (this.cardKit.cardMessageId) {
        const rawErrorText = this.text.accumulatedText
          ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.`
          : '**Error**: An error occurred while generating the response.';
        const terminalContent = prepareTerminalCardContent(
          {
            text: rawErrorText,
            reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          },
          this.imageResolver,
        );
        const errorCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: toolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs: this.elapsed(),
          isError: true,
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footer: this.deps.resolvedFooter,
          footerMetrics,
          footerContent: this.streamingFooter.buildContent(footerMetrics, true),
        });
        if (errorEffectiveCardId) {
          await this.closeStreamingAndUpdate(errorEffectiveCardId, errorCard, 'onError');
        } else {
          await updateCardFeishu({
            cfg: this.deps.cfg,
            messageId: this.cardKit.cardMessageId,
            card: errorCard as unknown as Record<string, unknown>,
            accountId: this.deps.accountId,
          });
        }
      }
    } catch {
      // Ignore update failures during error handling
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  async onIdle(): Promise<void> {
    if (this.guard.isTerminated || this.guard.shouldSkip('onIdle')) return;

    if (!this.dispatchFullyComplete) return;

    // 用户点击了停止按钮，不覆盖 abort 的卡片
    if (this.abortRequested) return;
    if (this.isTerminalPhase) return;
    this.captureToolUseElapsed();
    this.finalizeCard('onIdle', 'normal');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.flush.waitForFlush();
    }

    const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    try {
      if (this.cardKit.cardMessageId) {
        if (idleEffectiveCardId) {
          const seqBeforeClose = this.cardKit.cardKitSequence;
          this.cardKit.cardKitSequence += 1;
          log.info('onIdle: closing streaming mode', {
            seqBefore: seqBeforeClose,
            seqAfter: this.cardKit.cardKitSequence,
          });
          await setCardStreamingMode({
            cfg: this.deps.cfg,
            cardId: idleEffectiveCardId,
            streamingMode: false,
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
          });
        }

        const isNoReplyLeak =
          !this.text.completedText && SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim());
        const displayText =
          (isNoReplyLeak ? '' : this.text.accumulatedText) || this.text.completedText || EMPTY_REPLY_FALLBACK_TEXT;
        if (!this.text.completedText && !this.text.accumulatedText) {
          log.warn('reply completed without visible text, using empty-reply fallback');
        }

        // 等待图片异步解析（最多 15s），避免终态卡片留占位符
        const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15_000);

        // 调试日志：打印终态卡片 markdown 内容长度
        log.info('onIdle: terminal content', {
          textLen: resolvedDisplayText.length,
          textPreview: resolvedDisplayText.slice(0, 200),
        });

        const idleToolUseDisplay = this.computeToolUseDisplay();
        const terminalContent = prepareTerminalCardContent(
          {
            text: resolvedDisplayText,
            reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          },
          this.imageResolver,
        );
        const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;

        // Record session stats AFTER getFooterSessionMetrics() to ensure lastUsage is available
        this.recordSessionStats(true, footerMetrics);

        const completeCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: idleToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(idleToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs: this.elapsed(),
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footer: this.deps.resolvedFooter,
          footerMetrics,
          footerContent: this.streamingFooter.buildContent(footerMetrics, true),
        });

        if (idleEffectiveCardId) {
          const seqBeforeUpdate = this.cardKit.cardKitSequence;
          this.cardKit.cardKitSequence += 1;
          log.info('onIdle: updating final card', {
            seqBefore: seqBeforeUpdate,
            seqAfter: this.cardKit.cardKitSequence,
          });
          try {
            await updateCardKitCard({
              cfg: this.deps.cfg,
              cardId: idleEffectiveCardId,
              card: toCardKit2(completeCard),
              sequence: this.cardKit.cardKitSequence,
              accountId: this.deps.accountId,
            });
          } catch (cardKitErr) {
            // CardKit 更新失败，fallback 到 IM patch（V1 格式，支持 Markdown 渲染）
            log.warn('onIdle: CardKit final update failed, falling back to IM patch', {
              error: String(cardKitErr),
            });
            await updateCardFeishu({
              cfg: this.deps.cfg,
              messageId: this.cardKit.cardMessageId,
              card: completeCard as unknown as Record<string, unknown>,
              accountId: this.deps.accountId,
            });
          }
        } else {
          await updateCardFeishu({
            cfg: this.deps.cfg,
            messageId: this.cardKit.cardMessageId,
            card: completeCard as unknown as Record<string, unknown>,
            accountId: this.deps.accountId,
          });
        }
        log.info('reply completed, card finalized', {
          elapsedMs: this.elapsed(),
          isCardKit: !!idleEffectiveCardId,
        });
      }
    } catch (err) {
      log.warn('final card update failed', { error: String(err) });
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  // ------------------------------------------------------------------
  // External control
  // ------------------------------------------------------------------

  markFullyComplete(): void {
    log.debug('markFullyComplete', {
      completedTextLen: this.text.completedText.length,
      accumulatedTextLen: this.text.accumulatedText.length,
    });
    this.dispatchFullyComplete = true;
  }

  async abortCard(): Promise<void> {
    try {
      this.abortRequested = true;
      this.captureToolUseElapsed();
      // Update reasoning elapsed time to reflect actual duration at abort point
      if (this.reasoning.isReasoningPhase && this.reasoning.reasoningStartTime) {
        this.reasoning.reasoningElapsedMs = Date.now() - this.reasoning.reasoningStartTime - this.totalToolUseElapsedMs;
      }
      if (!this.transition('aborted', 'abortCard', 'abort')) return;

      // transition() already executed onEnterTerminalPhase (cancel + complete + dispose hook)
      // Only need to wait for any in-flight flush to finish
      await this.flush.waitForFlush();

      if (this.cardCreationPromise) await this.cardCreationPromise;

      const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
      const elapsedMs = Date.now() - this.dispatchStartTime;
      const abortToolUseDisplay = this.computeToolUseDisplay();
      const terminalContent = prepareTerminalCardContent(
        {
          text: this.text.accumulatedText || 'Aborted.',
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
        },
        this.imageResolver,
      );
      const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
      // 中止时传入 footerMetrics，让 recordSessionStats 能使用已获取的 token 数据
      this.recordSessionStats(false, footerMetrics);
      if (effectiveCardId) {
        const abortCardContent = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: abortToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs,
          isAborted: true,
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footer: this.deps.resolvedFooter,
          footerMetrics,
          footerContent: this.streamingFooter.buildContent(footerMetrics, true, true),
        });
        await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, 'abortCard');
        log.info('abortCard completed', { effectiveCardId });
      } else if (this.cardKit.cardMessageId) {
        // IM fallback: 卡片不是通过 CardKit 发的，用 im.message.patch 更新
        const abortCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: abortToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs,
          isAborted: true,
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footer: this.deps.resolvedFooter,
          footerMetrics,
          footerContent: this.streamingFooter.buildContent(footerMetrics, true, true),
        });
        await updateCardFeishu({
          cfg: this.deps.cfg,
          messageId: this.cardKit.cardMessageId,
          card: abortCard as unknown as Record<string, unknown>,
          accountId: this.deps.accountId,
        });
        log.info('abortCard completed (IM fallback)', {
          messageId: this.cardKit.cardMessageId,
        });
      }
    } catch (err) {
      log.warn('abortCard failed', { error: String(err) });
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  // ------------------------------------------------------------------
  // Internal: card creation
  // ------------------------------------------------------------------

  async ensureCardCreated(): Promise<void> {
    if (this.guard.shouldSkip('ensureCardCreated.precheck')) return;
    if (this.cardKit.cardMessageId || this.phase === 'creation_failed' || this.isTerminalPhase) {
      return;
    }
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }
    if (!this.transition('creating', 'ensureCardCreated')) return;
    this.createEpoch += 1;
    const epoch = this.createEpoch;
    this.cardCreationPromise = (async () => {
      try {
        try {
          // Step 1: Create card entity
          const cId = await createCardEntity({
            cfg: this.deps.cfg,
            card: buildStreamingThinkingCard(this.deps.toolUseDisplay.showToolUse),
            accountId: this.deps.accountId,
          });

          if (this.isStaleCreate(epoch)) {
            log.info('ensureCardCreated: stale epoch after createCardEntity, bailing out', {
              epoch,
              phase: this.phase,
            });
            return;
          }

          if (cId) {
            this.cardKit.cardKitCardId = cId;
            this.cardKit.originalCardKitCardId = cId;
            this.cardKit.cardKitSequence = 1;
            this.disposeShutdownHook = registerShutdownHook(`streaming-card:${cId}`, () => this.abortCard());
            log.info('created CardKit entity', {
              cardId: cId,
              initialSequence: this.cardKit.cardKitSequence,
            });

            // Step 2: Send IM message referencing card_id
            const result = await sendCardByCardId({
              cfg: this.deps.cfg,
              to: this.deps.chatId,
              cardId: cId,
              replyToMessageId: this.deps.replyToMessageId,
              replyInThread: this.deps.replyInThread,
              accountId: this.deps.accountId,
            });

            if (this.isStaleCreate(epoch)) {
              log.info('ensureCardCreated: stale epoch after sendCardByCardId, bailing out', {
                epoch,
                phase: this.phase,
              });
              this.disposeShutdownHook?.();
              this.disposeShutdownHook = null;
              return;
            }

            this.cardKit.cardMessageId = result.messageId;
            this.flush.setCardMessageReady(true);
            if (!this.transition('streaming', 'ensureCardCreated.cardkit')) {
              this.disposeShutdownHook?.();
              this.disposeShutdownHook = null;
              return;
            }
            log.info('sent CardKit card', { messageId: result.messageId });

            // Register pause target for stop button
            if (this.deps.abortController) {
              registerPauseTarget(result.messageId, {
                abortController: this.deps.abortController,
                cardMessageId: result.messageId,
                onAbort: () => this.abortCard(),
              });
            }

            // Initialize streaming footer
            this.streamingFooter.init();
          } else {
            throw new Error('card.create returned empty card_id');
          }
        } catch (cardKitErr: unknown) {
          if (this.isStaleCreate(epoch)) return;
          if (this.guard.terminate('ensureCardCreated.cardkitFlow', cardKitErr)) {
            return;
          }
          // CardKit flow failed — fall back to regular IM card
          const apiDetail = extractApiDetail(cardKitErr);
          log.warn('CardKit flow failed, falling back to IM', { apiDetail });
          this.cardKit.cardKitCardId = null;
          this.cardKit.originalCardKitCardId = null;

          const fallbackCard = buildCardContent('streaming', {
            showToolUse: this.deps.toolUseDisplay.showToolUse,
          });
          const result = await sendCardFeishu({
            cfg: this.deps.cfg,
            to: this.deps.chatId,
            card: fallbackCard as unknown as Record<string, unknown>,
            replyToMessageId: this.deps.replyToMessageId,
            replyInThread: this.deps.replyInThread,
            accountId: this.deps.accountId,
          });

          if (this.isStaleCreate(epoch)) {
            log.info('ensureCardCreated: stale epoch after IM fallback send, bailing out', {
              epoch,
              phase: this.phase,
            });
            return;
          }

          this.cardKit.cardMessageId = result.messageId;
          this.flush.setCardMessageReady(true);
          if (!this.transition('streaming', 'ensureCardCreated.imFallback')) {
            return;
          }
          log.info('sent fallback IM card', { messageId: result.messageId });

          // Register pause target for stop button (IM fallback path)
          if (this.deps.abortController) {
            registerPauseTarget(result.messageId, {
              abortController: this.deps.abortController,
              cardMessageId: result.messageId,
              onAbort: () => this.abortCard(),
            });
          }
        }
      } catch (err) {
        if (this.isStaleCreate(epoch)) return;
        if (this.guard.terminate('ensureCardCreated.outer', err)) {
          return;
        }
        log.warn('thinking card failed, falling back to static', {
          error: String(err),
        });
        this.transition('creation_failed', 'ensureCardCreated.outer', 'creation_failed');
      }
    })();
    await this.cardCreationPromise;
  }

  // ------------------------------------------------------------------
  // Internal: flush
  // ------------------------------------------------------------------

  private async performFlush(): Promise<void> {
    if (!this.cardKit.cardMessageId || this.isTerminalPhase) return;

    // 当 CardKit 流式更新失败时（cardKitCardId = null），fallback 到 IM patch
    // IM patch 使用 V1 格式，支持 Markdown 渲染

    log.info('flushCardUpdate: enter', {
      seq: this.cardKit.cardKitSequence,
      isCardKit: !!this.cardKit.cardKitCardId,
    });

    try {
      const displayText = this.buildDisplayText();
      // 流式中间帧使用同步 resolveImages（不等待异步上传）
      const resolvedText = this.imageResolver.resolveImages(displayText);

      // 调试日志：打印发送到卡片的 markdown 内容长度
      log.info('flushCardUpdate: content', {
        textLen: resolvedText.length,
        textPreview: resolvedText.slice(0, 200),
      });

      // 流式 footer 使用 getFooterSessionMetrics（含 session store fallback）
      // 因为 lastUsage 在流式过程中始终为 null，无法获取实时 token 数据
      // 但 session store 中的 contextTokens 和 model 是可用的
      const streamingMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;

      if (this.cardKit.cardKitCardId) {
        // CardKit path: update full card via card.update API
        // (supports all enhanced features: footer, thinking panels, stop button)
        const flushDisplay = this.computeToolUseDisplay();
        const footerContent = this.streamingFooter.shouldUpdate()
          ? this.streamingFooter.buildContent(streamingMetrics)
          : undefined;
        const card = buildCardContent('streaming', {
          text: this.reasoning.isReasoningPhase ? '' : resolvedText,
          reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : undefined,
          toolUseSteps: flushDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(flushDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footerContent,
        });
        const prevSeq = this.cardKit.cardKitSequence;
        this.cardKit.cardKitSequence += 1;
        log.debug('flushCardUpdate: CardKit full card update', {
          seqBefore: prevSeq,
          seqAfter: this.cardKit.cardKitSequence,
        });
        await updateCardKitCard({
          cfg: this.deps.cfg,
          cardId: this.cardKit.cardKitCardId,
          card: toCardKit2(card),
          sequence: this.cardKit.cardKitSequence,
          accountId: this.deps.accountId,
        });
        this.text.lastFlushedText = resolvedText;
      } else {
        log.debug('flushCardUpdate: IM patch fallback');
        const flushDisplay = this.computeToolUseDisplay();
        const footerContent = this.streamingFooter.shouldUpdate()
          ? this.streamingFooter.buildContent(streamingMetrics)
          : undefined;
        const card = buildCardContent('streaming', {
          text: this.reasoning.isReasoningPhase ? '' : resolvedText,
          reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : undefined,
          toolUseSteps: flushDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(flushDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          completedReasonings: this.completedReasonings.length > 0 ? this.completedReasonings : undefined,
          completedOutputs: this.getCompletedOutputTexts().length > 0 ? this.getCompletedOutputTexts() : undefined,
          footerContent,
        });
        await updateCardFeishu({
          cfg: this.deps.cfg,
          messageId: this.cardKit.cardMessageId,
          card: card as unknown as Record<string, unknown>,
          accountId: this.deps.accountId,
        });
      }
    } catch (err: unknown) {
      if (this.guard.terminate('flushCardUpdate', err)) return;

      const apiCode = extractLarkApiCode(err);

      // 速率限制（230020）— 跳过此帧，不降级
      if (isCardRateLimitError(err)) {
        log.info('flushCardUpdate: rate limited (230020), skipping', {
          seq: this.cardKit.cardKitSequence,
        });
        return;
      }

      // 卡片表格数超出飞书限制（230099/11310）— 禁用 CardKit 流式，
      // 保留 originalCardKitCardId 供 onIdle 做最终 CardKit 更新
      if (isCardTableLimitError(err)) {
        log.warn('flushCardUpdate: card table limit exceeded (230099/11310), disabling CardKit streaming', {
          seq: this.cardKit.cardKitSequence,
        });
        this.cardKit.cardKitCardId = null;
        return;
      }

      const apiDetail = extractApiDetail(err);
      log.error('card stream update failed', {
        apiCode,
        seq: this.cardKit.cardKitSequence,
        apiDetail,
      });
      if (this.cardKit.cardKitCardId) {
        log.warn('disabling CardKit streaming, falling back to im.message.patch');
        this.cardKit.cardKitCardId = null;
      }
    }
  }

  private buildDisplayText(): string {
    if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
      const reasoningDisplay = `💭 **Thinking...**\n\n${this.reasoning.accumulatedReasoningText}`;
      return this.text.accumulatedText ? this.text.accumulatedText + '\n\n' + reasoningDisplay : reasoningDisplay;
    }
    return this.text.accumulatedText;
  }

  private async throttledCardUpdate(): Promise<void> {
    if (this.guard.shouldSkip('throttledCardUpdate')) return;
    const throttleMs = this.cardKit.cardKitCardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS;
    await this.flush.throttledUpdate(throttleMs);
  }

  // ---- Tool-use status streaming (pre-answer phase) ----

  private lastToolUseStatusUpdateTime = 0;

  private async throttledToolUseStatusUpdate(): Promise<void> {
    if (!this.cardKit.cardKitCardId) return;
    const now = Date.now();
    if (now - this.lastToolUseStatusUpdateTime < THROTTLE_CONSTANTS.REASONING_STATUS_MS) return;
    this.lastToolUseStatusUpdateTime = now;
    await this.updateToolUseStatus();
  }

  private async updateToolUseStatus(): Promise<void> {
    if (!this.cardKit.cardKitCardId || this.isTerminalPhase) return;
    try {
      const display = this.computeToolUseDisplay();
      const card = buildStreamingPreAnswerCard({
        steps: display?.steps,
        elapsedMs: this.visibleToolUseElapsedMs,
        showToolUse: this.shouldDisplayToolUse,
      });
      this.cardKit.cardKitSequence += 1;
      await updateCardKitCard({
        cfg: this.deps.cfg,
        cardId: this.cardKit.cardKitCardId,
        card,
        sequence: this.cardKit.cardKitSequence,
        accountId: this.deps.accountId,
      });
    } catch (err) {
      log.debug('updateToolUseStatus failed', { error: String(err) });
    }
  }

  // ------------------------------------------------------------------
  // Internal: lifecycle helpers
  // ------------------------------------------------------------------

  private finalizeCard(source: string, reason: TerminalReason): void {
    this.transition('completed', source, reason);
  }

  /**
   * Close streaming mode then update card content (shared by onError and abortCard).
   */
  private async closeStreamingAndUpdate(
    cardId: string,
    card: ReturnType<typeof buildCardContent>,
    label: string,
  ): Promise<void> {
    const seqBeforeClose = this.cardKit.cardKitSequence;
    this.cardKit.cardKitSequence += 1;
    log.info(`${label}: closing streaming mode`, {
      seqBefore: seqBeforeClose,
      seqAfter: this.cardKit.cardKitSequence,
    });
    await setCardStreamingMode({
      cfg: this.deps.cfg,
      cardId,
      streamingMode: false,
      sequence: this.cardKit.cardKitSequence,
      accountId: this.deps.accountId,
    });
    const seqBeforeUpdate = this.cardKit.cardKitSequence;
    this.cardKit.cardKitSequence += 1;
    log.info(`${label}: updating card`, {
      seqBefore: seqBeforeUpdate,
      seqAfter: this.cardKit.cardKitSequence,
    });
    await updateCardKitCard({
      cfg: this.deps.cfg,
      cardId,
      card: toCardKit2(card),
      sequence: this.cardKit.cardKitSequence,
      accountId: this.deps.accountId,
    });
  }
}

// ---------------------------------------------------------------------------
// Error detail extraction helpers (replacing `any` casts)
// ---------------------------------------------------------------------------

/**
 * 终态卡片的正文和 reasoning 都会被飞书按 markdown 渲染，
 * 因此两者都要先做图片替换与表格降级，避免再次撞到 230099/11310。
 */
export function prepareTerminalCardContent(
  content: TerminalCardContentInput,
  imageResolver: TerminalCardTextImageResolver,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): TerminalCardContentInput {
  const resolvedReasoningText = content.reasoningText ? imageResolver.resolveImages(content.reasoningText) : undefined;
  const resolvedText = imageResolver.resolveImages(content.text);
  const sanitizedSegments = sanitizeTextSegmentsForCard(
    resolvedReasoningText ? [resolvedReasoningText, resolvedText] : [resolvedText],
    tableLimit,
  );

  if (resolvedReasoningText) {
    return {
      reasoningText: sanitizedSegments[0],
      text: sanitizedSegments[1],
    };
  }

  return { text: sanitizedSegments[0] };
}

function extractApiDetail(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { response?: { data?: unknown } };
  return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}

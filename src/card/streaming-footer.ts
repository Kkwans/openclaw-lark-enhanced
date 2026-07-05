/**
 * Streaming footer state manager.
 *
 * Manages the real-time footer state during streaming, tracking elapsed time,
 * token counts, cache stats, and model info. Provides formatted footer content
 * for both streaming and terminal states.
 *
 * Design goals:
 * - Update footer at most 2x/sec to avoid Feishu API rate limits
 * - Gracefully handle missing metrics (show '-' for unavailable data)
 * - Support both CardKit streaming element updates and IM patch fallback
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FooterSessionMetrics } from './reply-dispatcher-types';
import { compactNumber, formatElapsed } from './builder';
import { getSessionStats, getDailyStats, getMonthlyStats, incrementSessionStats } from './session-stats';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Element ID for the footer in CardKit streaming cards. */
export const FOOTER_ELEMENT_ID = 'streaming_footer';

/** Maximum footer update frequency (ms between updates). */
const FOOTER_THROTTLE_MS = 500; // 2x/sec

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FooterState {
  /** Streaming start timestamp. */
  startTime: number;
  /** Last formatted footer content (cached for dedup). */
  lastContent: string;
  /** Last update timestamp. */
  lastUpdateTime: number;
  /** Whether footer has been initialized. */
  initialized: boolean;
}

export interface StreamingFooterConfig {
  /** Show status text (已完成/出错/已停止). */
  status?: boolean;
  /** Show elapsed time. */
  elapsed?: boolean;
  /** Show token counts. */
  tokens?: boolean;
  /** Show cache hit rate. */
  cache?: boolean;
  /** Show context window usage. */
  context?: boolean;
  /** Show model name. */
  model?: boolean;
  /** Show session cumulative stats. */
  sessionStats?: boolean;
  /** Show today stats. */
  dailyStats?: boolean;
  /** Show monthly stats. */
  monthlyStats?: boolean;
}

// ---------------------------------------------------------------------------
// Model context window fallback
// ---------------------------------------------------------------------------

let _modelContextCache: Record<string, number> | null = null;

/**
 * Load model context window from the local JSON file.
 * Cached after first read.
 */
function loadModelContextWindow(): Record<string, number> {
  if (_modelContextCache) return _modelContextCache;
  try {
    // Try workspace path first, then fallback to common locations
    const candidates = [
      resolve(process.env.HOME ?? '/root', '.openclaw/workspace/models-context-window.json'),
      '/root/.openclaw/workspace/models-context-window.json',
    ];
    for (const filePath of candidates) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const map: Record<string, number> = {};
        if (data.models && typeof data.models === 'object') {
          for (const [key, val] of Object.entries(data.models)) {
            if (val && typeof val === 'object' && typeof (val as Record<string, unknown>).contextWindow === 'number') {
              map[key] = (val as Record<string, unknown>).contextWindow as number;
            }
          }
        }
        _modelContextCache = map;
        return map;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  _modelContextCache = {};
  return {};
}

/**
 * Resolve context window for a model.
 * Tries exact match first, then prefix match (e.g. "mimo/mimo-v2.5-pro" matches "mimo/mimo-v2.5-pro").
 */
function resolveModelContextWindow(model?: string): number | undefined {
  if (!model) return undefined;
  const map = loadModelContextWindow();
  // Exact match
  if (map[model] != null) return map[model];
  // Prefix match (e.g. "mimo/mimo-v2.5-pro:some-variant" matches "mimo/mimo-v2.5-pro")
  const modelBase = model.split(':')[0];
  if (map[modelBase] != null) return map[modelBase];
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format token count with Chinese-friendly units. */
function formatTokenCount(count: number): string {
  if (count < 10000) return String(count);
  if (count < 100000000) return `${(count / 10000).toFixed(2)}w`;
  return `${(count / 100000000).toFixed(2)}亿`;
}

/** Format cache hit rate percentage (matches official formula). */
function formatCacheRate(read?: number, write?: number, input?: number): string {
  if (read == null || write == null || input == null) return '-';
  const total = read + write + input;
  if (total <= 0) return '-';
  const rate = Math.min(100, Math.round((read / total) * 100));
  return `${rate}%`;
}

// ---------------------------------------------------------------------------
// Footer Builder
// ---------------------------------------------------------------------------

export class StreamingFooter {
  private state: FooterState = {
    startTime: Date.now(),
    lastContent: '',
    lastUpdateTime: 0,
    initialized: false,
  };

  private config: StreamingFooterConfig;
  private sessionKey: string;

  private defaultModel?: string;

  constructor(config: StreamingFooterConfig, sessionKey: string) {
    this.config = config;
    this.sessionKey = sessionKey;
  }

  /** Set a fallback model name used when metrics don't include model info. */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /** Update the session key (e.g. when sessionId is resolved at runtime). */
  setSessionKey(sessionKey: string): void {
    this.sessionKey = sessionKey;
  }

  /** Initialize the footer (call once when streaming starts). */
  init(): void {
    if (this.state.initialized) return;
    this.state.startTime = Date.now();
    this.state.initialized = true;
  }

  /** Build formatted footer content for current state. */
  buildContent(metrics?: FooterSessionMetrics, isTerminal = false, isAborted = false): string {
    const lines: string[] = [];
    const { config } = this;

    // Session / daily / monthly stats — ONLY show in terminal state
    if (isTerminal && (config.sessionStats || config.dailyStats || config.monthlyStats)) {
      const session = getSessionStats(this.sessionKey);
      const daily = getDailyStats();
      const monthly = getMonthlyStats();
      // 总 token = input + output + cacheRead（与官方统计对齐）
      const totalTokens = (t: { inputTokens: number; outputTokens: number; cacheRead: number }) => t.inputTokens + t.outputTokens + t.cacheRead;
      const cacheRate = (t: { cacheRead: number; cacheWrite: number; inputTokens: number }) =>
        formatCacheRate(t.cacheRead, t.cacheWrite, t.inputTokens);

      if (config.sessionStats) {
        lines.push(`💬 会话 ${session.turns} 轮 · 🪙 ${formatTokenCount(totalTokens(session))} · ⚡ ${cacheRate(session)}`);
      }
      if (config.dailyStats) {
        lines.push(`📅 今日 ${daily.turns} 轮 · 🪙 ${formatTokenCount(totalTokens(daily))} · ⚡ ${cacheRate(daily)}`);
      }
      if (config.monthlyStats) {
        lines.push(`📆 本月 ${monthly.turns} 轮 · 🪙 ${formatTokenCount(totalTokens(monthly))} · ⚡ ${cacheRate(monthly)}`);
      }
      lines.push('──────────────────────');
    }

    // Streaming footer: single line with elapsed + model + context
    // Terminal footer: two lines (detail + status/elapsed/model)
    const detailParts: string[] = [];
    if (isTerminal) {
      // Terminal: detail line with tokens + cache + context
      if (config.tokens) {
        if (metrics) {
          // 输入 = inputTokens + cacheRead（与官方统计对齐，prompt_tokens 包含缓存命中）
          const input = (metrics.inputTokens ?? 0) + (metrics.cacheRead ?? 0);
          const output = metrics.outputTokens ?? 0;
          if (input > 0 || output > 0) {
            detailParts.push(`🪙 ${formatTokenCount(input)}+${formatTokenCount(output)}`);
          } else {
            detailParts.push('🪙 -');
          }
        } else {
          detailParts.push('🪙 -');
        }
      }
      if (config.cache) {
        if (metrics) {
          const read = metrics.cacheRead ?? 0;
          const write = metrics.cacheWrite ?? 0;
          const input = metrics.inputTokens ?? 0;
          if (read > 0 || write > 0 || input > 0) {
            detailParts.push(`⚡ ${formatCacheRate(read, write, input)}`);
          } else {
            detailParts.push('⚡ -');
          }
        } else {
          detailParts.push('⚡ -');
        }
      }
      if (config.context) {
        const used = metrics?.totalTokens ?? 0;
        // maxCtx: 优先 session store，fallback 到本地模型上下文容量
        let maxCtx = metrics?.contextTokens ?? 0;
        if (maxCtx <= 0) {
          maxCtx = resolveModelContextWindow(metrics?.model ?? this.defaultModel) ?? 0;
        }
        if (used > 0 || maxCtx > 0) {
          if (used > 0 && maxCtx > 0) {
            const pct = Math.round((used / maxCtx) * 100);
            detailParts.push(`🧠 ${compactNumber(used)}/${compactNumber(maxCtx)} (${pct}%)`);
          } else if (maxCtx > 0) {
            detailParts.push(`🧠 ${compactNumber(maxCtx)}`);
          } else {
            detailParts.push(`🧠 ${compactNumber(used)}`);
          }
        } else {
          detailParts.push('🧠 -');
        }
      }
      if (detailParts.length > 0) {
        lines.push(detailParts.join(' · '));
      }
    }

    // Status + elapsed + model (terminal: separate line; streaming: single line with context)
    const primaryParts: string[] = [];
    if (isTerminal) {
      // Terminal: status text
      if (config.status) {
        if (isAborted) {
          primaryParts.push('⏹️ 已停止');
        } else {
          primaryParts.push('✅ 已完成');
        }
      }
    }
    if (config.elapsed) {
      const elapsed = Date.now() - this.state.startTime;
      primaryParts.push(`⏱️ ${formatElapsed(elapsed)}`);
    }
    const resolvedModel = metrics?.model ?? this.defaultModel;
    if (config.model && resolvedModel) {
      primaryParts.push(`🤖 ${resolvedModel}`);
    }
    // Streaming: append context to the same line
    if (!isTerminal && config.context) {
      const used = metrics?.totalTokens ?? 0;
      // maxCtx: 优先 session store，fallback 到本地模型上下文容量
      let maxCtx = metrics?.contextTokens ?? 0;
      if (maxCtx <= 0) {
        maxCtx = resolveModelContextWindow(resolvedModel) ?? 0;
      }
      if (used > 0 || maxCtx > 0) {
        if (used > 0 && maxCtx > 0) {
          const pct = Math.round((used / maxCtx) * 100);
          primaryParts.push(`🧠 ${compactNumber(used)}/${compactNumber(maxCtx)} (${pct}%)`);
        } else if (maxCtx > 0) {
          primaryParts.push(`🧠 ${compactNumber(maxCtx)}`);
        } else {
          primaryParts.push(`🧠 ${compactNumber(used)}`);
        }
      } else {
        primaryParts.push('🧠 -');
      }
    }
    if (primaryParts.length > 0) {
      lines.push(primaryParts.join(' · '));
    }

    const content = lines.join('\n');
    this.state.lastContent = content;
    return content;
  }

  /** Check if enough time has passed since last update. */
  shouldUpdate(): boolean {
    const now = Date.now();
    if (now - this.state.lastUpdateTime < FOOTER_THROTTLE_MS) return false;
    this.state.lastUpdateTime = now;
    return true;
  }

  /** Get the last built footer content (for reuse when shouldUpdate() is false). */
  getLastContent(): string {
    return this.state.lastContent;
  }

  /** Record stats when a turn completes. */
  recordTurnCompletion(metrics?: FooterSessionMetrics): void {
    if (!metrics) return;
    incrementSessionStats(this.sessionKey, {
      input: metrics.inputTokens,
      output: metrics.outputTokens,
      cacheRead: metrics.cacheRead,
      cacheWrite: metrics.cacheWrite,
    });
  }

  /** Reset state for a new streaming session. */
  reset(): void {
    this.state = {
      startTime: Date.now(),
      lastContent: '',
      lastUpdateTime: 0,
      initialized: false,
    };
  }
}

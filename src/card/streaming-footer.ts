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

  constructor(config: StreamingFooterConfig, sessionKey: string) {
    this.config = config;
    this.sessionKey = sessionKey;
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
      const totalTokens = (t: { inputTokens: number; outputTokens: number }) => t.inputTokens + t.outputTokens;
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

    // Detail line: tokens + cache + context
    // During streaming, token counts and cache rate are unavailable (lastUsage
    // is only populated after the LLM response completes). Skip them to avoid
    // showing misleading "-" placeholders. Context and model are still shown.
    const detailParts: string[] = [];
    if (isTerminal) {
      if (config.tokens) {
        if (metrics) {
          const input = metrics.inputTokens ?? 0;
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
    }
    if (config.context) {
      if (metrics) {
        const used = metrics.totalTokens ?? 0;
        const maxCtx = metrics.contextTokens ?? 0;
        if (used > 0) {
          if (maxCtx > 0) {
            const pct = Math.round((used / maxCtx) * 100);
            detailParts.push(`🧠 ${compactNumber(used)}/${compactNumber(maxCtx)} (${pct}%)`);
          } else {
            detailParts.push(`🧠 ${compactNumber(used)}`);
          }
        } else {
          detailParts.push('🧠 -');
        }
      } else {
        detailParts.push('🧠 -');
      }
    }
    if (detailParts.length > 0) {
      lines.push(detailParts.join(' · '));
    }

    // Status + elapsed + model
    const primaryParts: string[] = [];
    if (config.status) {
      if (isAborted) {
        primaryParts.push('⏹️ 已停止');
      } else if (isTerminal) {
        primaryParts.push('✅ 已完成');
      } else {
        primaryParts.push('⏳ 生成中');
      }
    }
    if (config.elapsed) {
      const elapsed = Date.now() - this.state.startTime;
      primaryParts.push(`⏱️ ${formatElapsed(elapsed)}`);
    }
    if (config.model && metrics?.model) {
      primaryParts.push(`🤖 ${metrics.model}`);
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

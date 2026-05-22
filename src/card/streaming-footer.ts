/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
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
import { sessionStatsStore } from './session-stats';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Element ID for the footer in CardKit streaming cards. */
export const FOOTER_ELEMENT_ID = 'streaming_footer';

/** Maximum footer update frequency (ms between updates). */
const FOOTER_THROTTLE_MS = 500; // 2x/sec

/** Animation frames for streaming status (spinning dot). */
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Get the current animation frame based on elapsed time. */
function getSpinFrame(elapsedMs: number): string {
  const index = Math.floor(elapsedMs / 300) % SPIN_FRAMES.length;
  return SPIN_FRAMES[index];
}

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
  /** Show cache stats. */
  cache?: boolean;
  /** Show context usage. */
  context?: boolean;
  /** Show model name. */
  model?: boolean;
  /** Show session cumulative stats. */
  sessionStats?: boolean;
  /** Show daily aggregated stats. */
  dailyStats?: boolean;
  /** Show monthly aggregated stats. */
  monthlyStats?: boolean;
}

// ---------------------------------------------------------------------------
// StreamingFooterManager
// ---------------------------------------------------------------------------

export class StreamingFooterManager {
  private state: FooterState;
  private readonly config: Required<StreamingFooterConfig>;
  private readonly sessionKey: string | undefined;

  constructor(config?: StreamingFooterConfig, sessionKey?: string) {
    this.config = {
      status: config?.status ?? false,
      elapsed: config?.elapsed ?? false,
      tokens: config?.tokens ?? false,
      cache: config?.cache ?? false,
      context: config?.context ?? false,
      model: config?.model ?? false,
      sessionStats: config?.sessionStats ?? false,
      dailyStats: config?.dailyStats ?? false,
      monthlyStats: config?.monthlyStats ?? false,
    };
    this.sessionKey = sessionKey;
    this.state = {
      startTime: Date.now(),
      lastContent: '',
      lastUpdateTime: 0,
      initialized: false,
    };
  }

  /** Whether any footer display is enabled. */
  get isEnabled(): boolean {
    return Object.values(this.config).some(Boolean);
  }

  /** Get the session key for this footer manager. */
  get getSessionKey(): string | undefined {
    return this.sessionKey;
  }

  /** Initialize or reset the footer timer. */
  init(): void {
    this.state.startTime = Date.now();
    this.state.initialized = true;
    this.state.lastContent = '';
    this.state.lastUpdateTime = 0;
  }

  /** Check if enough time has passed for a new update. */
  canUpdate(): boolean {
    if (!this.state.initialized) return false;
    const now = Date.now();
    return now - this.state.lastUpdateTime >= FOOTER_THROTTLE_MS;
  }

  /**
   * Build the streaming footer content from current metrics.
   * Returns null if no update is needed or footer is disabled.
   *
   * @param metrics - Current session metrics (may be undefined during early streaming)
   * @returns Formatted footer markdown, or null if no update needed
   */
  buildStreamingFooter(metrics?: FooterSessionMetrics): string | null {
    if (!this.isEnabled) return null;

    const now = Date.now();
    const elapsedMs = now - this.state.startTime;

    const content = this.formatFooter(elapsedMs, metrics, 'streaming');

    // Dedup: skip if content hasn't changed
    if (content === this.state.lastContent) return null;

    this.state.lastContent = content;
    this.state.lastUpdateTime = now;
    return content;
  }

  /**
   * Build the terminal footer content (for final card state).
   * Same as streaming but with final elapsed time.
   */
  buildTerminalFooter(
    elapsedMs: number,
    metrics?: FooterSessionMetrics,
    reason: 'normal' | 'error' | 'abort' = 'normal',
  ): string | null {
    if (!this.isEnabled) return null;
    return this.formatFooter(elapsedMs, metrics, reason);
  }

  // ---------------------------------------------------------------------------
  // Internal formatting
  // ---------------------------------------------------------------------------

  private formatFooter(
    elapsedMs: number,
    metrics: FooterSessionMetrics | undefined,
    state: 'streaming' | 'normal' | 'error' | 'abort',
  ): string {
    const lines: string[] = [];

    // --- Layout: stats on top, status on bottom (per user spec) ---

    // Section 1: 会话 · 今日 · 本月 (with separator)
    const statLines: string[] = [];

    if (this.config.sessionStats && this.sessionKey) {
      const sessionSummary = sessionStatsStore.getSummary(this.sessionKey);
      if (sessionSummary) statLines.push(sessionSummary.formatted);
    }
    if (this.config.dailyStats) {
      const dailySummary = sessionStatsStore.getDailySummary();
      if (dailySummary) statLines.push(dailySummary.formatted);
    }
    if (this.config.monthlyStats) {
      const monthlySummary = sessionStatsStore.getMonthlySummary();
      if (monthlySummary) statLines.push(monthlySummary.formatted);
    }

    if (statLines.length > 0) {
      lines.push(...statLines);
      lines.push('---');
    }

    // Section 2: Token · 缓存 · 上下文 (one line)
    const detail: string[] = [];

    if (this.config.tokens && metrics) {
      const inTokens = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : 0;
      const outTokens = typeof metrics.outputTokens === 'number' ? Math.max(0, metrics.outputTokens) : 0;
      const total = inTokens + outTokens;
      if (total > 0) {
        detail.push(`🪙 ${compactNumber(total)}`);
      }
    }

    if (this.config.cache && metrics) {
      const read = typeof metrics.cacheRead === 'number' ? Math.max(0, metrics.cacheRead) : undefined;
      const write = typeof metrics.cacheWrite === 'number' ? Math.max(0, metrics.cacheWrite) : undefined;
      const inputVal = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : undefined;
      if (read != null && write != null && inputVal != null) {
        const total = read + write + inputVal;
        const hit = total > 0 ? Math.round((read / total) * 100) : 0;
        detail.push(`⚡ ${hit}%`);
      }
    }

    if (this.config.context && metrics) {
      const freshTotal = metrics.totalTokensFresh === false ? undefined : metrics.totalTokens;
      const used = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined;
      const limit = typeof metrics.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined;
      if (used != null && limit != null && limit > 0) {
        const pct = Math.round((used / limit) * 100);
        detail.push(`🧠 ${compactNumber(used)}/${compactNumber(limit)} (${pct}%)`);
      }
    }

    if (detail.length > 0) {
      lines.push(detail.join(' · '));
    }

    // Section 3: status · 耗时 · 模型
    const primary: string[] = [];

    if (this.config.status) {
      if (state === 'streaming') {
        const spin = getSpinFrame(elapsedMs);
        primary.push(`${spin} 生成中`);
      } else if (state === 'error') {
        primary.push('❌ 出错');
      } else if (state === 'abort') {
        primary.push('⏸️ 已停止');
      } else {
        primary.push('✅ 已完成');
      }
    }

    if (this.config.elapsed) {
      primary.push(`⏱️ ${formatElapsed(elapsedMs)}`);
    }

    if (this.config.model && metrics?.model) {
      const model = metrics.model.trim();
      if (model) primary.push(`🤖 ${model}`);
    }

    if (primary.length > 0) {
      lines.push(primary.join(' · '));
    }

    if (lines.length === 0) return '';
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Footer element builder for CardKit 2.0
// ---------------------------------------------------------------------------

/**
 * Build a CardKit 2.0 footer element for streaming mode.
 * This element can be targeted by cardElement.content() for live updates.
 */
export function buildFooterElement(content: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: content || ' ',
    text_size: 'notation',
    text_align: 'center',
    element_id: FOOTER_ELEMENT_ID,
  };
}

/**
 * Build a divider element (used before the footer).
 */
export function buildDividerElement(): Record<string, unknown> {
  return { tag: 'hr' };
}

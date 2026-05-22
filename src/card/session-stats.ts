/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Session-level cumulative statistics.
 *
 * Tracks total token consumption, cache hit ratios, and turn counts
 * across a session (multiple request/response cycles). Also tracks
 * daily and monthly aggregated stats globally.
 *
 * Design goals:
 * - Lightweight in-memory store (no disk I/O)
 * - Accumulate per-turn metrics into session totals
 * - Provide formatted session stats for footer display
 * - Track daily/monthly token consumption across all sessions
 * - Auto-expire stale sessions after 2 hours of inactivity
 * - Auto-expire daily stats after 7 days, monthly stats after 13 months
 */

import type { FooterSessionMetrics } from './reply-dispatcher-types';
import { compactNumber } from './builder';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session stats expiry: 2 hours of inactivity. */
const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000;

/** Daily stats retention: 7 days. */
const DAILY_STATS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Monthly stats retention: 13 months (approx 400 days). */
const MONTHLY_STATS_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Cleanup interval: every 10 minutes. */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCumulativeStats {
  /** Total input tokens across all turns. */
  totalInputTokens: number;
  /** Total output tokens across all turns. */
  totalOutputTokens: number;
  /** Total cache read tokens. */
  totalCacheRead: number;
  /** Total cache write tokens. */
  totalCacheWrite: number;
  /** Number of turns in this session. */
  turnCount: number;
  /** Last activity timestamp (ms). */
  lastActivity: number;
  /** Session start timestamp (ms). */
  startTime: number;
}

/** Aggregated stats for a time period (day or month). */
export interface PeriodStats {
  /** Total input tokens. */
  totalInputTokens: number;
  /** Total output tokens. */
  totalOutputTokens: number;
  /** Total cache read tokens. */
  totalCacheRead: number;
  /** Total cache write tokens. */
  totalCacheWrite: number;
  /** Number of turns. */
  turnCount: number;
  /** Last activity timestamp (ms). */
  lastActivity: number;
}

export interface SessionStatsSummary {
  /** Total tokens (input + output). */
  totalTokens: number;
  /** Cache hit ratio (0-100). */
  cacheHitPercent: number;
  /** Number of turns. */
  turnCount: number;
  /** Formatted line for footer display. */
  formatted: string;
}

export interface PeriodStatsSummary {
  /** Total tokens (input + output). */
  totalTokens: number;
  /** Formatted line for footer display. */
  formatted: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the date key for today (YYYY-MM-DD in local timezone). */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Get the month key for current month (YYYY-MM). */
function thisMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// SessionStatsStore
// ---------------------------------------------------------------------------

class SessionStatsStore {
  private readonly store = new Map<string, SessionCumulativeStats>();
  /** Daily aggregated stats keyed by "YYYY-MM-DD". */
  private readonly dailyStore = new Map<string, PeriodStats>();
  /** Monthly aggregated stats keyed by "YYYY-MM". */
  private readonly monthlyStore = new Map<string, PeriodStats>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is active.
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Accumulate a turn's metrics into the session totals,
   * and also into daily/monthly aggregated stats.
   *
   * @param sessionKey - The session identifier
   * @param metrics - Per-turn metrics from FooterSessionMetrics
   */
  accumulate(sessionKey: string, metrics: FooterSessionMetrics): void {
    const key = sessionKey.trim().toLowerCase();
    const now = Date.now();

    // --- Session accumulation ---
    let entry = this.store.get(key);
    if (!entry) {
      entry = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        turnCount: 0,
        lastActivity: now,
        startTime: now,
      };
      this.store.set(key, entry);
    }

    const inputTokens = typeof metrics.inputTokens === 'number' && metrics.inputTokens > 0 ? metrics.inputTokens : 0;
    const outputTokens = typeof metrics.outputTokens === 'number' && metrics.outputTokens > 0 ? metrics.outputTokens : 0;
    const cacheRead = typeof metrics.cacheRead === 'number' && metrics.cacheRead > 0 ? metrics.cacheRead : 0;
    const cacheWrite = typeof metrics.cacheWrite === 'number' && metrics.cacheWrite > 0 ? metrics.cacheWrite : 0;

    entry.totalInputTokens += inputTokens;
    entry.totalOutputTokens += outputTokens;
    entry.totalCacheRead += cacheRead;
    entry.totalCacheWrite += cacheWrite;
    entry.turnCount += 1;
    entry.lastActivity = now;

    // --- Daily accumulation ---
    const dayKey = todayKey();
    let dailyEntry = this.dailyStore.get(dayKey);
    if (!dailyEntry) {
      dailyEntry = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        turnCount: 0,
        lastActivity: now,
      };
      this.dailyStore.set(dayKey, dailyEntry);
    }
    dailyEntry.totalInputTokens += inputTokens;
    dailyEntry.totalOutputTokens += outputTokens;
    dailyEntry.totalCacheRead += cacheRead;
    dailyEntry.totalCacheWrite += cacheWrite;
    dailyEntry.turnCount += 1;
    dailyEntry.lastActivity = now;

    // --- Monthly accumulation ---
    const monthKey = thisMonthKey();
    let monthlyEntry = this.monthlyStore.get(monthKey);
    if (!monthlyEntry) {
      monthlyEntry = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        turnCount: 0,
        lastActivity: now,
      };
      this.monthlyStore.set(monthKey, monthlyEntry);
    }
    monthlyEntry.totalInputTokens += inputTokens;
    monthlyEntry.totalOutputTokens += outputTokens;
    monthlyEntry.totalCacheRead += cacheRead;
    monthlyEntry.totalCacheWrite += cacheWrite;
    monthlyEntry.turnCount += 1;
    monthlyEntry.lastActivity = now;
  }

  /**
   * Get a summary of the session's cumulative stats.
   *
   * @param sessionKey - The session identifier
   * @returns Summary object, or undefined if no stats exist
   */
  getSummary(sessionKey: string): SessionStatsSummary | undefined {
    const key = sessionKey.trim().toLowerCase();
    const entry = this.store.get(key);
    if (!entry || entry.turnCount === 0) return undefined;

    const totalTokens = entry.totalInputTokens + entry.totalOutputTokens;

    // Cache hit = cacheRead / (cacheRead + cacheWrite + inputTokens)
    // This mirrors the per-turn formula in streaming-footer.ts
    const cacheBase = entry.totalCacheRead + entry.totalCacheWrite + entry.totalInputTokens;
    const cacheHitPercent = cacheBase > 0 ? Math.round((entry.totalCacheRead / cacheBase) * 100) : 0;

    const formatted = this.formatSessionLine(totalTokens, cacheHitPercent, entry.turnCount);

    return {
      totalTokens,
      cacheHitPercent,
      turnCount: entry.turnCount,
      formatted,
    };
  }

  /**
   * Get today's aggregated stats.
   */
  getDailySummary(): PeriodStatsSummary | undefined {
    const entry = this.dailyStore.get(todayKey());
    if (!entry || entry.turnCount === 0) return undefined;

    const totalTokens = entry.totalInputTokens + entry.totalOutputTokens;
    const cacheBase = entry.totalCacheRead + entry.totalCacheWrite + entry.totalInputTokens;
    const cacheHitPercent = cacheBase > 0 ? Math.round((entry.totalCacheRead / cacheBase) * 100) : 0;

    let formatted = `📅 今日 ${String(entry.turnCount + " 轮").padStart(4)} · 🪙 ${compactNumber(totalTokens).padStart(6)}`;
    if (cacheHitPercent > 0) {
      formatted += ` · ⚡ ${String(cacheHitPercent).padStart(3)}%`;
    }

    return { totalTokens, formatted };
  }

  /**
   * Get this month's aggregated stats.
   */
  getMonthlySummary(): PeriodStatsSummary | undefined {
    const entry = this.monthlyStore.get(thisMonthKey());
    if (!entry || entry.turnCount === 0) return undefined;

    const totalTokens = entry.totalInputTokens + entry.totalOutputTokens;
    const cacheBase = entry.totalCacheRead + entry.totalCacheWrite + entry.totalInputTokens;
    const cacheHitPercent = cacheBase > 0 ? Math.round((entry.totalCacheRead / cacheBase) * 100) : 0;

    let formatted = `📆 本月 ${String(entry.turnCount + " 轮").padStart(4)} · 🪙 ${compactNumber(totalTokens).padStart(6)}`;
    if (cacheHitPercent > 0) {
      formatted += ` · ⚡ ${String(cacheHitPercent).padStart(3)}%`;
    }

    return { totalTokens, formatted };
  }

  /**
   * Get raw cumulative stats for a session.
   */
  getRaw(sessionKey: string): SessionCumulativeStats | undefined {
    return this.store.get(sessionKey.trim().toLowerCase());
  }

  /**
   * Clear stats for a specific session.
   */
  clear(sessionKey: string): void {
    this.store.delete(sessionKey.trim().toLowerCase());
  }

  /**
   * Clear all stats.
   */
  clearAll(): void {
    this.store.clear();
    this.dailyStore.clear();
    this.monthlyStore.clear();
  }

  /**
   * Format the session stats line for footer display.
   *
   * Example: 💬 会话 15.2k tokens (3 轮) | ⚡ 缓存命中 38%
   */
  private formatSessionLine(
    totalTokens: number,
    cacheHitPercent: number,
    turnCount: number,
  ): string {
    const parts: string[] = [];

    const tokenLabel = compactNumber(totalTokens);
    const turnLabel = `${turnCount} 轮`;
    parts.push(`💬 会话 ${turnLabel.padStart(4)} · 🪙 ${tokenLabel.padStart(6)}`);

    if (cacheHitPercent > 0) {
      parts.push(`⚡ ${String(cacheHitPercent).padStart(3)}%`);
    }

    return parts.join(' · ');
  }

  /**
   * Remove expired sessions, daily stats older than 7 days,
   * and monthly stats older than 13 months.
   */
  private cleanup(): void {
    const now = Date.now();

    // Session cleanup
    for (const [key, entry] of this.store) {
      if (now - entry.lastActivity > SESSION_EXPIRY_MS) {
        this.store.delete(key);
      }
    }

    // Daily stats cleanup (keep last 7 days)
    for (const [key, entry] of this.dailyStore) {
      if (now - entry.lastActivity > DAILY_STATS_RETENTION_MS) {
        this.dailyStore.delete(key);
      }
    }

    // Monthly stats cleanup (keep last 13 months)
    for (const [key, entry] of this.monthlyStore) {
      if (now - entry.lastActivity > MONTHLY_STATS_RETENTION_MS) {
        this.monthlyStore.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const sessionStatsStore = new SessionStatsStore();

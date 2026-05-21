/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Session-level cumulative statistics.
 *
 * Tracks total token consumption, cache hit ratios, and turn counts
 * across a session (multiple request/response cycles). Stats are kept
 * in-memory and keyed by session key.
 *
 * Design goals:
 * - Lightweight in-memory store (no disk I/O)
 * - Accumulate per-turn metrics into session totals
 * - Provide formatted session stats for footer display
 * - Auto-expire stale sessions after 2 hours of inactivity
 */

import type { FooterSessionMetrics } from './reply-dispatcher-types';
import { compactNumber } from './builder';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session stats expiry: 2 hours of inactivity. */
const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// SessionStatsStore
// ---------------------------------------------------------------------------

class SessionStatsStore {
  private readonly store = new Map<string, SessionCumulativeStats>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is active.
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Accumulate a turn's metrics into the session totals.
   *
   * @param sessionKey - The session identifier
   * @param metrics - Per-turn metrics from FooterSessionMetrics
   */
  accumulate(sessionKey: string, metrics: FooterSessionMetrics): void {
    const key = sessionKey.trim().toLowerCase();
    const now = Date.now();

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

    // Accumulate tokens (guard against undefined/negative)
    if (typeof metrics.inputTokens === 'number' && metrics.inputTokens > 0) {
      entry.totalInputTokens += metrics.inputTokens;
    }
    if (typeof metrics.outputTokens === 'number' && metrics.outputTokens > 0) {
      entry.totalOutputTokens += metrics.outputTokens;
    }
    if (typeof metrics.cacheRead === 'number' && metrics.cacheRead > 0) {
      entry.totalCacheRead += metrics.cacheRead;
    }
    if (typeof metrics.cacheWrite === 'number' && metrics.cacheWrite > 0) {
      entry.totalCacheWrite += metrics.cacheWrite;
    }

    entry.turnCount += 1;
    entry.lastActivity = now;
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
  }

  /**
   * Format the session stats line for footer display.
   *
   * Example: 📈 会话: 15.2k tokens (3 轮) | 🔄 38% cache
   */
  private formatSessionLine(
    totalTokens: number,
    cacheHitPercent: number,
    turnCount: number,
  ): string {
    const parts: string[] = [];

    const tokenLabel = compactNumber(totalTokens);
    const turnLabel = `${turnCount} 轮`;
    parts.push(`📈 会话: ${tokenLabel} tokens (${turnLabel})`);

    if (cacheHitPercent > 0) {
      parts.push(`🔄 ${cacheHitPercent}% cache`);
    }

    return parts.join(' | ');
  }

  /**
   * Remove expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.lastActivity > SESSION_EXPIRY_MS) {
        this.store.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const sessionStatsStore = new SessionStatsStore();

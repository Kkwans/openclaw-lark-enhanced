/**
 * Tests for session-stats.ts — Session-level cumulative statistics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStatsStore } from '../src/card/session-stats';

describe('SessionStatsStore', () => {
  const testKey = 'test-session-1';

  beforeEach(() => {
    sessionStatsStore.clearAll();
  });

  describe('accumulate()', () => {
    it('should accumulate basic token metrics', () => {
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 1000,
        outputTokens: 500,
      });

      const raw = sessionStatsStore.getRaw(testKey);
      expect(raw).toBeDefined();
      expect(raw!.totalInputTokens).toBe(1000);
      expect(raw!.totalOutputTokens).toBe(500);
      expect(raw!.turnCount).toBe(1);
    });

    it('should accumulate across multiple turns', () => {
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 200,
        cacheWrite: 100,
      });
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 800,
        outputTokens: 300,
        cacheRead: 400,
        cacheWrite: 50,
      });

      const raw = sessionStatsStore.getRaw(testKey);
      expect(raw!.totalInputTokens).toBe(1800);
      expect(raw!.totalOutputTokens).toBe(800);
      expect(raw!.totalCacheRead).toBe(600);
      expect(raw!.totalCacheWrite).toBe(150);
      expect(raw!.turnCount).toBe(2);
    });

    it('should ignore undefined and negative values', () => {
      sessionStatsStore.accumulate(testKey, {
        inputTokens: -100,
        outputTokens: undefined,
        cacheRead: 0,
        cacheWrite: -50,
      });

      const raw = sessionStatsStore.getRaw(testKey);
      expect(raw!.totalInputTokens).toBe(0);
      expect(raw!.totalOutputTokens).toBe(0);
      expect(raw!.totalCacheRead).toBe(0);
      expect(raw!.totalCacheWrite).toBe(0);
    });

    it('should handle multiple sessions independently', () => {
      sessionStatsStore.accumulate('session-a', { inputTokens: 1000, outputTokens: 500 });
      sessionStatsStore.accumulate('session-b', { inputTokens: 2000, outputTokens: 800 });

      const rawA = sessionStatsStore.getRaw('session-a');
      const rawB = sessionStatsStore.getRaw('session-b');
      expect(rawA!.totalInputTokens).toBe(1000);
      expect(rawB!.totalInputTokens).toBe(2000);
    });
  });

  describe('getSummary()', () => {
    it('should return undefined for unknown session', () => {
      expect(sessionStatsStore.getSummary('nonexistent')).toBeUndefined();
    });

    it('should calculate cache hit percent correctly', () => {
      // cacheRead=400, cacheWrite=100, inputTokens=500 → base=1000 → 40%
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 500,
        outputTokens: 200,
        cacheRead: 400,
        cacheWrite: 100,
      });

      const summary = sessionStatsStore.getSummary(testKey);
      expect(summary).toBeDefined();
      expect(summary!.totalTokens).toBe(700); // 500 + 200
      expect(summary!.cacheHitPercent).toBe(40); // 400/1000
      expect(summary!.turnCount).toBe(1);
    });

    it('should produce formatted line with emoji', () => {
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 15000,
        outputTokens: 5000,
        cacheRead: 6000,
        cacheWrite: 2000,
      });

      const summary = sessionStatsStore.getSummary(testKey);
      expect(summary!.formatted).toContain('📈 会话:');
      expect(summary!.formatted).toContain('cache');
    });

    it('should handle zero cache gracefully', () => {
      sessionStatsStore.accumulate(testKey, {
        inputTokens: 1000,
        outputTokens: 500,
      });

      const summary = sessionStatsStore.getSummary(testKey);
      expect(summary!.cacheHitPercent).toBe(0);
      // When cache is 0%, the cache part should not appear
      expect(summary!.formatted).not.toContain('cache');
    });
  });

  describe('clear()', () => {
    it('should clear a specific session', () => {
      sessionStatsStore.accumulate(testKey, { inputTokens: 1000 });
      sessionStatsStore.clear(testKey);
      expect(sessionStatsStore.getRaw(testKey)).toBeUndefined();
    });
  });

  describe('session key normalization', () => {
    it('should normalize keys (trim + lowercase)', () => {
      sessionStatsStore.accumulate('  Session-A  ', { inputTokens: 1000 });
      sessionStatsStore.accumulate('session-a', { inputTokens: 500 });

      const raw = sessionStatsStore.getRaw('SESSION-A');
      expect(raw!.totalInputTokens).toBe(1500);
      expect(raw!.turnCount).toBe(2);
    });
  });
});

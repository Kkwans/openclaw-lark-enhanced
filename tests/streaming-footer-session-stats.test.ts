/**
 * Tests for StreamingFooterManager with session stats integration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingFooterManager } from '../src/card/streaming-footer';
import { sessionStatsStore } from '../src/card/session-stats';

describe('StreamingFooterManager with sessionStats', () => {
  const testKey = 'test-session-footer';

  beforeEach(() => {
    sessionStatsStore.clearAll();
  });

  it('should include session stats line when sessionStats is enabled', () => {
    // Pre-populate session stats
    sessionStatsStore.accumulate(testKey, {
      inputTokens: 15000,
      outputTokens: 5000,
      cacheRead: 6000,
      cacheWrite: 2000,
    });

    const manager = new StreamingFooterManager(
      { sessionStats: true, tokens: true, elapsed: true, status: true },
      testKey,
    );
    manager.init();

    const content = manager.buildStreamingFooter({
      inputTokens: 5000,
      outputTokens: 2000,
    });

    expect(content).not.toBeNull();
    expect(content!).toContain('📈 会话:');
    expect(content!).toContain('cache');
  });

  it('should not include session stats when sessionStats is disabled', () => {
    sessionStatsStore.accumulate(testKey, {
      inputTokens: 15000,
      outputTokens: 5000,
    });

    const manager = new StreamingFooterManager(
      { sessionStats: false, tokens: true, elapsed: true },
      testKey,
    );
    manager.init();

    const content = manager.buildStreamingFooter({
      inputTokens: 5000,
      outputTokens: 2000,
    });

    expect(content).not.toBeNull();
    expect(content!).not.toContain('📈 会话:');
  });

  it('should not include session stats when sessionKey is not provided', () => {
    sessionStatsStore.accumulate(testKey, {
      inputTokens: 15000,
      outputTokens: 5000,
    });

    const manager = new StreamingFooterManager(
      { sessionStats: true, tokens: true },
      undefined, // no sessionKey
    );
    manager.init();

    const content = manager.buildStreamingFooter({
      inputTokens: 5000,
      outputTokens: 2000,
    });

    // Should still render tokens but no session line
    if (content) {
      expect(content).not.toContain('📈 会话:');
    }
  });

  it('should include session stats in terminal footer', () => {
    sessionStatsStore.accumulate(testKey, {
      inputTokens: 10000,
      outputTokens: 3000,
      cacheRead: 4000,
      cacheWrite: 1000,
    });

    const manager = new StreamingFooterManager(
      { sessionStats: true, status: true },
      testKey,
    );

    const content = manager.buildTerminalFooter(5000, {
      inputTokens: 10000,
      outputTokens: 3000,
    }, 'normal');

    expect(content).not.toBeNull();
    expect(content!).toContain('✅ 已完成');
    expect(content!).toContain('📈 会话:');
  });

  it('should expose sessionKey via getter', () => {
    const manager = new StreamingFooterManager({}, 'my-session');
    expect(manager.getSessionKey).toBe('my-session');

    const managerNoKey = new StreamingFooterManager({});
    expect(managerNoKey.getSessionKey).toBeUndefined();
  });
});

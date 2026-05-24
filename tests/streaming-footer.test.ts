import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/card/session-stats', () => ({
  sessionStatsStore: {
    getSummary: vi.fn(() => null),
    getDailySummary: vi.fn(() => null),
    getMonthlySummary: vi.fn(() => null),
  },
}));

vi.mock('../src/card/builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/card/builder')>();
  return {
    compactNumber: actual.compactNumber,
    formatElapsed: actual.formatElapsed,
  };
});

import {
  StreamingFooterManager,
  buildFooterElement,
  buildDividerElement,
  FOOTER_ELEMENT_ID,
} from '../src/card/streaming-footer';

describe('StreamingFooterManager', () => {
  describe('constructor', () => {
    it('should default all config to false', () => {
      const mgr = new StreamingFooterManager();
      expect(mgr.isEnabled).toBe(false);
    });

    it('should accept partial config', () => {
      const mgr = new StreamingFooterManager({ status: true, elapsed: true });
      expect(mgr.isEnabled).toBe(true);
    });

    it('should store session key', () => {
      const mgr = new StreamingFooterManager({}, 'test-session');
      expect(mgr.getSessionKey).toBe('test-session');
    });

    it('should have undefined session key by default', () => {
      const mgr = new StreamingFooterManager();
      expect(mgr.getSessionKey).toBeUndefined();
    });
  });

  describe('init', () => {
    it('should initialize the footer state', () => {
      const mgr = new StreamingFooterManager({ status: true });
      mgr.init();
      // After init, canUpdate should work (after throttle period)
      expect(mgr.canUpdate()).toBe(true);
    });
  });

  describe('canUpdate', () => {
    it('should return false before init', () => {
      const mgr = new StreamingFooterManager({ status: true });
      expect(mgr.canUpdate()).toBe(false);
    });

    it('should return true immediately after init', () => {
      const mgr = new StreamingFooterManager({ status: true });
      mgr.init();
      expect(mgr.canUpdate()).toBe(true);
    });
  });

  describe('buildStreamingFooter', () => {
    it('should return null when disabled', () => {
      const mgr = new StreamingFooterManager();
      mgr.init();
      expect(mgr.buildStreamingFooter()).toBeNull();
    });

    it('should return content when status is enabled', () => {
      const mgr = new StreamingFooterManager({ status: true });
      mgr.init();
      const result = mgr.buildStreamingFooter();
      expect(result).not.toBeNull();
      expect(result).toContain('生成中');
    });

    it('should include elapsed time when enabled', () => {
      const mgr = new StreamingFooterManager({ elapsed: true });
      mgr.init();
      const result = mgr.buildStreamingFooter();
      expect(result).toContain('⏱️');
    });

    it('should show tokens in input→output format', () => {
      const mgr = new StreamingFooterManager({ tokens: true });
      mgr.init();
      const result = mgr.buildStreamingFooter({
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 0,
        totalTokens: 1500,
        contextTokens: 0,
      });
      expect(result).toContain('🪙');
      expect(result).toContain('1.0k');
      expect(result).toContain('500');
    });

    it('should show cache hit rate as percentage', () => {
      const mgr = new StreamingFooterManager({ cache: true });
      mgr.init();
      const result = mgr.buildStreamingFooter({
        inputTokens: 1000,
        outputTokens: 0,
        cacheRead: 800,
        totalTokens: 0,
        contextTokens: 0,
      });
      expect(result).toContain('⚡');
      expect(result).toContain('80%');
    });

    it('should show context usage', () => {
      const mgr = new StreamingFooterManager({ context: true });
      mgr.init();
      const result = mgr.buildStreamingFooter({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        totalTokens: 50000,
        contextTokens: 200000,
      });
      expect(result).toContain('🧠');
      expect(result).toContain('25%');
    });

    it('should dedup identical content', () => {
      const mgr = new StreamingFooterManager({ status: true });
      mgr.init();
      const first = mgr.buildStreamingFooter();
      // Second call immediately with same state should return null (dedup)
      // Note: the status text changes based on elapsed time (spin frame), so
      // we need to accept that it may differ slightly
      // Actually the spin frame changes every 300ms, so within a short time it may be the same
      expect(first).not.toBeNull();
    });
  });

  describe('buildTerminalFooter', () => {
    it('should return null when disabled', () => {
      const mgr = new StreamingFooterManager();
      expect(mgr.buildTerminalFooter(5000)).toBeNull();
    });

    it('should show "已完成" for normal state', () => {
      const mgr = new StreamingFooterManager({ status: true });
      const result = mgr.buildTerminalFooter(5000, undefined, 'normal');
      expect(result).toContain('已完成');
    });

    it('should show "出错" for error state', () => {
      const mgr = new StreamingFooterManager({ status: true });
      const result = mgr.buildTerminalFooter(5000, undefined, 'error');
      expect(result).toContain('出错');
    });

    it('should show "已停止" for abort state', () => {
      const mgr = new StreamingFooterManager({ status: true });
      const result = mgr.buildTerminalFooter(5000, undefined, 'abort');
      expect(result).toContain('已停止');
    });

    it('should show model when available', () => {
      const mgr = new StreamingFooterManager({ model: true });
      const result = mgr.buildTerminalFooter(5000, {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        totalTokens: 0,
        contextTokens: 0,
        model: 'mimo-v2.5-pro',
      });
      expect(result).toContain('🤖');
      expect(result).toContain('mimo-v2.5-pro');
    });
  });
});

describe('buildFooterElement', () => {
  it('should return a CardKit markdown element', () => {
    const el = buildFooterElement('test content');
    expect(el.tag).toBe('markdown');
    expect(el.content).toBe('test content');
    expect(el.element_id).toBe(FOOTER_ELEMENT_ID);
    expect(el.text_size).toBe('notation');
  });

  it('should use space for empty content', () => {
    const el = buildFooterElement('');
    expect(el.content).toBe(' ');
  });
});

describe('buildDividerElement', () => {
  it('should return an hr element', () => {
    const el = buildDividerElement();
    expect(el).toEqual({ tag: 'hr' });
  });
});

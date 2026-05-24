import { describe, it, expect, vi } from 'vitest';

// Mock dependencies of builder.ts
vi.mock('../src/card/markdown-style', () => ({
  optimizeMarkdownStyle: (s: string) => s,
}));
vi.mock('../src/card/tool-use-display', () => ({
  EMPTY_TOOL_USE_PLACEHOLDER: '...',
  ToolUseDisplayStep: {},
}));
vi.mock('../src/card/streaming-footer', () => ({
  FOOTER_ELEMENT_ID: 'streaming_footer',
}));
vi.mock('../src/card/session-stats', () => ({
  sessionStatsStore: { getSummary: () => null, getDailySummary: () => null, getMonthlySummary: () => null },
}));

import { formatElapsed, compactNumber } from '../src/card/builder';

describe('formatElapsed', () => {
  it('should format sub-second as X.Xs', () => {
    expect(formatElapsed(500)).toBe('0.5s');
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(999)).toBe('1.0s');
  });

  it('should format seconds < 60 as X.Xs', () => {
    expect(formatElapsed(1000)).toBe('1.0s');
    expect(formatElapsed(30500)).toBe('30.5s');
    expect(formatElapsed(59000)).toBe('59.0s');
  });

  it('should format >= 60s as Xm Ys', () => {
    expect(formatElapsed(60000)).toBe('1m 0s');
    expect(formatElapsed(90500)).toBe('1m 31s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });

  it('should handle large values', () => {
    expect(formatElapsed(3600000)).toBe('60m 0s');
  });
});

describe('compactNumber', () => {
  it('should return exact number for values < 1000', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(42)).toBe('42');
    expect(compactNumber(999)).toBe('999');
  });

  it('should format thousands with k suffix', () => {
    expect(compactNumber(1000)).toBe('1.0k');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(99999)).toBe('100.0k');
  });

  it('should format millions with m suffix', () => {
    expect(compactNumber(1000000)).toBe('1.0m');
    expect(compactNumber(1500000)).toBe('1.5m');
    expect(compactNumber(99999999)).toBe('100.0m');
  });

  it('should handle negative numbers', () => {
    expect(compactNumber(-500)).toBe('-500');
    expect(compactNumber(-1500)).toBe('-1.5k');
  });

  it('should round small numbers', () => {
    expect(compactNumber(42.7)).toBe('43');
  });
});

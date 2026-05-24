import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock larkLogger before importing footer-config
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resolveFooterConfig, DEFAULT_FOOTER_CONFIG } from '../src/core/footer-config';

describe('footer-config', () => {
  describe('DEFAULT_FOOTER_CONFIG', () => {
    it('should have all 9 fields defined', () => {
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('status', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('elapsed', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('tokens', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('cache', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('context', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('model', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('sessionStats', false);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('dailyStats', true);
      expect(DEFAULT_FOOTER_CONFIG).toHaveProperty('monthlyStats', true);
    });
  });

  describe('resolveFooterConfig', () => {
    it('should return defaults when cfg is undefined', () => {
      const result = resolveFooterConfig(undefined);
      expect(result).toEqual(DEFAULT_FOOTER_CONFIG);
    });

    it('should return defaults when cfg is empty object', () => {
      const result = resolveFooterConfig({});
      expect(result).toEqual(DEFAULT_FOOTER_CONFIG);
    });

    it('should override individual fields', () => {
      const result = resolveFooterConfig({ status: true, elapsed: true });
      expect(result.status).toBe(true);
      expect(result.elapsed).toBe(true);
      expect(result.tokens).toBe(false); // default preserved
    });

    it('should handle all fields set to true', () => {
      const result = resolveFooterConfig({
        status: true,
        elapsed: true,
        tokens: true,
        cache: true,
        context: true,
        model: true,
        sessionStats: true,
        dailyStats: true,
        monthlyStats: true,
      });
      expect(Object.values(result).every(Boolean)).toBe(true);
    });

    it('should coerce "true" string to boolean true', () => {
      const result = resolveFooterConfig({ status: 'true' as any });
      expect(result.status).toBe(true);
    });

    it('should coerce "false" string to boolean false', () => {
      // dailyStats default is true, so coercing to false should result in false
      const result = resolveFooterConfig({ dailyStats: 'false' as any });
      expect(result.dailyStats).toBe(false);
    });

    it('should coerce number 0 to false', () => {
      const result = resolveFooterConfig({ dailyStats: 0 as any });
      expect(result.dailyStats).toBe(false);
    });

    it('should coerce number 1 to true', () => {
      const result = resolveFooterConfig({ status: 1 as any });
      expect(result.status).toBe(true);
    });

    it('should use fallback for null values', () => {
      const result = resolveFooterConfig({ status: null as any });
      expect(result.status).toBe(false); // default fallback
    });

    it('should use fallback for undefined values', () => {
      const result = resolveFooterConfig({ status: undefined });
      expect(result.status).toBe(false); // default fallback
    });

    it('should return a new object each time (no mutation)', () => {
      const a = resolveFooterConfig({ status: true });
      const b = resolveFooterConfig({ status: true });
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });
});

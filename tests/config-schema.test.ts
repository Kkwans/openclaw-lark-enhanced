import { describe, it, expect } from 'vitest';
import { FeishuConfigSchema } from '../src/core/config-schema';

describe('FeishuConfigSchema - footer', () => {
  it('should accept empty footer config', () => {
    const result = FeishuConfigSchema.safeParse({ footer: {} });
    expect(result.success).toBe(true);
  });

  it('should accept footer with all boolean fields', () => {
    const result = FeishuConfigSchema.safeParse({
      footer: {
        status: true,
        elapsed: true,
        tokens: true,
        cache: true,
        context: true,
        model: true,
        sessionStats: true,
        dailyStats: true,
        monthlyStats: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-boolean values in footer', () => {
    const result = FeishuConfigSchema.safeParse({
      footer: { status: 'yes' },
    });
    expect(result.success).toBe(false);
  });

  it('should accept undefined footer (optional)', () => {
    const result = FeishuConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept partial footer config', () => {
    const result = FeishuConfigSchema.safeParse({
      footer: { sessionStats: true },
    });
    expect(result.success).toBe(true);
  });
});

describe('FeishuConfigSchema - dmPolicy', () => {
  it('should accept dmPolicy "open" with wildcard allowFrom', () => {
    const result = FeishuConfigSchema.safeParse({
      dmPolicy: 'open',
      allowFrom: ['*'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject dmPolicy "open" without wildcard', () => {
    const result = FeishuConfigSchema.safeParse({
      dmPolicy: 'open',
      allowFrom: ['user1'],
    });
    expect(result.success).toBe(false);
  });

  it('should accept other dmPolicy values without wildcard', () => {
    const result = FeishuConfigSchema.safeParse({
      dmPolicy: 'pairing',
    });
    expect(result.success).toBe(true);
  });
});

describe('FeishuConfigSchema - general', () => {
  it('should accept valid connectionMode', () => {
    const result = FeishuConfigSchema.safeParse({ connectionMode: 'websocket' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid connectionMode', () => {
    const result = FeishuConfigSchema.safeParse({ connectionMode: 'tcp' });
    expect(result.success).toBe(false);
  });

  it('should accept valid replyMode', () => {
    const result = FeishuConfigSchema.safeParse({ replyMode: 'streaming' });
    expect(result.success).toBe(true);
  });

  it('should accept replyMode as object', () => {
    const result = FeishuConfigSchema.safeParse({
      replyMode: { default: 'streaming', group: 'static' },
    });
    expect(result.success).toBe(true);
  });
});

/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Default values and resolution logic for the Feishu card footer configuration.
 *
 * Each boolean flag controls whether a particular metadata item is displayed
 * in the card footer (e.g. elapsed time, model name).
 */

import type { FeishuFooterConfig } from './types';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/footer-config');

// ---------------------------------------------------------------------------
// Validation & degradation helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a raw config value to a boolean with graceful degradation.
 *
 * Handles common misconfigurations:
 * - `"true"` / `"false"` strings → boolean
 * - `0` / `1` numbers → boolean  
 * - Non-boolean/non-string/non-number → fallback
 */
function coerceBoolean(field: string, value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    log.warn('footer config: invalid string for field, using default', {
      field,
      value,
      fallback,
    });
    return fallback;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (value != null) {
    log.warn('footer config: unexpected type for field, using default', {
      field,
      type: typeof value,
      value,
      fallback,
    });
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default footer configuration.
 *
 * By default all metadata items are hidden — neither status text
 * ("已完成" / "出错" / "已停止") nor elapsed time are shown.
 */
export const DEFAULT_FOOTER_CONFIG: Required<FeishuFooterConfig> = {
  status: false,
  elapsed: false,
  tokens: false,
  cache: false,
  context: false,
  model: false,
  sessionStats: false,
  dailyStats: true,
  monthlyStats: true,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Merge a partial footer configuration with `DEFAULT_FOOTER_CONFIG`.
 *
 * Fields present in the input take precedence; anything absent falls back
 * to the default value.
 */
export function resolveFooterConfig(cfg?: FeishuFooterConfig): Required<FeishuFooterConfig> {
  if (!cfg) return { ...DEFAULT_FOOTER_CONFIG };

  const resolved = {
    status: coerceBoolean('status', cfg.status, DEFAULT_FOOTER_CONFIG.status),
    elapsed: coerceBoolean('elapsed', cfg.elapsed, DEFAULT_FOOTER_CONFIG.elapsed),
    tokens: coerceBoolean('tokens', cfg.tokens, DEFAULT_FOOTER_CONFIG.tokens),
    cache: coerceBoolean('cache', cfg.cache, DEFAULT_FOOTER_CONFIG.cache),
    context: coerceBoolean('context', cfg.context, DEFAULT_FOOTER_CONFIG.context),
    model: coerceBoolean('model', cfg.model, DEFAULT_FOOTER_CONFIG.model),
    sessionStats: coerceBoolean('sessionStats', cfg.sessionStats, DEFAULT_FOOTER_CONFIG.sessionStats),
    dailyStats: coerceBoolean('dailyStats', cfg.dailyStats, DEFAULT_FOOTER_CONFIG.dailyStats),
    monthlyStats: coerceBoolean('monthlyStats', cfg.monthlyStats, DEFAULT_FOOTER_CONFIG.monthlyStats),
  };

  log.debug('footer config resolved', { input: cfg, resolved });
  return resolved;
}

/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Pause button registry for streaming cards.
 *
 * Maps card message IDs to their StreamingCardController instances so that
 * the card action handler can trigger an abort when the user clicks the
 * pause button.
 */

import { larkLogger } from '../core/lark-logger';

const log = larkLogger('card/pause-registry');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface PauseTarget {
  /** Abort the card UI (update card to show stopped state). */
  abortCard: () => Promise<void>;
  /** Abort the underlying LLM generation via AbortSignal. */
  abortController?: AbortController;
}

const activeTargets = new Map<string, PauseTarget>();

/**
 * Register a streaming controller's abort functions for a given message ID.
 */
export function registerPauseTarget(messageId: string, target: PauseTarget): void {
  activeTargets.set(messageId, target);
  log.debug('pause target registered', { messageId, registrySize: activeTargets.size });
}

/**
 * Unregister a streaming controller when it reaches a terminal phase.
 */
export function unregisterPauseTarget(messageId: string): void {
  const deleted = activeTargets.delete(messageId);
  if (deleted) {
    log.debug('pause target unregistered', { messageId, registrySize: activeTargets.size });
  }
}

/**
 * Trigger abort for a streaming card identified by its message ID.
 *
 * Aborts both the LLM generation (via AbortController) and the card UI.
 * Returns true if a matching controller was found and abort was triggered.
 */
export async function triggerPauseByMessageId(messageId: string): Promise<boolean> {
  const target = activeTargets.get(messageId);
  if (!target) {
    log.debug('pause target not found', { messageId });
    return false;
  }
  try {
    log.info('triggering pause/abort', { messageId });
    // Abort the LLM generation first (stops token streaming)
    if (target.abortController) {
      target.abortController.abort();
    }
    // Then abort the card UI (update card to show stopped state)
    await target.abortCard();
    // Target itself will unregister via onEnterTerminalPhase
    return true;
  } catch (err) {
    log.warn('pause trigger failed', { messageId, error: String(err) });
    return false;
  }
}

/**
 * Check if a message has an active streaming controller.
 */
export function hasActiveStreaming(messageId: string): boolean {
  return activeTargets.has(messageId);
}

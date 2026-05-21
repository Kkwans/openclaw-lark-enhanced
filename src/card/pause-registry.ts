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

type AbortFunction = () => Promise<void>;

const activeControllers = new Map<string, AbortFunction>();

/**
 * Register a streaming controller's abort function for a given message ID.
 */
export function registerPauseTarget(messageId: string, abortFn: AbortFunction): void {
  activeControllers.set(messageId, abortFn);
  log.debug('pause target registered', { messageId, registrySize: activeControllers.size });
}

/**
 * Unregister a streaming controller when it reaches a terminal phase.
 */
export function unregisterPauseTarget(messageId: string): void {
  const deleted = activeControllers.delete(messageId);
  if (deleted) {
    log.debug('pause target unregistered', { messageId, registrySize: activeControllers.size });
  }
}

/**
 * Trigger abort for a streaming card identified by its message ID.
 *
 * Returns true if a matching controller was found and abort was triggered.
 */
export async function triggerPauseByMessageId(messageId: string): Promise<boolean> {
  const abortFn = activeControllers.get(messageId);
  if (!abortFn) {
    log.debug('pause target not found', { messageId });
    return false;
  }
  try {
    log.info('triggering pause/abort', { messageId });
    await abortFn();
    // Abort itself will unregister via onEnterTerminalPhase
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
  return activeControllers.has(messageId);
}

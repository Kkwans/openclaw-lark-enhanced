/**
 * Pause (stop) button registry for streaming cards.
 *
 * Maps card message IDs to abort controllers so the stop button
 * click handler can find and invoke the correct abort signal.
 */

export interface PauseTarget {
  abortController: AbortController;
  cardMessageId: string;
}

const targets = new Map<string, PauseTarget>();

export function registerPauseTarget(messageId: string, target: PauseTarget): void {
  targets.set(messageId, target);
}

export function unregisterPauseTarget(messageId: string): void {
  targets.delete(messageId);
}

export function getPauseTarget(messageId: string): PauseTarget | undefined {
  return targets.get(messageId);
}

/**
 * Round state persistence for previous-round input token tracking.
 *
 * Stores the cumulative `lastUsage.input` value at the end of each turn
 * so the next turn's controller can compute the correct per-turn delta.
 *
 * This avoids relying on the session store (which may be updated by the
 * runtime during the current turn, making it unreliable for delta computation).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('card/round-state');

const STATE_DIR = '/root/.openclaw/data';

function statePath(sessionKey: string): string {
  // Sanitize session key for filename (replace non-alphanumeric with _)
  const safe = sessionKey.replace(/[^a-zA-Z0-9]/g, '_');
  return resolve(STATE_DIR, `round-state-${safe}.json`);
}

/**
 * Read the previous round's cumulative input token count.
 * Returns undefined if no state file exists (first turn ever).
 */
export function readPreviousRoundInput(sessionKey: string): number | undefined {
  try {
    const raw = readFileSync(statePath(sessionKey), 'utf-8');
    const data = JSON.parse(raw);
    const val = typeof data.previousRoundInput === 'number' ? data.previousRoundInput : undefined;
    log.debug('read previous round input', { sessionKey, previousRoundInput: val });
    return val;
  } catch {
    return undefined;
  }
}

/**
 * Write the current round's cumulative input token count.
 * Called at the end of each turn (in recordSessionStats).
 */
export function writePreviousRoundInput(sessionKey: string, rawInput: number): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(sessionKey), JSON.stringify({ previousRoundInput: rawInput }));
    log.debug('wrote previous round input', { sessionKey, previousRoundInput: rawInput });
  } catch (err) {
    log.warn('failed to write previous round input', { sessionKey, error: String(err) });
  }
}

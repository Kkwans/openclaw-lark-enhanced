/**
 * Session / daily / monthly statistics tracker.
 *
 * Tracks cumulative token usage, cache hit rates, and turn counts
 * across session, daily, and monthly scopes.
 *
 * Uses node:sqlite for persistent storage so stats survive restarts.
 */

import { DatabaseSync } from 'node:sqlite';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('card/session-stats');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionStatsEntry {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DailyStatsEntry extends SessionStatsEntry {
  date: string; // YYYY-MM-DD
}

export interface MonthlyStatsEntry extends SessionStatsEntry {
  month: string; // YYYY-MM
}

interface StatsRow {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DB_PATH = process.env.OPENCLAW_SESSION_STATS_DB
  ?? '/root/.openclaw/data/session-stats.db';

let db: DatabaseSync | null = null;
let dbInitialized = false;

function getDb(): DatabaseSync {
  if (db && dbInitialized) return db;
  try {
    db = new DatabaseSync(DB_PATH);
    if (!dbInitialized) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_stats (
          session_key TEXT PRIMARY KEY,
          turns INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0,
          updated_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS daily_stats (
          date_key TEXT PRIMARY KEY,
          turns INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS monthly_stats (
          month_key TEXT PRIMARY KEY,
          turns INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0
        );
      `);
      dbInitialized = true;
      log.info('session stats database initialized', { path: DB_PATH });
    }
  } catch (err) {
    log.error('failed to initialize session stats database', { error: String(err), path: DB_PATH });
    // Fallback: use in-memory database
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_stats (
        session_key TEXT PRIMARY KEY,
        turns INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS daily_stats (
        date_key TEXT PRIMARY KEY,
        turns INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS monthly_stats (
        month_key TEXT PRIMARY KEY,
        turns INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0
      );
    `);
    dbInitialized = true;
    log.warn('using in-memory fallback for session stats');
  }
  return db!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get date key in Asia/Shanghai timezone. */
function todayKey(): string {
  const now = new Date();
  // Use Intl to get Asia/Shanghai date parts
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value ?? '0000';
  const m = parts.find(p => p.type === 'month')?.value ?? '00';
  const d = parts.find(p => p.type === 'day')?.value ?? '00';
  return `${y}-${m}-${d}`;
}

/** Get month key in Asia/Shanghai timezone. */
function monthKey(): string {
  const today = todayKey();
  return today.slice(0, 7); // YYYY-MM
}

// Pre-compiled statements for ensureRow (avoid SQL injection from table/column names)
const ENSURE_SESSION = 'INSERT OR IGNORE INTO session_stats (session_key) VALUES (?)';
const ENSURE_DAILY = 'INSERT OR IGNORE INTO daily_stats (date_key) VALUES (?)';
const ENSURE_MONTHLY = 'INSERT OR IGNORE INTO monthly_stats (month_key) VALUES (?)';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect session restart by comparing sessionId from session store.
 * Returns the effective session stats key: `sessionId` if available,
 * otherwise falls back to the original sessionKey.
 *
 * @param sessionKey - The session key (e.g. 'agent:main:main')
 * @param currentSessionId - The sessionId from the session store
 * @returns The effective key to use for session stats
 */
export function resolveSessionStatsKey(
  sessionKey: string,
  currentSessionId: string | undefined,
): string {
  return currentSessionId ?? sessionKey;
}

export function incrementSessionStats(
  sessionKey: string,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): void {
  try {
    const d = getDb();
    const dk = todayKey();
    const mk = monthKey();
    const now = Date.now();

    const input = tokens.input ?? 0;
    const output = tokens.output ?? 0;
    const cacheRead = tokens.cacheRead ?? 0;
    const cacheWrite = tokens.cacheWrite ?? 0;

    // Session stats (upsert)
    d.prepare(ENSURE_SESSION).run(sessionKey);
    d.prepare(`
      UPDATE session_stats SET
        turns = turns + 1,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read = cache_read + ?,
        cache_write = cache_write + ?,
        updated_at = ?
      WHERE session_key = ?
    `).run(input, output, cacheRead, cacheWrite, now, sessionKey);

    // Daily stats (upsert)
    d.prepare(ENSURE_DAILY).run(dk);
    d.prepare(`
      UPDATE daily_stats SET
        turns = turns + 1,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read = cache_read + ?,
        cache_write = cache_write + ?
      WHERE date_key = ?
    `).run(input, output, cacheRead, cacheWrite, dk);

    // Monthly stats (upsert)
    d.prepare(ENSURE_MONTHLY).run(mk);
    d.prepare(`
      UPDATE monthly_stats SET
        turns = turns + 1,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read = cache_read + ?,
        cache_write = cache_write + ?
      WHERE month_key = ?
    `).run(input, output, cacheRead, cacheWrite, mk);

    log.debug('session stats incremented', { sessionKey, input, output, cacheRead, cacheWrite });
  } catch (err) {
    log.error('failed to increment session stats', { error: String(err), sessionKey });
  }
}

export function getSessionStats(sessionKey: string): SessionStatsEntry {
  try {
    const d = getDb();
    d.prepare(ENSURE_SESSION).run(sessionKey);
    const row = d.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM session_stats WHERE session_key = ?
    `).get(sessionKey) as StatsRow | undefined;
    return {
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get session stats', { error: String(err), sessionKey });
    return { turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

export function getDailyStats(): DailyStatsEntry {
  try {
    const d = getDb();
    const dk = todayKey();
    d.prepare(ENSURE_DAILY).run(dk);
    const row = d.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM daily_stats WHERE date_key = ?
    `).get(dk) as StatsRow | undefined;
    return {
      date: dk,
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get daily stats', { error: String(err) });
    const dk = todayKey();
    return { date: dk, turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

export function getMonthlyStats(): MonthlyStatsEntry {
  try {
    const d = getDb();
    const mk = monthKey();
    d.prepare(ENSURE_MONTHLY).run(mk);
    const row = d.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM monthly_stats WHERE month_key = ?
    `).get(mk) as StatsRow | undefined;
    return {
      month: mk,
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get monthly stats', { error: String(err) });
    const mk = monthKey();
    return { month: mk, turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

export function closeStatsDb(): void {
  if (db) {
    try {
      db.close();
    } catch { /* ignore */ }
    db = null;
    dbInitialized = false;
  }
}

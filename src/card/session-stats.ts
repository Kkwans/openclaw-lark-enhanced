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

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DB_PATH = process.env.OPENCLAW_SESSION_STATS_DB
  ?? '/root/.openclaw/data/session-stats.db';

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  try {
    db = new DatabaseSync(DB_PATH);
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
    log.info('session stats database initialized', { path: DB_PATH });
  } catch (err) {
    log.error('failed to initialize session stats database', { error: err, path: DB_PATH });
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
    log.warn('using in-memory fallback for session stats');
  }
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function ensureRow(table: string, keyColumn: string, key: string): void {
  const db = getDb();
  const existing = db.prepare(`SELECT 1 FROM ${table} WHERE ${keyColumn} = ?`).get(key);
  if (!existing) {
    db.prepare(`INSERT INTO ${table} (${keyColumn}) VALUES (?)`).run(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function incrementSessionStats(
  sessionKey: string,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): void {
  try {
    const db = getDb();
    const dk = todayKey();
    const mk = monthKey();
    const now = Date.now();

    const input = tokens.input ?? 0;
    const output = tokens.output ?? 0;
    const cacheRead = tokens.cacheRead ?? 0;
    const cacheWrite = tokens.cacheWrite ?? 0;

    // Session stats
    ensureRow('session_stats', 'session_key', sessionKey);
    db.prepare(`
      UPDATE session_stats SET
        turns = turns + 1,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read = cache_read + ?,
        cache_write = cache_write + ?,
        updated_at = ?
      WHERE session_key = ?
    `).run(input, output, cacheRead, cacheWrite, now, sessionKey);

    // Daily stats
    ensureRow('daily_stats', 'date_key', dk);
    db.prepare(`
      UPDATE daily_stats SET
        turns = turns + 1,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read = cache_read + ?,
        cache_write = cache_write + ?
      WHERE date_key = ?
    `).run(input, output, cacheRead, cacheWrite, dk);

    // Monthly stats
    ensureRow('monthly_stats', 'month_key', mk);
    db.prepare(`
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
    log.error('failed to increment session stats', { error: err, sessionKey });
  }
}

export function getSessionStats(sessionKey: string): SessionStatsEntry {
  try {
    const db = getDb();
    ensureRow('session_stats', 'session_key', sessionKey);
    const row = db.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM session_stats WHERE session_key = ?
    `).get(sessionKey) as any;
    return {
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get session stats', { error: err, sessionKey });
    return { turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

export function getDailyStats(): DailyStatsEntry {
  try {
    const db = getDb();
    const dk = todayKey();
    ensureRow('daily_stats', 'date_key', dk);
    const row = db.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM daily_stats WHERE date_key = ?
    `).get(dk) as any;
    return {
      date: dk,
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get daily stats', { error: err });
    const dk = todayKey();
    return { date: dk, turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

export function getMonthlyStats(): MonthlyStatsEntry {
  try {
    const db = getDb();
    const mk = monthKey();
    ensureRow('monthly_stats', 'month_key', mk);
    const row = db.prepare(`
      SELECT turns, input_tokens, output_tokens, cache_read, cache_write
      FROM monthly_stats WHERE month_key = ?
    `).get(mk) as any;
    return {
      month: mk,
      turns: row?.turns ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheRead: row?.cache_read ?? 0,
      cacheWrite: row?.cache_write ?? 0,
    };
  } catch (err) {
    log.error('failed to get monthly stats', { error: err });
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
  }
}

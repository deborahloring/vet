// Daily review counters in Durable Object SQLite storage.
//
// One counter per (Pacific day, visitor) and one shared counter per Pacific day. Days are
// keyed by the America/Los_Angeles calendar date, so both counters reset at local midnight
// including daylight-saving changes; they are never rolling 24-hour windows.
//
// reserve() runs check-and-increment inside a single synchronous SQLite transaction. A
// Durable Object processes it without interleaving, so concurrent requests cannot exceed
// either limit. Reservations are idempotent per review id.
//
// Pacing (owner-approved): at most 12 review starts in any rolling 60-second window, below
// Gemini's free-tier 15 requests per minute. A start over that rate is refused before
// anything is consumed, with the number of seconds until a slot opens.

import { nextPacificMidnight, pacificDayKey } from '../api/pacific-time.ts';
import type { AllowanceSnapshot, ReservationResult } from '../api/ports.ts';

export type SqlValue = string | number | null;

export interface SqlStorageLike {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
}

export interface DurableStorageLike {
  sql: SqlStorageLike;
  transactionSync<T>(fn: () => T): T;
}

export interface Limits {
  visitor: number;
  shared: number;
}

export const START_WINDOW_MS = 60_000;
export const MAX_STARTS_PER_WINDOW = 12;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visitor_usage (
     day TEXT NOT NULL, visitor TEXT NOT NULL, count INTEGER NOT NULL CHECK (count >= 0),
     PRIMARY KEY (day, visitor))`,
  `CREATE TABLE IF NOT EXISTS shared_usage (
     day TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK (count >= 0))`,
  `CREATE TABLE IF NOT EXISTS reservations (
     review_id TEXT PRIMARY KEY, day TEXT NOT NULL, visitor TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS review_starts (at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS review_starts_at ON review_starts (at)`,
  `CREATE TABLE IF NOT EXISTS live_pause (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL)`,
];

export class DeskLedger {
  private readonly storage: DurableStorageLike;

  constructor(storage: DurableStorageLike) {
    this.storage = storage;
    for (const statement of SCHEMA) storage.sql.exec(statement);
  }

  private count(query: string, ...bindings: SqlValue[]): number {
    const row = this.storage.sql.exec(query, ...bindings).toArray()[0];
    return row ? Number(row['count']) : 0;
  }

  private snapshot(day: string, visitor: string, now: Date, limits: Limits): AllowanceSnapshot {
    const used = this.count('SELECT count FROM visitor_usage WHERE day = ? AND visitor = ?', day, visitor);
    const shared = this.count('SELECT count FROM shared_usage WHERE day = ?', day);
    return {
      visitorRemaining: Math.max(0, limits.visitor - used),
      visitorLimit: limits.visitor,
      sharedRemaining: Math.max(0, limits.shared - shared),
      sharedLimit: limits.shared,
      dayKey: day,
      resetAt: nextPacificMidnight(now),
    };
  }

  /** Pause new live reviews until `until` (keeps the later of an existing and the new pause). */
  pause(until: Date): void {
    this.storage.sql.exec(`INSERT INTO live_pause (id, until) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET until = MAX(until, excluded.until)`, until.getTime());
  }

  /** The pause end as epoch ms if live reviews are paused at `now`, otherwise null. */
  pausedUntil(now: Date): number | null {
    const row = this.storage.sql.exec('SELECT until FROM live_pause WHERE id = 1').toArray()[0];
    const until = row ? Number(row['until']) : 0;
    return until > now.getTime() ? until : null;
  }

  status(visitor: string, now: Date, limits: Limits): AllowanceSnapshot {
    return this.snapshot(pacificDayKey(now), visitor, now, limits);
  }

  reserve(visitor: string, reviewId: string, now: Date, limits: Limits): ReservationResult {
    return this.storage.transactionSync((): ReservationResult => {
      const day = pacificDayKey(now);
      if (this.pausedUntil(now) !== null) return { ok: false, reason: 'paused', snapshot: this.snapshot(pacificDayKey(now), visitor, now, limits) };
      const prior = this.storage.sql.exec('SELECT day, visitor FROM reservations WHERE review_id = ?', reviewId).toArray()[0];
      if (prior) {
        // Same attempt retried: never counted twice.
        if (prior['visitor'] !== visitor) return { ok: false, reason: 'unavailable' };
        return { ok: true, snapshot: this.snapshot(day, visitor, now, limits) };
      }
      const before = this.snapshot(day, visitor, now, limits);
      if (before.visitorRemaining <= 0) return { ok: false, reason: 'visitor_limit', snapshot: before };
      if (before.sharedRemaining <= 0) return { ok: false, reason: 'shared_limit', snapshot: before };

      const sql = this.storage.sql;
      const nowMs = now.getTime();
      const windowStart = nowMs - START_WINDOW_MS;
      sql.exec('DELETE FROM review_starts WHERE at <= ?', windowStart);
      const recent = sql.exec('SELECT at FROM review_starts ORDER BY at ASC').toArray().map((r) => Number(r['at']));
      if (recent.length >= MAX_STARTS_PER_WINDOW) {
        const opensAt = recent[recent.length - MAX_STARTS_PER_WINDOW]! + START_WINDOW_MS;
        return { ok: false, reason: 'busy', retryAfterSeconds: Math.max(1, Math.ceil((opensAt - nowMs) / 1000)), snapshot: before };
      }
      sql.exec('INSERT INTO review_starts (at) VALUES (?)', nowMs);
      sql.exec(`INSERT INTO visitor_usage (day, visitor, count) VALUES (?, ?, 1)
                ON CONFLICT (day, visitor) DO UPDATE SET count = count + 1`, day, visitor);
      sql.exec(`INSERT INTO shared_usage (day, count) VALUES (?, 1)
                ON CONFLICT (day) DO UPDATE SET count = count + 1`, day);
      sql.exec('INSERT INTO reservations (review_id, day, visitor) VALUES (?, ?, ?)', reviewId, day, visitor);
      // Earlier Pacific days are no longer needed; keep storage small.
      sql.exec('DELETE FROM visitor_usage WHERE day < ?', day);
      sql.exec('DELETE FROM shared_usage WHERE day < ?', day);
      sql.exec('DELETE FROM reservations WHERE day < ?', day);
      return { ok: true, snapshot: this.snapshot(day, visitor, now, limits) };
    });
  }
}

// SQLite-backed Durable Object (binding DESK, class DeskState) holding the daily counters.
// A single named instance serves every visitor, so the shared limit is enforced in one place.
// Limits come from this object's own validated settings, never from the caller.

import { parseConfig } from './api/config.ts';
import { DeskLedger, type DurableStorageLike } from './allowance/ledger.ts';
import type { Env } from './env.ts';

export interface DurableObjectStateLike {
  storage: DurableStorageLike;
}

const VISITOR_KEY = /^[0-9a-f]{64}$/;
const REVIEW_ID = /^[A-Za-z0-9-]{8,64}$/;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export class DeskState {
  private readonly state: DurableObjectStateLike;
  private readonly env: Env;
  private readonly clock: () => Date;
  private ledger: DeskLedger | null = null;

  constructor(state: DurableObjectStateLike, env: Env, clock: () => Date = () => new Date()) {
    this.state = state;
    this.env = env;
    this.clock = clock;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      const action = new URL(request.url).pathname;
      if (action !== '/status' && action !== '/reserve' && action !== '/pause') return reply(404, { error: 'not_found' });
      const config = parseConfig(this.env);
      const limits = { visitor: config.visitorDailyLimit, shared: config.sharedDailyLimit };
      const body = (await request.json()) as { visitorKey?: unknown; reviewId?: unknown; until?: unknown };
      if (action === '/pause') {
        const until = typeof body.until === 'string' ? new Date(body.until) : new Date(NaN);
        const now = this.clock().getTime();
        if (Number.isNaN(until.getTime()) || until.getTime() <= now || until.getTime() > now + 48 * 3600_000) return reply(400, { error: 'invalid_request' });
        this.ledger ??= new DeskLedger(this.state.storage);
        this.ledger.pause(until);
        return reply(200, { ok: true });
      }
      if (typeof body.visitorKey !== 'string' || !VISITOR_KEY.test(body.visitorKey)) return reply(400, { error: 'invalid_request' });
      this.ledger ??= new DeskLedger(this.state.storage);
      if (action === '/status') {
        return reply(200, { ok: true, snapshot: this.ledger.status(body.visitorKey, this.clock(), limits) });
      }
      if (typeof body.reviewId !== 'string' || !REVIEW_ID.test(body.reviewId)) return reply(400, { error: 'invalid_request' });
      return reply(200, this.ledger.reserve(body.visitorKey, body.reviewId, this.clock(), limits));
    } catch {
      // Storage or configuration failure: callers treat any non-200 as unavailable and fail closed.
      return reply(503, { error: 'unavailable' });
    }
  }
}

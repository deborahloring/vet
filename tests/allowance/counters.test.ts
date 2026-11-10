// Daily counters: real SQLite statements, Pacific calendar days, atomic reservations.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DurableAllowanceStore } from '../../src/allowance/durable-store.ts';
import { DeskLedger, MAX_STARTS_PER_WINDOW, START_WINDOW_MS } from '../../src/allowance/ledger.ts';
import { deskNamespace, DESK_ENV, memoryStorage } from '../helpers/durable.ts';

const LIMITS = { visitor: 3, shared: 50 };
const v = (n: number) => n.toString(16).padStart(64, '0');   // visitor keys are 64-hex hashes
const at = (iso: string) => new Date(iso);
let seq = 0;
const id = () => `review-${String(++seq).padStart(6, '0')}`;

function ledger() {
  const storage = memoryStorage();
  return { storage, ledger: new DeskLedger(storage) };
}

describe('per-visitor limit (3 per Pacific day)', () => {
  test('three reservations succeed and the fourth is refused; other visitors are unaffected', () => {
    const { ledger: l } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    for (const left of [2, 1, 0]) {
      const r = l.reserve(v(1), id(), now, LIMITS);
      assert.ok(r.ok);
      assert.equal(r.snapshot.visitorRemaining, left);
    }
    const fourth = l.reserve(v(1), id(), now, LIMITS);
    assert.deepEqual([fourth.ok, !fourth.ok && fourth.reason], [false, 'visitor_limit']);
    assert.equal(l.reserve(v(2), id(), now, LIMITS).ok, true);
    assert.equal(l.status(v(1), now, LIMITS).visitorRemaining, 0);
    assert.equal(l.status(v(2), now, LIMITS).visitorRemaining, 2);
  });
  test('status never consumes', () => {
    const { ledger: l } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    for (let i = 0; i < 5; i++) l.status(v(1), now, LIMITS);
    assert.equal(l.status(v(1), now, LIMITS).visitorRemaining, 3);
  });
});

describe('shared limit (50 per Pacific day)', () => {
  test('the 51st reservation of the day is refused even for a fresh visitor', () => {
    const { ledger: l } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    let ok = 0;
    let n = 0;
    // Starts spaced 6 seconds apart stay under the 12-per-minute pacing limit.
    for (let visitor = 1; visitor <= 17; visitor++) {
      for (let k = 0; k < 3; k++) if (l.reserve(v(visitor), id(), new Date(now.getTime() - 400_000 + 6_000 * n++), LIMITS).ok) ok++;
    }
    assert.equal(ok, 50);
    const fresh = l.reserve(v(99), id(), now, LIMITS);
    assert.deepEqual([fresh.ok, !fresh.ok && fresh.reason], [false, 'shared_limit']);
    assert.equal(l.status(v(99), now, LIMITS).sharedRemaining, 0);
    assert.equal(l.status(v(99), now, LIMITS).visitorRemaining, 3, 'the visitor has not used any of their own');
  });
  test('lower configured limits are honored', () => {
    const { ledger: l } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    assert.ok(l.reserve(v(1), id(), now, { visitor: 1, shared: 2 }).ok);
    assert.equal(l.reserve(v(1), id(), now, { visitor: 1, shared: 2 }).ok, false);
    assert.ok(l.reserve(v(2), id(), now, { visitor: 1, shared: 2 }).ok);
    const third = l.reserve(v(3), id(), now, { visitor: 1, shared: 2 });
    assert.equal(!third.ok && third.reason, 'shared_limit');
  });
});

describe('Pacific midnight reset (calendar day, not rolling 24 hours)', () => {
  function exhaust(l: DeskLedger, when: Date) {
    for (let k = 0; k < 3; k++) assert.ok(l.reserve(v(1), id(), when, LIMITS).ok);
    assert.equal(l.reserve(v(1), id(), when, LIMITS).ok, false);
  }
  test('used up at 23:00 PST, fully restored one hour later at 00:00 PST', () => {
    const { ledger: l } = ledger();
    exhaust(l, at('2026-01-16T07:00:00Z'));                                     // 23:00 PST Jan 15
    assert.equal(l.status(v(1), at('2026-01-16T07:59:59Z'), LIMITS).visitorRemaining, 0);
    const s = l.status(v(1), at('2026-01-16T08:00:00Z'), LIMITS);              // 00:00 PST Jan 16
    assert.deepEqual([s.visitorRemaining, s.sharedRemaining, s.dayKey], [3, 50, '2026-01-16']);
  });
  test('resetAt is the next Pacific midnight', () => {
    const { ledger: l } = ledger();
    assert.equal(l.status(v(1), at('2026-01-16T07:00:00Z'), LIMITS).resetAt.toISOString(), '2026-01-16T08:00:00.000Z');
    assert.equal(l.status(v(1), at('2026-07-15T19:00:00Z'), LIMITS).resetAt.toISOString(), '2026-07-16T07:00:00.000Z');
  });
  test('spring forward (2026-03-08): resets at 00:00 PST, and the next reset is 00:00 PDT', () => {
    const { ledger: l } = ledger();
    exhaust(l, at('2026-03-08T07:30:00Z'));                                     // 23:30 PST Mar 7
    const s = l.status(v(1), at('2026-03-08T08:00:00Z'), LIMITS);              // 00:00 PST Mar 8
    assert.deepEqual([s.visitorRemaining, s.dayKey, s.resetAt.toISOString()], [3, '2026-03-08', '2026-03-09T07:00:00.000Z']);
  });
  test('fall back (2026-11-01): resets at 00:00 PDT, and the repeated 1 a.m. hour does not reset again', () => {
    const { ledger: l } = ledger();
    exhaust(l, at('2026-11-01T06:30:00Z'));                                     // 23:30 PDT Oct 31
    assert.equal(l.status(v(1), at('2026-11-01T07:00:00Z'), LIMITS).visitorRemaining, 3); // 00:00 PDT Nov 1
    assert.ok(l.reserve(v(1), id(), at('2026-11-01T08:30:00Z'), LIMITS).ok);   // 01:30 PDT
    assert.ok(l.reserve(v(1), id(), at('2026-11-01T09:30:00Z'), LIMITS).ok);   // 01:30 PST (repeated hour)
    assert.ok(l.reserve(v(1), id(), at('2026-11-01T10:30:00Z'), LIMITS).ok);   // 02:30 PST
    assert.equal(l.reserve(v(1), id(), at('2026-11-02T07:59:00Z'), LIMITS).ok, false); // 23:59 PST Nov 1
    const next = l.status(v(1), at('2026-11-02T08:00:00Z'), LIMITS);           // 00:00 PST Nov 2
    assert.deepEqual([next.visitorRemaining, next.resetAt.toISOString()], [3, '2026-11-03T08:00:00.000Z']);
  });
  test('earlier days are pruned when a new day is used', () => {
    const { ledger: l, storage } = ledger();
    l.reserve(v(1), id(), at('2026-01-15T20:00:00Z'), LIMITS);
    l.reserve(v(1), id(), at('2026-01-16T20:00:00Z'), LIMITS);
    const days = storage.db.prepare('SELECT DISTINCT day FROM visitor_usage').all().map((r) => r['day']);
    assert.deepEqual(days, ['2026-01-16']);
  });
});

describe('atomicity and idempotency', () => {
  test('retrying the same review id never counts twice', () => {
    const { ledger: l } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    const r1 = l.reserve(v(1), 'review-same-0001', now, LIMITS);
    const r2 = l.reserve(v(1), 'review-same-0001', now, LIMITS);
    assert.ok(r1.ok && r2.ok);
    assert.equal(r2.snapshot.visitorRemaining, 2);
    const other = l.reserve(v(2), 'review-same-0001', now, LIMITS);
    assert.equal(!other.ok && other.reason, 'unavailable', 'a review id cannot be reused by another visitor');
  });
  test('a storage failure mid-reservation rolls back completely', () => {
    const { ledger: l, storage } = ledger();
    const now = at('2026-07-15T19:00:00Z');
    storage.failWhen = /INSERT INTO reservations/;
    assert.throws(() => l.reserve(v(1), id(), now, LIMITS));
    storage.failWhen = null;
    const s = l.status(v(1), now, LIMITS);
    assert.deepEqual([s.visitorRemaining, s.sharedRemaining], [3, 50]);
  });
});

describe('pacing: at most 12 review starts in any rolling 60 seconds', () => {
  const t0 = Date.parse('2026-07-15T19:00:00Z');
  const fill = (l: DeskLedger, count = MAX_STARTS_PER_WINDOW) => {
    for (let i = 0; i < count; i++) assert.ok(l.reserve(v(1 + Math.floor(i / 3)), id(), new Date(t0 + i * 1000), LIMITS).ok);
  };
  test('the 13th start within 60 s is refused as busy, with nothing consumed', () => {
    const { ledger: l } = ledger();
    fill(l);
    const when = new Date(t0 + 20_000);
    const before = l.status(v(50), when, LIMITS);
    const r = l.reserve(v(50), id(), when, LIMITS);
    assert.ok(!r.ok && r.reason === 'busy');
    assert.equal(r.retryAfterSeconds, 40, 'the oldest start (t0) leaves the window at t0 + 60 s');
    const after = l.status(v(50), when, LIMITS);
    assert.deepEqual([after.visitorRemaining, after.sharedRemaining], [before.visitorRemaining, before.sharedRemaining]);
    assert.equal(after.sharedRemaining, 50 - MAX_STARTS_PER_WINDOW);
  });
  test('a slot opens exactly when the oldest start leaves the rolling window', () => {
    const { ledger: l } = ledger();
    fill(l);
    assert.equal(l.reserve(v(60), id(), new Date(t0 + START_WINDOW_MS - 1), LIMITS).ok, false);
    assert.equal(l.reserve(v(60), id(), new Date(t0 + START_WINDOW_MS), LIMITS).ok, true);
    assert.equal(l.reserve(v(61), id(), new Date(t0 + START_WINDOW_MS), LIMITS).ok, false, 'only one slot opened');
  });
  test('daily limits are reported before pacing (a visitor at their limit is told so, not "busy")', () => {
    const { ledger: l } = ledger();
    fill(l);
    const r = l.reserve(v(1), id(), new Date(t0 + 30_000), LIMITS);
    assert.equal(!r.ok && r.reason, 'visitor_limit');
  });
  test('retrying an existing review id does not count as another start', () => {
    const { ledger: l } = ledger();
    fill(l, MAX_STARTS_PER_WINDOW - 1);
    assert.ok(l.reserve(v(20), 'review-pace-0001', new Date(t0 + 50_000), LIMITS).ok);
    assert.ok(l.reserve(v(20), 'review-pace-0001', new Date(t0 + 51_000), LIMITS).ok);
    assert.equal(l.reserve(v(21), id(), new Date(t0 + 52_000), LIMITS).ok, false, 'still exactly 12 starts');
  });
  test('20 simultaneous starts through the Durable Object grant exactly 12; the rest are busy and unconsumed', async () => {
    const { namespace } = deskNamespace({ clock: () => new Date(t0) });
    const store = new DurableAllowanceStore(namespace);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.reserve({ visitorKey: v(100 + i) }, `pace-${String(i).padStart(4, '0')}`)));
    assert.equal(results.filter((r) => r.ok).length, 12);
    const busy = results.filter((r) => !r.ok && r.reason === 'busy');
    assert.equal(busy.length, 8);
    assert.ok(busy.every((r) => !r.ok && r.reason === 'busy' && r.retryAfterSeconds === 60));
    const refused = results.findIndex((r) => !r.ok);
    assert.equal((await store.status({ visitorKey: v(100 + refused) }))!.visitorRemaining, 3);
  });
});

describe('DeskState Durable Object through the Worker-side store', () => {
  test('120 simultaneous reservations from 40 visitors grant exactly 50, at most 3 each', async () => {
    // The Durable Object clock advances 6 s per request so pacing is not the constraint here.
    let tick = 0;
    const { namespace } = deskNamespace({ clock: () => new Date(Date.parse('2026-07-15T18:00:00Z') + 6_000 * tick++) });
    const store = new DurableAllowanceStore(namespace);
    const attempts = Array.from({ length: 120 }, (_, i) => ({ visitorKey: v(1 + (i % 40)) }));
    const results = await Promise.all(attempts.map((identity, i) => store.reserve(identity, `concurrent-${String(i).padStart(4, '0')}`)));
    const granted = attempts.filter((_, i) => results[i]!.ok);
    assert.equal(granted.length, 50);
    const perVisitor = new Map<string, number>();
    for (const g of granted) perVisitor.set(g.visitorKey, (perVisitor.get(g.visitorKey) ?? 0) + 1);
    assert.ok([...perVisitor.values()].every((n) => n <= 3));
    assert.equal(results.filter((r) => !r.ok && r.reason === 'shared_limit').length, 70);
  });
  test('ten simultaneous reservations by one visitor grant exactly 3', async () => {
    const { namespace } = deskNamespace();
    const store = new DurableAllowanceStore(namespace);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.reserve({ visitorKey: v(7) }, `burst-${String(i).padStart(4, '0')}`)));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.equal(results.filter((r) => !r.ok && r.reason === 'visitor_limit').length, 7);
  });
  test('all visitors share one named Durable Object instance', async () => {
    const { namespace, seen } = deskNamespace();
    const store = new DurableAllowanceStore(namespace);
    await store.status({ visitorKey: v(1) });
    await store.reserve({ visitorKey: v(2) }, 'review-named-01');
    assert.deepEqual([...new Set(seen)], ['desk']);
  });
  test('limits come from the Durable Object settings, not the caller', async () => {
    const { namespace } = deskNamespace({ env: { ...DESK_ENV, VISITOR_DAILY_LIMIT: '1' } });
    const store = new DurableAllowanceStore(namespace);
    assert.ok((await store.reserve({ visitorKey: v(1) }, 'review-limit-01')).ok);
    const second = await store.reserve({ visitorKey: v(1) }, 'review-limit-02');
    assert.equal(!second.ok && second.reason, 'visitor_limit');
  });
  test('storage failure: status is null and reservations are unavailable (fail closed)', async () => {
    const storage = memoryStorage();
    const { namespace } = deskNamespace({ storage });
    const store = new DurableAllowanceStore(namespace);
    await store.status({ visitorKey: v(1) }); // create tables
    storage.failWhen = /./;
    assert.equal(await store.status({ visitorKey: v(1) }), null);
    assert.deepEqual(await store.reserve({ visitorKey: v(1) }, 'review-fail-01'), { ok: false, reason: 'unavailable' });
  });
  test('missing Durable Object settings fail closed', async () => {
    const { namespace } = deskNamespace({ env: { VISITOR_DAILY_LIMIT: '3' } });
    const store = new DurableAllowanceStore(namespace);
    assert.equal(await store.status({ visitorKey: v(1) }), null);
    assert.deepEqual(await store.reserve({ visitorKey: v(1) }, 'review-cfg-01'), { ok: false, reason: 'unavailable' });
  });
  test('an unreachable Durable Object or malformed visitor key fails closed', async () => {
    const broken = new DurableAllowanceStore({ idFromName: () => 'desk', get: () => ({ fetch: async () => { throw new Error('down'); } }) });
    assert.equal(await broken.status({ visitorKey: v(1) }), null);
    assert.deepEqual(await broken.reserve({ visitorKey: v(1) }, 'review-down-01'), { ok: false, reason: 'unavailable' });
    const { namespace } = deskNamespace();
    const store = new DurableAllowanceStore(namespace);
    assert.equal(await store.status({ visitorKey: 'not-a-hash' }), null);
  });
  test('the Durable Object accepts only POST /status and /reserve', async () => {
    const { desk } = deskNamespace();
    assert.equal((await desk.fetch(new Request('https://desk.internal/status'))).status, 405);
    assert.equal((await desk.fetch(new Request('https://desk.internal/reset', { method: 'POST', body: '{}' }))).status, 404);
  });
});

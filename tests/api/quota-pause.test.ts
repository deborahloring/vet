// Gemini quota refusals: live reviews pause before reservation so later visitors keep their
// attempts. The attempt that received the refusal stays used; demonstrations stay available;
// when the pause ends the next review is tried normally (quota is never assumed to be back).

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { DurableAllowanceStore } from '../../src/allowance/durable-store.ts';
import { DeskLedger } from '../../src/allowance/ledger.ts';
import type { Dependencies, InterpretationResult, LogEvent } from '../../src/api/ports.ts';
import { handleRequest, quotaPauseEnd } from '../../src/api/router.ts';
import { AccessIdentityVerifier, accessSettingsFromEnv } from '../../src/auth/access.ts';
import { bundledDataSource } from '../../src/data/index.ts';
import type { Env } from '../../src/env.ts';
import { quotaRefusal } from '../../src/gemini/interpreter.ts';
import { ACCESS_ENV, accessFixture, deskNamespace, DESK_ENV, memoryStorage, withToken, type AccessFixture } from '../helpers/durable.ts';

const BASE = 'https://vet.deborahloring.com';
const INVOICE = 'PO-2024-0003';
let fx: AccessFixture;
before(async () => { fx = await accessFixture(); });

function googleQuota429(quotaId: string, retryDelay?: string): string {
  const details: object[] = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] }];
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  return JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details } });
}

describe('reading Google quota refusals', () => {
  test('daily, per-minute, unknown and non-JSON bodies', () => {
    assert.deepEqual(quotaRefusal(googleQuota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '41s')), { scope: 'day', retryAfterSeconds: 41 });
    assert.deepEqual(quotaRefusal(googleQuota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '12.4s')), { scope: 'minute', retryAfterSeconds: 13 });
    assert.deepEqual(quotaRefusal(googleQuota429('SomethingElse')), { scope: 'unknown', retryAfterSeconds: null });
    assert.deepEqual(quotaRefusal('<html>Too Many Requests</html>'), { scope: 'unknown', retryAfterSeconds: null });
  });
  test('pause length: daily quota to the next Pacific midnight; otherwise 60 s to 1 hour', () => {
    const now = new Date('2026-11-09T20:00:00Z'); // 12:00 PST
    assert.equal(quotaPauseEnd(now, { scope: 'day', retryAfterSeconds: 5 }).toISOString(), '2026-11-10T08:00:00.000Z');
    assert.equal(quotaPauseEnd(now, { scope: 'minute', retryAfterSeconds: 5 }).getTime() - now.getTime(), 60_000);
    assert.equal(quotaPauseEnd(now, { scope: 'minute', retryAfterSeconds: 90 }).getTime() - now.getTime(), 90_000);
    assert.equal(quotaPauseEnd(now, { scope: 'unknown', retryAfterSeconds: 99_999 }).getTime() - now.getTime(), 3_600_000);
    assert.equal(quotaPauseEnd(now, undefined).getTime() - now.getTime(), 60_000);
  });
});

describe('ledger pause', () => {
  test('a paused ledger refuses before anything is consumed and keeps the later pause', () => {
    const l = new DeskLedger(memoryStorage());
    const now = new Date('2026-11-09T20:00:00Z');
    const limits = { visitor: 3, shared: 50 };
    const v = 'a'.repeat(64);
    l.pause(new Date(now.getTime() + 120_000));
    l.pause(new Date(now.getTime() + 60_000)); // an earlier end never shortens the pause
    const r = l.reserve(v, 'review-0001', now, limits);
    assert.equal(!r.ok && r.reason, 'paused');
    assert.equal(l.status(v, now, limits).visitorRemaining, 3);
    assert.equal(l.status(v, now, limits).sharedRemaining, 50);
    assert.equal(l.reserve(v, 'review-0002', new Date(now.getTime() + 119_000), limits).ok, false);
    assert.equal(l.reserve(v, 'review-0003', new Date(now.getTime() + 120_000), limits).ok, true);
  });
});

function setup(interpret: { result: InterpretationResult }, start: Date) {
  const env: Env = { ...DESK_ENV, ...ACCESS_ENV };
  let now = start;
  const desk = deskNamespace({ env, clock: () => now });
  const logs: LogEvent[] = [];
  let interpretCalls = 0;
  const deps: Dependencies = {
    identity: new AccessIdentityVerifier(accessSettingsFromEnv(env), fx.keys),
    allowance: new DurableAllowanceStore(desk.namespace),
    interpreter: { interpret: async () => { interpretCalls++; return interpret.result; } },
    composer: { compose: () => ({ outcome: 'no_discrepancy_found', findings: [], provenance: { deterministic: 0, ai: 0, combined: 0 } }) },
    now: () => now,
    newReviewId: () => crypto.randomUUID(),
    log: (e) => logs.push(e),
  };
  const send = async (request: Request) => {
    const response = await handleRequest(request, { ...env, DESK: desk.namespace }, deps, bundledDataSource());
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  return { send, logs, interpretCalls: () => interpretCalls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const allowance = (token: string) => withToken(`${BASE}/api/allowance`, token);
const review = (token: string) => withToken(`${BASE}/api/review`, token, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceNo: INVOICE }) });
const SUCCESS: InterpretationResult = { ok: true, findings: [], discount: { status: 'none', noteExcerpt: null }, rejected: 0, usage: null };

describe('router: a quota refusal pauses live reviews', () => {
  test('daily quota: that attempt stays used; later reviews are refused before reservation until Pacific midnight', async () => {
    const t = setup({ result: { ok: false, reason: 'quota', quota: { scope: 'day', retryAfterSeconds: null } } }, new Date('2026-11-09T20:00:00Z'));
    const token = await fx.sign();
    const first = await t.send(review(token));
    assert.equal(first.status, 503);
    assert.equal(first.body.error.code, 'service_interrupted');
    assert.equal((await t.send(allowance(token))).body.remaining, 2, 'the refused attempt stays used');

    const other = await fx.sign({ sub: 'access-user-0002' });
    for (const tk of [token, other]) {
      const r = await t.send(review(tk));
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, 'live_reviews_paused');
      assert.match(r.body.error.message, /No review was used/);
      assert.doesNotMatch(r.text, /quota|remaining|\d/i, 'no quota details or balances');
    }
    assert.equal(t.interpretCalls(), 1, 'no model call while paused');
    assert.equal((await t.send(allowance(token))).body.remaining, 2);
    assert.equal((await t.send(allowance(other))).body.remaining, 3);
    const demos = await t.send(withToken(`${BASE}/api/demonstrations`, token));
    assert.equal(demos.status, 200);
    assert.equal(demos.body.demonstrations.length, 9);
    assert.ok(t.logs.some((e) => e.event === 'live_reviews_paused' && e.reason === 'quota_day'));

    t.advance(11 * 3600_000 + 59 * 60_000); // 23:59 PST: still paused
    assert.equal((await t.send(review(other))).body.error.code, 'live_reviews_paused');
    assert.equal(t.interpretCalls(), 1);
  });
  test('when the pause ends the next review is tried normally, and pauses again if Gemini still refuses', async () => {
    const interpret: { result: InterpretationResult } = { result: { ok: false, reason: 'quota', quota: { scope: 'minute', retryAfterSeconds: 20 } } };
    const t = setup(interpret, new Date('2026-11-09T20:00:00Z'));
    const token = await fx.sign();
    assert.equal((await t.send(review(token))).body.error.code, 'service_interrupted');
    t.advance(30_000);
    assert.equal((await t.send(review(token))).body.error.code, 'live_reviews_paused');
    t.advance(31_000); // past the 60-second minimum
    assert.equal((await t.send(review(token))).body.error.code, 'service_interrupted', 'tried again; still refused');
    assert.equal(t.interpretCalls(), 2);
    assert.equal((await t.send(review(token))).body.error.code, 'live_reviews_paused');
    t.advance(61_000);
    interpret.result = SUCCESS;
    assert.equal((await t.send(review(token))).status, 200);
    assert.equal(t.interpretCalls(), 3);
    assert.equal((await t.send(allowance(token))).body.remaining, 0);
  });
  test('other Gemini failures do not pause live reviews', async () => {
    const t = setup({ result: { ok: false, reason: 'timeout' } }, new Date('2026-11-09T20:00:00Z'));
    const token = await fx.sign();
    assert.equal((await t.send(review(token))).body.error.code, 'service_interrupted');
    assert.equal((await t.send(review(token))).body.error.code, 'service_interrupted');
    assert.equal(t.interpretCalls(), 2);
  });
  test('the desk rejects malformed or out-of-range pause requests', async () => {
    const now = new Date('2026-11-09T20:00:00Z');
    const desk = deskNamespace({ env: { ...DESK_ENV }, clock: () => now });
    const stub = desk.namespace.get(desk.namespace.idFromName('desk'));
    const post = (body: unknown) => stub.fetch(new Request('https://desk.internal/pause', { method: 'POST', body: JSON.stringify(body) }));
    for (const until of [undefined, 'soon', '2026-11-09T19:59:00Z', '2026-11-12T20:00:00Z']) assert.equal((await post({ until })).status, 400);
    assert.equal((await post({ until: '2026-11-09T20:01:00Z' })).status, 200);
  });
});

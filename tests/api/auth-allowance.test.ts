// End-to-end inside Node: router + real Access JWT verification + real DeskState counters.
// Gemini and the unified response (Steps 4-5) are local mocks here.

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { DurableAllowanceStore } from '../../src/allowance/durable-store.ts';
import { productionDependencies } from '../../src/api/dependencies.ts';
import type { Dependencies, InterpretationResult, LogEvent } from '../../src/api/ports.ts';
import { handleRequest } from '../../src/api/router.ts';
import { AccessIdentityVerifier, accessSettingsFromEnv } from '../../src/auth/access.ts';
import { bundledDataSource } from '../../src/data/index.ts';
import type { Env } from '../../src/env.ts';
import { ACCESS_ENV, accessFixture, deskNamespace, DESK_ENV, memoryStorage, VISITOR_EMAIL, withToken, type AccessFixture } from '../helpers/durable.ts';

const BASE = 'https://vet.deborahloring.com';
const INVOICE = 'PO-2024-0003';
let fx: AccessFixture;
before(async () => { fx = await accessFixture(); });

function setup(opts: { interpret?: InterpretationResult; env?: Env; storage?: ReturnType<typeof memoryStorage>; clock?: () => Date } = {}) {
  const env: Env = { ...DESK_ENV, ...ACCESS_ENV, ...opts.env };
  const desk = deskNamespace({ env, storage: opts.storage, clock: opts.clock });
  const logs: LogEvent[] = [];
  let interpretCalls = 0;
  const deps: Dependencies = {
    identity: new AccessIdentityVerifier(accessSettingsFromEnv(env), fx.keys),
    allowance: new DurableAllowanceStore(desk.namespace),
    interpreter: { interpret: async () => { interpretCalls++; return opts.interpret ?? { ok: true, findings: [], discount: { status: 'none', noteExcerpt: null }, rejected: 0, usage: null }; } },
    composer: { compose: (d) => ({ outcome: d.findings.length ? 'discrepancy_identified' : 'no_discrepancy_found', findings: [],
      provenance: { deterministic: d.findings.length, ai: 0, combined: 0 } }) },
    now: () => new Date(),
    newReviewId: () => crypto.randomUUID(),
    log: (e) => logs.push(e),
  };
  const send = async (request: Request) => {
    const response = await handleRequest(request, { ...env, ...{ DESK: desk.namespace } }, deps, bundledDataSource());
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  return { env, desk, deps, logs, send, interpretCalls: () => interpretCalls };
}

const allowance = (token: string | null) => withToken(`${BASE}/api/allowance`, token);
const review = (token: string | null, body: unknown = { invoiceNo: INVOICE }, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  withToken(`${BASE}/api/review`, token, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('authentication at the API', () => {
  test('valid authorized token: allowance shows 3 remaining and the next Pacific midnight', async () => {
    const t = setup({ clock: () => new Date('2026-03-08T09:00:00Z') }); // 01:00 PST on spring-forward day
    const r = await t.send(allowance(await fx.sign()));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { remaining: 3, limit: 3, resetAt: '2026-03-09T07:00:00.000Z', timeZone: 'America/Los_Angeles', limitedBy: null });
  });
  test('missing, expired, forged, wrong-issuer and wrong-audience tokens get 401 and never reach storage', async () => {
    const storage = memoryStorage();
    const t = setup({ storage });
    const now = Math.floor(Date.now() / 1000);
    storage.failWhen = /./; // any storage access would surface as a 503, not a 401
    for (const token of [null, 'garbage', await fx.sign({ iat: now - 7200, exp: now - 60 }), await fx.sign({}, { forged: true }),
      await fx.sign({ iss: 'https://other.cloudflareaccess.com' }), await fx.sign({ aud: 'b'.repeat(64) })]) {
      for (const request of [allowance(token), review(token)]) {
        const r = await t.send(request);
        assert.equal(r.status, 401);
        assert.equal(r.body.error.code, 'authentication_required');
      }
    }
  });
  test('an authenticated email that is not allowed gets 403', async () => {
    const t = setup();
    const r = await t.send(allowance(await fx.sign({ email: 'stranger@example.com' })));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'access_denied');
  });
  test('revocation: after the email is removed, the same token is refused', async () => {
    const token = await fx.sign();
    assert.equal((await setup().send(allowance(token))).status, 200);
    assert.equal((await setup({ env: { ALLOWED_EMAIL: 'owner@example.com' } }).send(allowance(token))).status, 403);
  });
});

describe('allowance consumption rules', () => {
  test('rejections before reservation never consume an attempt', async () => {
    const t = setup();
    const token = await fx.sign();
    const rejected = [
      review(null),
      review(token, { invoiceNo: INVOICE }, { 'content-type': 'text/plain' }),
      review(token, '{"invoiceNo":'),
      review(token, { invoiceNo: INVOICE, note: 'please explain' }),
      review(token, { invoiceNo: 'PO-2022-0007' }),     // in the dataset, not allowlisted
      review(token, { invoiceNo: 'PO-2099-9999' }),
    ];
    for (const request of rejected) assert.notEqual((await t.send(request)).status, 200);
    const closed = setup({ env: { DESK_OPEN: 'false' }, storage: t.desk.storage });
    assert.equal((await closed.send(review(token))).body.error.code, 'review_closed');
    assert.equal((await t.send(allowance(token))).body.remaining, 3);
    assert.equal(t.interpretCalls(), 0);
  });
  test('a Gemini failure after reservation keeps the attempt consumed', async () => {
    const t = setup({ interpret: { ok: false, reason: 'provider_error' } });
    const token = await fx.sign();
    const r = await t.send(review(token));
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_interrupted');
    assert.match(r.body.error.message, /attempt has been used/);
    assert.equal(t.interpretCalls(), 1);
    assert.equal((await t.send(allowance(token))).body.remaining, 2);
  });
  test('three reviews per visitor, then 429 with no further model calls; another visitor is unaffected', async () => {
    const t = setup();
    const token = await fx.sign();
    for (const left of [2, 1, 0]) {
      const r = await t.send(review(token));
      assert.equal(r.status, 200);
      assert.equal(r.body.remaining, left);
    }
    const fourth = await t.send(review(token));
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, 'daily_limit_reached');
    assert.equal(t.interpretCalls(), 3);
    assert.equal((await t.send(allowance(await fx.sign({ sub: 'access-user-0002' })))).body.remaining, 3);
  });
  test('the shared limit applies across visitors', async () => {
    const t = setup({ env: { SHARED_DAILY_LIMIT: '2' } });
    assert.equal((await t.send(review(await fx.sign({ sub: 'u1' })))).status, 200);
    assert.equal((await t.send(review(await fx.sign({ sub: 'u2' })))).status, 200);
    const third = await t.send(review(await fx.sign({ sub: 'u3' })));
    assert.equal(third.status, 429);
    assert.equal((await t.send(allowance(await fx.sign({ sub: 'u3' })))).body.remaining, 0);
  });
  test('simultaneous review requests from one visitor never exceed 3', async () => {
    const t = setup();
    const token = await fx.sign();
    const results = await Promise.all(Array.from({ length: 8 }, () => t.send(review(token))));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.equal(results.filter((r) => r.status === 429).length, 5);
    assert.equal(t.interpretCalls(), 3);
  });
});

describe('pacing and limit messages at the API', () => {
  test('a busy terminal answers 503 terminal_busy with Retry-After, no model call, nothing consumed', async () => {
    const t = setup({ clock: () => new Date('2026-07-15T19:00:00Z') });
    for (let i = 0; i < 12; i++) assert.equal((await t.send(review(await fx.sign({ sub: `pace-${i}` })))).status, 200);
    const token = await fx.sign({ sub: 'pace-late' });
    const raw = await handleRequest(review(token), { ...t.env, DESK: t.desk.namespace }, t.deps, bundledDataSource());
    const body = await raw.json();
    assert.equal(raw.status, 503);
    assert.equal(body.error.code, 'terminal_busy');
    assert.equal(raw.headers.get('retry-after'), '60');
    assert.match(body.error.message, /No review was used/);
    assert.equal(t.interpretCalls(), 12);
    assert.equal((await t.send(allowance(token))).body.remaining, 3);
  });
  test('the allowance says which daily limit is exhausted', async () => {
    const t = setup({ env: { SHARED_DAILY_LIMIT: '1' } });
    assert.equal((await t.send(review(await fx.sign({ sub: 's1' })))).status, 200);
    const other = await t.send(allowance(await fx.sign({ sub: 's2' })));
    assert.deepEqual([other.body.remaining, other.body.limitedBy], [0, 'shared']);
    const shared = await t.send(review(await fx.sign({ sub: 's2' })));
    assert.match(shared.body.error.message, /shared live reviews/);
    const own = setup();
    const token = await fx.sign({ sub: 'own' });
    for (let i = 0; i < 3; i++) await own.send(review(token));
    assert.equal((await own.send(allowance(token))).body.limitedBy, 'visitor');
    assert.match((await own.send(review(token))).body.error.message, /You have used today/);
  });
});

describe('demonstrations stay available', () => {
  test('after the visitor uses all reviews, and when the desk is closed: no allowance use, no model call', async () => {
    const t = setup();
    const token = await fx.sign({ sub: 'demo-visitor' });
    for (let i = 0; i < 3; i++) await t.send(review(token));
    assert.equal((await t.send(review(token))).status, 429);
    const calls = t.interpretCalls();
    const open = await t.send(withToken(`${BASE}/api/demonstrations`, token));
    assert.equal(open.status, 200);
    assert.equal(open.body.demonstrations.length, 9);
    const closed = setup({ env: { DESK_OPEN: 'false' } });
    assert.equal((await closed.send(withToken(`${BASE}/api/demonstrations`, token))).status, 200);
    assert.equal(t.interpretCalls(), calls);
    assert.equal((await t.send(allowance(token))).body.remaining, 0, 'viewing demonstrations used nothing');
  });
});

describe('fail closed', () => {
  test('storage failure: allowance 503, review 503 without a model call', async () => {
    const storage = memoryStorage();
    const t = setup({ storage });
    const token = await fx.sign();
    storage.failWhen = /./;
    const a = await t.send(allowance(token));
    assert.deepEqual([a.status, a.body.error.code], [503, 'service_interrupted']);
    const r = await t.send(review(token));
    assert.deepEqual([r.status, r.body.error.code], [503, 'service_interrupted']);
    assert.equal(t.interpretCalls(), 0);
  });
  test('missing Access secrets or DESK binding: 503 everywhere', async () => {
    const noSecrets = productionDependencies({ ...DESK_ENV });
    const r1 = await handleRequest(allowance(await fx.sign()), DESK_ENV, noSecrets, bundledDataSource());
    assert.equal(r1.status, 503);
    const t = setup();
    const noDesk: Dependencies = { ...t.deps, allowance: productionDependencies({ ...DESK_ENV, ...ACCESS_ENV }).allowance };
    const r2 = await handleRequest(allowance(await fx.sign()), { ...DESK_ENV, ...ACCESS_ENV }, noDesk, bundledDataSource());
    assert.equal(r2.status, 503);
  });
  test('production wiring keeps POST /api/review closed before any reservation (Gemini not implemented)', async () => {
    const t = setup();
    const production = productionDependencies({ ...t.env, DESK: t.desk.namespace });
    assert.equal(production.interpreter, null);
    const deps = { ...production, identity: t.deps.identity }; // local keys instead of fetching Cloudflare's
    const token = await fx.sign();
    const r = await handleRequest(review(token), { ...t.env, DESK: t.desk.namespace }, deps, bundledDataSource());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'service_not_ready');
    assert.equal((await t.send(allowance(token))).body.remaining, 3);
  });
});

describe('privacy', () => {
  test('responses and logs never contain the token, email, subject or visitor key', async () => {
    const t = setup({ interpret: { ok: false, reason: 'provider_error' } });
    const token = await fx.sign();
    const ok = await t.deps.identity!.verify(withToken(BASE, token));
    assert.ok(ok.ok);
    const texts = [(await t.send(allowance(token))).text, (await t.send(review(token))).text,
      (await t.send(allowance(await fx.sign({ email: 'stranger@example.com' })))).text, JSON.stringify(t.logs)];
    for (const text of texts) {
      for (const secret of [token, VISITOR_EMAIL, 'stranger@example.com', 'access-user-0001', ok.identity.visitorKey]) {
        assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 12)}`);
      }
    }
  });
});

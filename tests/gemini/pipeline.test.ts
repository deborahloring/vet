// Router + Access verification + DeskState counters + the real GeminiInterpreter, with only
// the HTTP call to Gemini mocked. Verifies one model request per completed review.

import assert from 'node:assert/strict';
import { afterEach, before, describe, test } from 'node:test';
import { DurableAllowanceStore } from '../../src/allowance/durable-store.ts';
import { productionDependencies } from '../../src/api/dependencies.ts';
import type { Dependencies, InterpretationSuccess } from '../../src/api/ports.ts';
import { handleRequest } from '../../src/api/router.ts';
import { AccessIdentityVerifier, accessSettingsFromEnv } from '../../src/auth/access.ts';
import { bundledDataSource } from '../../src/data/index.ts';
import type { Env } from '../../src/env.ts';
import { GeminiInterpreter, type FetchLike } from '../../src/gemini/interpreter.ts';
import { ACCESS_ENV, accessFixture, deskNamespace, DESK_ENV, withToken, type AccessFixture } from '../helpers/durable.ts';

const ENV: Env = { ...DESK_ENV, ...ACCESS_ENV, GEMINI_MODEL: 'gemini-3.5-flash-lite' };
const INVOICE = 'PO-2024-0003';
const REPLY = JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ supportedFindings: [], reviewNeeded: [], discountAuthorization: { status: 'none', noteExcerpt: '' } }) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60, totalTokenCount: 960 },
});
let fx: AccessFixture;
before(async () => { fx = await accessFixture(); });

function setup(status = 200) {
  const desk = deskNamespace({ env: ENV });
  let modelCalls = 0;
  const fetchFn: FetchLike = async () => { modelCalls++; return new Response(status === 200 ? REPLY : '{}', { status }); };
  const composed: InterpretationSuccess[] = [];
  const deps: Dependencies = {
    identity: new AccessIdentityVerifier(accessSettingsFromEnv(ENV), fx.keys),
    allowance: new DurableAllowanceStore(desk.namespace),
    interpreter: new GeminiInterpreter({ apiKey: 'test-key-0001', model: 'gemini-3.5-flash-lite' }, fetchFn),
    composer: { compose: (_d, i) => { composed.push(i); return { outcome: 'no_discrepancy_found', findings: [], provenance: { deterministic: 0, ai: 0, combined: 0 } }; } },
    now: () => new Date(), newReviewId: () => crypto.randomUUID(), log: () => {},
  };
  const env = { ...ENV, DESK: desk.namespace };
  const send = async (token: string | null, body: unknown = { invoiceNo: INVOICE }) =>
    handleRequest(withToken('https://vet.deborahloring.com/api/review', token,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, deps, bundledDataSource());
  const remaining = async (token: string) =>
    (await (await handleRequest(withToken('https://vet.deborahloring.com/api/allowance', token), env, deps, bundledDataSource())).json()).remaining;
  return { send, remaining, modelCalls: () => modelCalls, composed };
}

describe('one Gemini request per review', () => {
  test('each completed review makes exactly one model request', async () => {
    const t = setup();
    const token = await fx.sign();
    for (let k = 1; k <= 3; k++) {
      assert.equal((await t.send(token)).status, 200);
      assert.equal(t.modelCalls(), k);
    }
    assert.equal(t.composed[0]!.usage?.totalTokens, 960);
  });
  test('rejected and over-limit requests make no model request', async () => {
    const t = setup();
    const token = await fx.sign();
    await t.send(null);
    await t.send(token, { invoiceNo: 'PO-2099-0001' });
    await t.send(token, { invoiceNo: INVOICE, comment: 'free text' });
    assert.equal(t.modelCalls(), 0);
    for (let k = 0; k < 3; k++) await t.send(token);
    assert.equal((await t.send(token)).status, 429);
    assert.equal(t.modelCalls(), 3);
  });
  test('a Gemini failure uses exactly one request and keeps the attempt consumed', async () => {
    for (const status of [429, 500]) {
      const t = setup(status);
      const token = await fx.sign();
      const r = await t.send(token);
      assert.equal(r.status, 503);
      assert.equal(t.modelCalls(), 1);
      assert.equal(await t.remaining(token), 2);
    }
  });
});

describe('production wiring', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  async function productionReview(deskOpen: 'true' | 'false') {
    let networkCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      networkCalls++;
      assert.match(String(url), /models\/gemini-3\.5-flash-lite:generateContent$/);
      return new Response(REPLY, { status: 200 });
    }) as typeof fetch;
    const desk = deskNamespace({ env: { ...ENV, DESK_OPEN: deskOpen } });
    const env = { ...ENV, DESK_OPEN: deskOpen, GEMINI_API_KEY: 'test-key-0002', DESK: desk.namespace };
    const production = productionDependencies(env);
    const deps = { ...production, identity: new AccessIdentityVerifier(accessSettingsFromEnv(env), fx.keys) };
    const r = await handleRequest(withToken('https://vet.deborahloring.com/api/review', await fx.sign(),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceNo: INVOICE }) }), env, deps, bundledDataSource());
    return { status: r.status, body: await r.json(), networkCalls, production };
  }
  test('as shipped (DESK_OPEN=false) reviews are closed and nothing is sent', async () => {
    const r = await productionReview('false');
    assert.deepEqual([r.status, r.body.error.code, r.networkCalls], [503, 'review_closed', 0]);
  });
  test('with the desk opened, the full production wiring completes a review with exactly one model request', async () => {
    const r = await productionReview('true');
    assert.ok(r.production.interpreter instanceof GeminiInterpreter && r.production.composer);
    assert.equal(r.status, 200);
    assert.equal(r.networkCalls, 1);
    assert.equal(r.body.staffDecisionRequired, true);
  });
  test('an unapproved model or a missing key leaves the interpreter unset', () => {
    assert.equal(productionDependencies({ ...ENV, GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.5-flash' }).interpreter, null);
    assert.equal(productionDependencies({ ...ENV }).interpreter, null);
  });
});

describe('end to end on a bundled visitor invoice (reply built from its public notes)', () => {
  test('PO-2024-0003: engine, AI and discount evaluation combine into one result', async () => {
    const modelText = JSON.stringify({
      supportedFindings: [
        { type: 'declined_service_billed', section: 'service', lineNumber: 2, code: 'LAB-205', noteExcerpt: 'The owner opted not to proceed with thyroid screening.' },
        { type: 'quantity_documentation_conflict', section: 'service', lineNumber: 4, code: 'VAC-301', noteExcerpt: 'The chart records one rabies vaccination for this visit.' },
      ],
      reviewNeeded: [],
      discountAuthorization: { status: 'courtesy', noteExcerpt: 'A $10 courtesy discount was authorized at checkout.' },
    });
    const reply = JSON.stringify({ candidates: [{ content: { parts: [{ text: modelText }] }, finishReason: 'STOP' }] });
    const desk = deskNamespace({ env: ENV });
    const logs: unknown[] = [];
    const deps: Dependencies = {
      ...productionDependencies({ ...ENV, GEMINI_API_KEY: 'test-key-0003', DESK: desk.namespace }),
      identity: new AccessIdentityVerifier(accessSettingsFromEnv(ENV), fx.keys),
      interpreter: new GeminiInterpreter({ apiKey: 'test-key-0003', model: 'gemini-3.5-flash-lite' }, async () => new Response(reply)),
      log: (e) => logs.push(e),
    };
    const r = await handleRequest(withToken('https://vet.deborahloring.com/api/review', await fx.sign(),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceNo: INVOICE }) }),
      { ...ENV, DESK: desk.namespace }, deps, bundledDataSource());
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.outcome, 'discrepancy_identified');
    assert.deepEqual(body.findings.map((f: { line: { lineNumber: number } | null; ruleRef: string }) => [f.line?.lineNumber ?? 'summary', f.ruleRef]),
      [[1, 'B-04'], [2, 'B-11'], [4, 'B-11'], ['summary', 'B-06']]);
    assert.match(body.findings[3].evidence, /notes document a \$10\.00 courtesy discount, but the invoice shows a discount of \$15\.00/);
    assert.match(body.findings[0].evidence, /^Service line 1 \(LAB-201\)/);
    assert.equal(body.remaining, 2);
    assert.deepEqual((logs.find((e) => (e as { event: string }).event === 'review_completed') as { provenance: object }).provenance,
      { deterministic: 1, ai: 2, combined: 1 });
    assert.ok(!JSON.stringify(body).includes('combined') && !JSON.stringify(body).includes('origin'));
  });
});

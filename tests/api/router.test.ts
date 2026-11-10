// Router behavior with local mocks. Production wiring must stay closed; mocked
// components exercise the ordering and contracts that Steps 3-5 will plug into.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { productionDependencies } from '../../src/api/dependencies.ts';
import { handleRequest, MAX_REVIEW_BODY_BYTES } from '../../src/api/router.ts';
import type {
  AllowanceSnapshot, ComposedReview, Dependencies, IdentityResult, InterpretationInput,
  InterpretationResult, InterpretationSuccess, LogEvent, ReservationResult,
} from '../../src/api/ports.ts';
import type { DeterministicResult } from '../../src/billing/index.ts';
import { bundledDataSource } from '../../src/data/index.ts';
import type { Env } from '../../src/env.ts';

const NOW = new Date('2026-07-15T19:00:00Z'); // noon PDT
const RESET = '2026-07-16T07:00:00.000Z';
const OPEN: Env = { DESK_OPEN: 'true', VISITOR_DAILY_LIMIT: '3', SHARED_DAILY_LIMIT: '50', RECORDING_URL: '' };
const SUBJECT = 'access-subject-123';
const INVOICE = 'PO-2024-0003';

function snapshot(visitorRemaining = 2, sharedRemaining = 40): AllowanceSnapshot {
  return { visitorRemaining, visitorLimit: 3, sharedRemaining, sharedLimit: 50, dayKey: '2026-07-15', resetAt: new Date(RESET) };
}

interface Calls { verify: number; status: number; reserve: string[]; interpret: InterpretationInput[]; compose: [DeterministicResult, InterpretationSuccess][]; logs: LogEvent[] }

function mocks(opts: {
  identity?: IdentityResult | null; reserve?: ReservationResult; interpret?: InterpretationResult | Error;
  compose?: (d: DeterministicResult, a: InterpretationSuccess) => ComposedReview; ready?: boolean;
} = {}): { deps: Dependencies; calls: Calls } {
  const calls: Calls = { verify: 0, status: 0, reserve: [], interpret: [], compose: [], logs: [] };
  const ready = opts.ready ?? true;
  const deps: Dependencies = {
    identity: opts.identity === null ? null : { verify: async () => { calls.verify++; return opts.identity ?? { ok: true, identity: { visitorKey: SUBJECT } }; } },
    allowance: ready ? {
      status: async () => { calls.status++; return snapshot(); },
      reserve: async (_i, id) => { calls.reserve.push(id); return opts.reserve ?? { ok: true, snapshot: snapshot(1, 39) }; },
      pause: async () => true,
    } : null,
    interpreter: ready ? {
      interpret: async (input) => {
        calls.interpret.push(input);
        if (opts.interpret instanceof Error) throw opts.interpret;
        return opts.interpret ?? { ok: true, findings: [], discount: { status: 'none', noteExcerpt: null }, rejected: 0, usage: null };
      },
    } : null,
    composer: ready ? {
      compose: (d, a) => {
        calls.compose.push([d, a]);
        return opts.compose ? opts.compose(d, a) : {
          outcome: d.findings.length ? 'discrepancy_identified' : 'no_discrepancy_found',
          findings: d.findings.map((f) => ({ code: f.line?.code ?? null, line: f.line && { section: f.line.section, lineNumber: f.line.lineNumber },
            ruleRef: f.ruleIds.join('/'), evidence: f.evidence, explanation: 'Staff should review this charge.' })),
          provenance: { deterministic: d.findings.length, ai: a.findings.length, combined: 0 },
        };
      },
    } : null,
    now: () => NOW,
    newReviewId: () => `review-${calls.reserve.length + 1}`,
    log: (e) => calls.logs.push(e),
  };
  return { deps, calls };
}

const get = (path: string) => new Request(`https://vet.deborahloring.com${path}`);
function post(body: string | object, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return new Request('https://vet.deborahloring.com/api/review', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function call(request: Request, deps: Dependencies, env: Env = OPEN) {
  const response = await handleRequest(request, env, deps, bundledDataSource());
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
}

describe('production wiring stays closed', () => {
  const requests = () => [get('/api/allowance'), get('/api/demonstrations'), post({ invoiceNo: INVOICE }), get('/'), get('/api/unknown')];
  for (const env of [OPEN, { ...OPEN, DESK_OPEN: 'false' }]) {
    test(`without Access secrets every route returns 503 service_not_ready with DESK_OPEN=${env.DESK_OPEN}`, async () => {
      for (const request of requests()) {
        const r = await call(request, productionDependencies(env), env);
        assert.equal(r.status, 503, request.url);
        assert.equal(r.body.error.code, 'service_not_ready');
        assert.equal(r.body.demonstrationsAvailable, true);
        assert.equal(r.headers.get('cache-control'), 'no-store');
      }
    });
  }
  test('invalid settings fail closed before identity is checked', async () => {
    for (const env of [{ ...OPEN, DESK_OPEN: 'yes' }, { ...OPEN, VISITOR_DAILY_LIMIT: '4' }, { ...OPEN, SHARED_DAILY_LIMIT: '51' }]) {
      const { deps, calls } = mocks();
      const r = await call(get('/api/allowance'), deps, env);
      assert.equal(r.status, 503);
      assert.equal(calls.verify, 0);
    }
  });
});

describe('identity and routing', () => {
  test('missing or invalid identity is 401; unconfigured verification is 503', async () => {
    for (const [identity, status] of [[{ ok: false, reason: 'missing' }, 401], [{ ok: false, reason: 'invalid' }, 401],
      [{ ok: false, reason: 'not_configured' }, 503]] as const) {
      const { deps, calls } = mocks({ identity });
      const r = await call(post({ invoiceNo: INVOICE }), deps);
      assert.equal(r.status, status);
      assert.equal(calls.reserve.length + calls.interpret.length, 0);
    }
  });
  test('unknown API route is 404 and the wrong method is 405 with Allow', async () => {
    const { deps } = mocks();
    assert.equal((await call(get('/api/other'), deps)).status, 404);
    const r = await call(post({ invoiceNo: INVOICE }, { 'content-type': 'application/json' }), deps);
    assert.equal(r.status, 200);
    const wrong = await call(new Request('https://vet.deborahloring.com/api/allowance', { method: 'POST' }), deps);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
    assert.equal((await call(get('/api/review'), deps)).headers.get('allow'), 'POST');
  });
  test('non-API paths go to static assets only after identity, and only for GET/HEAD', async () => {
    const { deps } = mocks();
    assert.equal((await call(get('/'), deps)).status, 404, 'no ASSETS binding yet');
    let served = 0;
    const env = { ...OPEN, ASSETS: { fetch: async () => { served++; return new Response('kiosk'); } } };
    assert.equal((await handleRequest(get('/'), env, deps)).status, 200);
    assert.equal(served, 1);
  });
});

describe('GET /api/allowance', () => {
  test('returns the lower of visitor and shared remaining, the visitor limit, and the next Pacific midnight', async () => {
    const { deps, calls } = mocks();
    const r = await call(get('/api/allowance'), deps);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { remaining: 2, limit: 3, resetAt: RESET, timeZone: 'America/Los_Angeles', limitedBy: null });
    assert.equal(calls.status, 1);
    assert.equal(calls.reserve.length + calls.interpret.length, 0, 'read-only: no reservation, no model call');
  });
  test('without a usage-limit store it is 503, not an invented number', async () => {
    const { deps } = mocks({ ready: false });
    const r = await call(get('/api/allowance'), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_not_ready');
  });
});

describe('GET /api/demonstrations', () => {
  test('lists prerecorded demonstrations without touching allowance or the model', async () => {
    const { deps, calls } = mocks({ ready: false });
    const r = await call(get('/api/demonstrations'), deps);
    assert.equal(r.status, 200);
    assert.equal(r.body.consumesReviewAllowance, false);
    assert.equal(r.body.demonstrations.length, 9);
    for (const d of r.body.demonstrations) {
      assert.deepEqual(Object.keys(d).sort(), ['id', 'invoiceNo', 'provisional', 'result', 'title']);
      for (const f of d.result.findings) assert.deepEqual(Object.keys(f).sort(), ['code', 'evidence', 'explanation', 'line', 'ruleRef']);
    }
    assert.ok(!r.text.includes('origin') && !r.text.includes('provenance'));
    assert.equal(calls.reserve.length + calls.interpret.length + calls.status, 0);
  });
});

describe('POST /api/review gates', () => {
  test('closed (503) until usage limits, interpretation and composition all exist', async () => {
    const { deps, calls } = mocks({ ready: false });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_not_ready');
    assert.equal(calls.reserve.length, 0);
  });
  test('DESK_OPEN=false closes reviews without reserving', async () => {
    const { deps, calls } = mocks();
    const r = await call(post({ invoiceNo: INVOICE }), deps, { ...OPEN, DESK_OPEN: 'false' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'review_closed');
    assert.equal(calls.reserve.length, 0);
  });
});

describe('POST /api/review input validation (nothing reserved, no model call)', () => {
  const cases: [string, Request, number, string][] = [
    ['form content type', post({ invoiceNo: INVOICE }, { 'content-type': 'text/plain' }), 415, 'unsupported_media_type'],
    ['oversized body', post(JSON.stringify({ invoiceNo: INVOICE, pad: 'x'.repeat(MAX_REVIEW_BODY_BYTES) })), 413, 'payload_too_large'],
    ['malformed JSON', post('{"invoiceNo":'), 400, 'invalid_request'],
    ['free text alongside the invoice', post({ invoiceNo: INVOICE, question: 'Why so expensive?' }), 400, 'invalid_request'],
    ['array body', post([INVOICE]), 400, 'invalid_request'],
    ['wrong identifier format', post({ invoiceNo: 'PO-24-3' }), 400, 'invalid_request'],
    ['non-string identifier', post({ invoiceNo: 20240003 }), 400, 'invalid_request'],
    ['real dataset invoice that is not allowlisted', post({ invoiceNo: 'PO-2022-0007' }), 404, 'unknown_invoice'],
    ['well-formed unknown invoice', post({ invoiceNo: 'PO-2099-9999' }), 404, 'unknown_invoice'],
  ];
  for (const [label, request, status, code] of cases) {
    test(label, async () => {
      const { deps, calls } = mocks();
      const r = await call(request, deps);
      assert.equal(r.status, status);
      assert.equal(r.body.error.code, code);
      assert.equal(calls.reserve.length + calls.interpret.length, 0);
    });
  }
});

describe('POST /api/review allowance and interruption', () => {
  test('daily limit reached: 429 and zero model calls', async () => {
    for (const reason of ['visitor_limit', 'shared_limit'] as const) {
      const { deps, calls } = mocks({ reserve: { ok: false, reason } });
      const r = await call(post({ invoiceNo: INVOICE }), deps);
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, 'daily_limit_reached');
      assert.equal(r.body.demonstrationsAvailable, true);
      assert.equal(calls.interpret.length, 0);
    }
  });
  test('allowance store unavailable: 503 service_interrupted and zero model calls', async () => {
    const { deps, calls } = mocks({ reserve: { ok: false, reason: 'unavailable' } });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_interrupted');
    assert.equal(calls.interpret.length, 0);
  });
  test('provider error: the log records Google\'s status for diagnosis, the visitor response does not', async () => {
    const { deps, calls } = mocks({ interpret: { ok: false, reason: 'provider_error', providerStatus: 503, providerCode: 'UNAVAILABLE' } });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_interrupted');
    assert.ok(!JSON.stringify(r.body).includes('UNAVAILABLE'));
    const logged = calls.logs.find((e) => e.event === 'interpretation_failed')!;
    assert.deepEqual([logged.reason, logged.providerStatus, logged.providerCode], ['provider_error', 503, 'UNAVAILABLE']);
  });
  test('interpretation failure: 503 service_interrupted after exactly one reservation and one call', async () => {
    const { deps, calls } = mocks({ interpret: { ok: false, reason: 'provider_error' } });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'service_interrupted');
    assert.equal(calls.reserve.length, 1);
    assert.equal(calls.interpret.length, 1);
    assert.equal(calls.compose.length, 0);
  });
  test('unexpected exception: 500 with no internal detail', async () => {
    const { deps } = mocks({ interpret: new Error(`secret detail ${SUBJECT}`) });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'internal_error');
    assert.ok(!r.text.includes('secret') && !r.text.includes(SUBJECT));
  });
});

describe('POST /api/review success contract', () => {
  test('runs the deterministic engine on bundled data and returns one public result', async () => {
    const { deps, calls } = mocks();
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['findings', 'invoiceNo', 'outcome', 'remaining', 'resetAt', 'staffDecisionRequired']);
    assert.equal(r.body.invoiceNo, INVOICE);
    assert.equal(r.body.staffDecisionRequired, true);
    assert.equal(r.body.remaining, 1);
    assert.equal(r.body.resetAt, RESET);
    // Interpretation receives the documentary evidence and the deterministic result, not dataset metadata.
    const input = calls.interpret[0]!;
    assert.equal(input.invoiceNo, INVOICE);
    assert.ok(input.document.visitNotes.length > 0);
    assert.ok(!('discount_type' in input.document) && !('discountType' in input.deterministic));
    const types = input.deterministic.findings.map((f) => f.type);
    assert.deepEqual(types, ['line_arithmetic', 'discount_arithmetic']);
    for (const finding of r.body.findings) {
      assert.deepEqual(Object.keys(finding).sort(), ['code', 'evidence', 'explanation', 'line', 'ruleRef']);
    }
  });
  test('internal provenance is logged but never returned, and identity is never logged or returned', async () => {
    const { deps, calls } = mocks({
      compose: () => ({
        outcome: 'discrepancy_identified',
        findings: [{ code: 'LAB-201', line: { section: 'service', lineNumber: 1 }, ruleRef: 'B-04', evidence: 'e', explanation: 'x',
          origin: 'deterministic', confidence: 0.9 } as never],
        provenance: { deterministic: 1, ai: 0, combined: 0 },
      }),
    });
    const r = await call(post({ invoiceNo: INVOICE }), deps);
    assert.equal(r.status, 200);
    for (const leaked of ['origin', 'deterministic', 'provenance', 'confidence', SUBJECT]) assert.ok(!r.text.includes(leaked), leaked);
    const logged = calls.logs.find((e) => e.event === 'review_completed')!;
    assert.deepEqual(logged.provenance, { deterministic: 1, ai: 0, combined: 0 });
    assert.ok(!JSON.stringify(calls.logs).includes(SUBJECT));
  });
  test('an invalid outcome from composition is refused', async () => {
    const { deps } = mocks({ compose: () => ({ outcome: 'approved' as never, findings: [], provenance: { deterministic: 0, ai: 0, combined: 0 } }) });
    assert.equal((await call(post({ invoiceNo: INVOICE }), deps)).status, 500);
  });
  test('each attempt gets its own reservation id', async () => {
    const { deps, calls } = mocks();
    await call(post({ invoiceNo: INVOICE }), deps);
    await call(post({ invoiceNo: INVOICE }), deps);
    assert.deepEqual(calls.reserve, ['review-1', 'review-2']);
  });
});

// Evaluation runner: public data only, no answer key, no network (live mode uses a mocked fetch).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { MAX_LIVE_REQUESTS, REPO, runEvaluation } from '../../scripts/eval/run-eval.ts';

const temps: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'eval-')); temps.push(d); return d; };
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env['PAWS_EVAL_LIVE_AUTHORIZED']; });
const quiet = () => {};

// Built from PO-2024-0003's public notes (as in the provisional demonstration).
const MODEL_TEXT = JSON.stringify({
  supportedFindings: [
    { type: 'declined_service_billed', section: 'service', lineNumber: 2, code: 'LAB-205', noteExcerpt: 'The owner opted not to proceed with thyroid screening.' },
    { type: 'quantity_documentation_conflict', section: 'service', lineNumber: 4, code: 'VAC-301', noteExcerpt: 'The chart records one rabies vaccination for this visit.' },
  ],
  reviewNeeded: [],
  discountAuthorization: { status: 'courtesy', noteExcerpt: 'A $10 courtesy discount was authorized at checkout.' },
});

describe('deterministic mode', () => {
  test('engine-only predictions in answer-key vocabulary, with reproducibility metadata', async () => {
    const out = join(temp(), 'p.json');
    const r = await runEvaluation({ mode: 'deterministic', invoices: ['PO-2024-0003', 'PO-2022-0210'], out, log: quiet });
    assert.equal(r.meta.requests, 0);
    assert.match(r.meta.datasetSha256, /^[0-9a-f]{64}$/);
    const [a, b] = r.predictions;
    assert.equal(a!.outcome, 'discrepancy_identified');
    assert.deepEqual(a!.findings.map((f) => [f.type, f.section, f.line, f.ruleIds]),
      [['line_arithmetic', 'service', 1, ['B-04']], ['discount_arithmetic', 'summary', null, ['B-06', 'B-07']]]);
    assert.equal(b!.outcome, 'no_discrepancy');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).meta, r.meta);
  });
});

describe('replay mode', () => {
  test('a stored model reply replays through the live checker and composer, with an AI-only view', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'PO-2024-0003.json'), JSON.stringify({ invoiceNo: 'PO-2024-0003', modelText: MODEL_TEXT, usage: { promptTokens: 1, outputTokens: 2, totalTokens: 3 } }));
    const r = await runEvaluation({ mode: 'replay', invoices: ['PO-2024-0003', 'PO-2022-0210'], recordings: dir, out: join(dir, 'p.json'), log: quiet });
    const p = r.predictions[0]!;
    assert.equal(p.status, 'ok');
    assert.deepEqual(p.findings.map((f) => [f.type, f.origin, f.line ?? 'summary', f.ruleIds.join('/')]), [
      ['line_arithmetic', 'deterministic', 1, 'B-04'], ['declined_service_billed', 'ai', 2, 'B-11'],
      ['quantity_documentation_conflict', 'ai', 4, 'B-11'], ['discount_arithmetic', 'combined', 'summary', 'B-06']]);
    assert.equal(p.findings[1]!.noteExcerpt, 'The owner opted not to proceed with thyroid screening.');
    assert.deepEqual(p.aiOnly!.findings.map((f) => f.type), ['declined_service_billed', 'quantity_documentation_conflict']);
    assert.equal(r.predictions[1]!.status, 'failed');
    assert.equal(r.predictions[1]!.reason, 'no_recording');
    assert.equal(r.meta.totalTokens, 3);
  });
  test('an invalid stored reply is a failed prediction, not a crash', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'PO-2024-0003.json'), JSON.stringify({ modelText: 'not json' }));
    const r = await runEvaluation({ mode: 'replay', invoices: ['PO-2024-0003'], recordings: dir, out: join(dir, 'p.json'), log: quiet });
    assert.deepEqual([r.predictions[0]!.status, r.predictions[0]!.reason], ['failed', 'invalid_output']);
  });
});

describe('live mode (mocked fetch)', () => {
  const reply = () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: MODEL_TEXT }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 120, totalTokenCount: 1220 },
  }));
  test('exactly one request per invoice, paced, every reply saved for replay', async () => {
    process.env['PAWS_EVAL_LIVE_AUTHORIZED'] = 'yes';
    const dir = temp();
    let calls = 0;
    const sleeps: number[] = [];
    const r = await runEvaluation({ mode: 'live', invoices: ['PO-2024-0003', 'PO-2022-0210'], recordings: dir, out: join(dir, 'p.json'),
      apiKey: 'test-key', fetchFn: async () => { calls++; return reply(); }, sleep: async (ms) => { sleeps.push(ms); }, log: quiet });
    assert.equal(calls, 2);
    assert.equal(r.meta.requests, 2);
    assert.deepEqual(sleeps, [7500], 'paced at 8 requests per minute');
    assert.ok(existsSync(join(dir, 'PO-2024-0003.json')) && existsSync(join(dir, 'PO-2022-0210.json')));
    const replayed = await runEvaluation({ mode: 'replay', invoices: ['PO-2024-0003'], recordings: dir, out: join(dir, 'r.json'), log: quiet });
    assert.deepEqual(replayed.predictions[0]!.findings, r.predictions[0]!.findings, 'a live run can be replayed exactly');
    assert.ok(!readFileSync(join(dir, 'PO-2024-0003.json'), 'utf8').includes('test-key'));
  });
  test('a quota refusal stops the run at once, keeps completed work and lists unsent invoices', async () => {
    process.env['PAWS_EVAL_LIVE_AUTHORIZED'] = 'yes';
    const dir = temp();
    const out = join(dir, 'p.json');
    let calls = 0;
    const r = await runEvaluation({ mode: 'live', invoices: ['PO-2024-0003', 'PO-2022-0210', 'PO-2025-0006', 'PO-2022-0012'], recordings: dir, out,
      maxRequests: 4, apiKey: 'test-key', sleep: async () => {}, log: quiet,
      fetchFn: async () => (++calls === 2 ? new Response('{"error":{"code":429}}', { status: 429 }) : reply()) });
    assert.equal(calls, 2, 'nothing is sent after the refusal');
    assert.equal(r.meta.status, 'stopped');
    assert.deepEqual(r.meta.stopped, { reason: 'quota', atInvoice: 'PO-2022-0210', unsent: ['PO-2025-0006', 'PO-2022-0012'] });
    assert.deepEqual(r.predictions.map((p) => [p.invoiceNo, p.status]), [['PO-2024-0003', 'ok'], ['PO-2022-0210', 'failed']]);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).meta.stopped, r.meta.stopped, 'saved to disk');
  });
  test('progress is checkpointed after every invoice', async () => {
    process.env['PAWS_EVAL_LIVE_AUTHORIZED'] = 'yes';
    const dir = temp();
    const out = join(dir, 'p.json');
    const seen: string[] = [];
    const r = await runEvaluation({ mode: 'live', invoices: ['PO-2024-0003', 'PO-2022-0210'], recordings: dir, out, apiKey: 'test-key', log: quiet,
      fetchFn: async () => reply(),
      sleep: async () => { const m = JSON.parse(readFileSync(out, 'utf8')).meta; seen.push(`${m.status}:${m.invoices}`); } });
    assert.deepEqual(seen, ['in_progress:1'], 'the first result is on disk before the second request');
    assert.equal(r.meta.status, 'complete');
    assert.equal(r.meta.stopped, null);
  });
  test('guards: authorization, key, recordings, request cap, outputs outside the repository', async () => {
    const dir = temp();
    const base = { mode: 'live' as const, invoices: ['PO-2024-0003'], recordings: dir, out: join(dir, 'p.json'), apiKey: 'k', log: quiet };
    await assert.rejects(runEvaluation(base), /PAWS_EVAL_LIVE_AUTHORIZED/);
    process.env['PAWS_EVAL_LIVE_AUTHORIZED'] = 'yes';
    await assert.rejects(runEvaluation({ ...base, apiKey: '' }), /GEMINI_API_KEY/);
    await assert.rejects(runEvaluation({ ...base, recordings: undefined }), /--recordings/);
    await assert.rejects(runEvaluation({ ...base, invoices: ['PO-2024-0003', 'PO-2022-0210'], maxRequests: 1 }), /exceed --max-requests/);
    await assert.rejects(runEvaluation({ mode: 'deterministic', invoices: ['PO-2024-0003'], out: join(REPO, 'tmp', 'p.json'), log: quiet }), /outside the repository/);
    assert.ok(MAX_LIVE_REQUESTS < 500, 'never more than the free-tier daily request limit in one run');
  });
  test('the runner never reads the private answer key', () => {
    const source = readFileSync(join(REPO, 'scripts', 'eval', 'run-eval.ts'), 'utf8');
    assert.doesNotMatch(source, /expected_reviews|expected_findings|PAWS_PRIVATE_DATA_DIR/);
  });
});

// Milestone 5 evaluation runner: produces predictions for a set of invoices. Never reads the
// private answer key; scoring happens separately in scripts/eval/score.py.
//
// Modes
//   deterministic  billing engine only (no model)
//   replay         stored model replies from --recordings (reproducible, no network)
//   live           one real Gemini request per invoice. OWNER AUTHORIZATION REQUIRED:
//                  needs --live, PAWS_EVAL_LIVE_AUTHORIZED=yes and GEMINI_API_KEY in the session.
//                  Paced at 8 requests/minute by default (never faster than 10/minute), capped by --max-requests, no retries; every
//                  raw reply is saved to --recordings so the run can be replayed and re-scored.
//
// Invoice selection: --invoices PO-... | --manifest <allocation.json> --split development|blind|visitor
// Output: --out <predictions.json> (must be outside the repository)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { AiFinding, InterpretationSuccess } from '../../src/api/ports.ts';
import { buildCatalog, ENGINE_VERSION, validateInvoice, type Catalog, type DeterministicResult } from '../../src/billing/index.ts';
import { composeReview } from '../../src/compose/composer.ts';
import { GeminiInterpreter } from '../../src/gemini/interpreter.ts';
import { APPROVED_GEMINI_MODELS } from '../../src/gemini/model.ts';
import { InvalidModelOutput, parseModelJson, validateInterpretation } from '../../src/gemini/parse.ts';
import { RESPONSE_SCHEMA, SYSTEM_INSTRUCTION } from '../../src/gemini/prompt.ts';
import { loadPublicDataset, type PublicRecord } from '../lib/dataset.ts';
import { loadGeminiKey } from '../lib/gemini-key.ts';

export const REPO = resolve(import.meta.dirname, '..', '..');
export const MAX_LIVE_REQUESTS = 400; // stays well under the 500 requests/day free-tier limit
/** 7.5 s between requests: at most 8 per minute, about half of the 15/minute free-tier limit. */
export const DEFAULT_PACE_MS = 7_500;
const OUTCOME = { no_discrepancy_found: 'no_discrepancy', discrepancy_identified: 'discrepancy_identified', staff_review_required: 'staff_review_required' } as const;

export type Mode = 'deterministic' | 'replay' | 'live';

export interface PredictedFinding {
  type: string;
  origin: 'deterministic' | 'ai' | 'combined';
  disposition: 'discrepancy' | 'staff_review';
  section: 'service' | 'product' | 'summary';
  line: number | null;
  secondaryLine: number | null;
  code: string | null;
  ruleIds: string[];
  noteExcerpt: string | null;
}

export interface Prediction {
  invoiceNo: string;
  status: 'ok' | 'failed';
  reason?: string;
  /** Answer-key vocabulary: no_discrepancy | discrepancy_identified | staff_review_required. */
  outcome: string | null;
  findings: PredictedFinding[];
  /** The model's findings alone (AI-only evaluation, docs/06). Absent in deterministic mode. */
  aiOnly: { outcome: string; findings: PredictedFinding[] } | null;
  rejected: number;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number } | null;
}

export interface RunOptions {
  mode: Mode;
  invoices: string[];
  recordings?: string;
  out: string;
  maxRequests?: number;
  paceMs?: number;
  apiKey?: string;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

function insideRepo(path: string): boolean {
  const p = resolve(path);
  return p === REPO || p.startsWith(REPO + sep);
}

function outcomeOf(findings: { disposition: string }[]): string {
  return findings.some((f) => f.disposition === 'staff_review') ? 'staff_review_required'
    : findings.length ? 'discrepancy_identified' : 'no_discrepancy';
}

function fromAi(f: AiFinding): PredictedFinding {
  return { type: f.type, origin: 'ai', disposition: f.disposition, section: f.line.section, line: f.line.lineNumber,
    secondaryLine: f.secondaryLine?.lineNumber ?? null, code: f.line.code, ruleIds: [...f.ruleIds], noteExcerpt: f.noteExcerpt };
}

function deterministicOnly(det: DeterministicResult): PredictedFinding[] {
  return det.findings.map((f) => ({
    type: f.type, origin: 'deterministic', disposition: f.disposition === 'staff_review' ? 'staff_review' : 'discrepancy',
    section: f.line?.section ?? 'summary', line: f.line?.lineNumber ?? null, secondaryLine: null, code: f.line?.code ?? null,
    ruleIds: [...f.ruleIds], noteExcerpt: null,
  }));
}

function integrated(det: DeterministicResult, interp: InterpretationSuccess): { outcome: string; findings: PredictedFinding[] } {
  const composed = composeReview(det, interp);
  return {
    outcome: OUTCOME[composed.outcome],
    findings: composed.internal.map((f) => ({
      type: f.kind, origin: f.origin, disposition: f.disposition, section: f.line?.section ?? 'summary', line: f.line?.lineNumber ?? null,
      secondaryLine: f.secondaryLine?.lineNumber ?? null, code: f.code, ruleIds: [...f.ruleIds], noteExcerpt: f.noteExcerpt ?? null,
    })),
  };
}

function predictFromModelText(record: PublicRecord, det: DeterministicResult, modelText: string,
  usage: Prediction['usage']): Prediction {
  const checked = validateInterpretation(parseModelJson(modelText), record.invoice, record.document.visitNotes);
  const interp: InterpretationSuccess = { ok: true, ...checked, usage };
  const ai = checked.findings.map(fromAi);
  const combined = integrated(det, interp);
  return { invoiceNo: record.invoice.invoiceNo, status: 'ok', outcome: combined.outcome, findings: combined.findings,
    aiOnly: { outcome: outcomeOf(ai), findings: ai }, rejected: checked.rejected, usage };
}

function failed(invoiceNo: string, reason: string): Prediction {
  return { invoiceNo, status: 'failed', reason, outcome: null, findings: [], aiOnly: null, rejected: 0, usage: null };
}

export async function runEvaluation(options: RunOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  if (insideRepo(options.out)) throw new Error('run-eval: --out must be outside the repository');
  if (options.recordings && insideRepo(options.recordings)) throw new Error('run-eval: --recordings must be outside the repository');
  if (options.mode === 'live') {
    if (process.env['PAWS_EVAL_LIVE_AUTHORIZED'] !== 'yes') throw new Error('run-eval: live mode needs PAWS_EVAL_LIVE_AUTHORIZED=yes (owner authorization)');
    if (!options.apiKey) throw new Error('run-eval: live mode needs GEMINI_API_KEY in this session');
    if (!options.recordings) throw new Error('run-eval: live mode needs --recordings to save replies');
  }
  if (options.mode === 'replay' && !options.recordings) throw new Error('run-eval: replay mode needs --recordings');
  const maxRequests = Math.min(options.maxRequests ?? 50, MAX_LIVE_REQUESTS);
  if (options.mode === 'live' && options.invoices.length > maxRequests) {
    throw new Error(`run-eval: ${options.invoices.length} invoices exceed --max-requests ${maxRequests}`);
  }

  const dataset = loadPublicDataset(REPO);
  const catalog: Catalog = buildCatalog(dataset.catalog);
  const predictions: Prediction[] = [];
  let requests = 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const model = APPROVED_GEMINI_MODELS[0];
  let lastText = '';
  const interpreter = options.mode === 'live'
    ? new GeminiInterpreter({ apiKey: options.apiKey!, model, onModelText: (_no, text) => { lastText = text; } },
      (url, init) => { requests++; return (options.fetchFn ?? fetch)(url, init); })
    : null;
  if (options.recordings) mkdirSync(options.recordings, { recursive: true });
  mkdirSync(dirname(resolve(options.out)), { recursive: true });

  // Output is rewritten after every invoice (status "in_progress"), so an interruption keeps all completed work.
  // A quota refusal stops the run at once: no retry, resume or restart; the unsent invoices are listed.
  let stopped: { reason: string; atInvoice: string; unsent: string[] } | null = null;
  const save = (status: 'in_progress' | 'complete' | 'stopped') => {
    const tokens = predictions.reduce((sum, p) => sum + (p.usage?.totalTokens ?? 0), 0);
    const output = {
      meta: {
        mode: options.mode, model: options.mode === 'deterministic' ? null : model, engineVersion: ENGINE_VERSION,
        datasetSha256: dataset.sha256,
        promptSha256: createHash('sha256').update(SYSTEM_INSTRUCTION).update(JSON.stringify(RESPONSE_SCHEMA)).digest('hex'),
        status, stopped, planned: options.invoices.length,
        invoices: predictions.length, failed: predictions.filter((p) => p.status === 'failed').length,
        requests, totalTokens: tokens,
      },
      predictions,
    };
    writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  };

  for (const [index, invoiceNo] of options.invoices.entries()) {
    const record = dataset.records.get(invoiceNo);
    if (!record) throw new Error(`run-eval: unknown invoice ${invoiceNo}`);
    const det = validateInvoice(record.invoice, catalog);
    if (options.mode === 'deterministic') {
      const findings = deterministicOnly(det);
      predictions.push({ invoiceNo, status: 'ok', outcome: outcomeOf(findings), findings, aiOnly: null, rejected: 0, usage: null });
      continue;
    }
    const file = join(options.recordings!, `${invoiceNo}.json`);
    if (options.mode === 'replay') {
      if (!existsSync(file)) { predictions.push(failed(invoiceNo, 'no_recording')); continue; }
      const recording = JSON.parse(readFileSync(file, 'utf8')) as { modelText: string; usage?: Prediction['usage'] };
      try {
        predictions.push(predictFromModelText(record, det, recording.modelText, recording.usage ?? null));
      } catch (e) {
        if (e instanceof InvalidModelOutput) predictions.push(failed(invoiceNo, 'invalid_output'));
        else throw e;
      }
      continue;
    }
    // live: exactly one request, paced, no retry
    if (index > 0) await sleep(Math.max(options.paceMs ?? DEFAULT_PACE_MS, 6_000));
    lastText = '';
    const result = await interpreter!.interpret({ invoiceNo, invoice: record.invoice, document: record.document, deterministic: det });
    if (lastText) writeFileSync(file, `${JSON.stringify({ invoiceNo, model, recordedAt: new Date().toISOString(), modelText: lastText,
      usage: result.ok ? result.usage : null }, null, 2)}\n`);
    if (!result.ok) {
      predictions.push(failed(invoiceNo, result.reason));
      log(`${invoiceNo}: failed (${result.reason})`);
      if (result.reason === 'quota') {
        stopped = { reason: 'quota', atInvoice: invoiceNo, unsent: options.invoices.slice(index + 1) };
        log(`STOPPED: Gemini quota refusal at ${invoiceNo}. ${stopped.unsent.length} invoices were not sent. No retry.`);
        break;
      }
      save('in_progress');
      continue;
    }
    const ai = result.findings.map(fromAi);
    const combined = integrated(det, result);
    predictions.push({ invoiceNo, status: 'ok', outcome: combined.outcome, findings: combined.findings,
      aiOnly: { outcome: outcomeOf(ai), findings: ai }, rejected: result.rejected, usage: result.usage });
    log(`[${index + 1}/${options.invoices.length}] ${invoiceNo}: ${combined.outcome} (${combined.findings.length} findings)`);
    save('in_progress');
  }

  return save(stopped ? 'stopped' : 'complete');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const mode = (process.argv.includes('--live') ? 'live' : arg('--mode') ?? 'deterministic') as Mode;
  let invoices: string[] = [];
  const list = arg('--invoices');
  if (list) invoices = list.split(',').map((s) => s.trim()).filter(Boolean);
  const manifest = arg('--manifest');
  if (manifest) {
    const split = arg('--split');
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (!split || !Array.isArray(data[split])) throw new Error('run-eval: --split must name a list in the manifest');
    invoices = data[split] as string[];
  }
  if (!invoices.length || !arg('--out')) {
    console.log('Usage: node scripts/eval/run-eval.ts --mode deterministic|replay [--live] (--invoices A,B | --manifest M --split S) '
      + '--out FILE [--recordings DIR] [--max-requests N]');
    process.exit(2);
  }
  const result = await runEvaluation({ mode, invoices, out: arg('--out')!, recordings: arg('--recordings'),
    maxRequests: arg('--max-requests') ? Number(arg('--max-requests')) : undefined, apiKey: loadGeminiKey(process.argv.includes('--key-from-deploy-vars')) });
  console.log(`Wrote ${result.meta.invoices} predictions (${result.meta.failed} failed, ${result.meta.requests} model requests) to ${arg('--out')}`);
}

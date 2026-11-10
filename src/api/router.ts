// Request routing and the three planned API routes.
//
// Order for every request: settings -> identity -> route/method -> handler.
// Review order: readiness -> desk open -> input -> allowlist -> reservation ->
// deterministic engine -> interpretation -> unified response. Nothing is reserved or
// sent to the model until the request is authenticated and fully valid.

import { InvoiceInputError, validateInvoice } from '../billing/index.ts';
import { bundledDataSource, type ReviewDataSource } from '../data/index.ts';
import type { Env } from '../env.ts';
import { ConfigError, parseConfig, type WorkerConfig } from './config.ts';
import type {
  AllowanceResponse, DemonstrationsResponse, ErrorCode, PublicFinding, ReviewOutcome, ReviewResponse,
} from './contracts.ts';
import { error, json } from './http.ts';
import { nextPacificMidnight, PACIFIC_TIME_ZONE } from './pacific-time.ts';
import type { ComposedReview, Dependencies, VisitorIdentity } from './ports.ts';

export const MAX_REVIEW_BODY_BYTES = 256;
const INVOICE_ID = /^PO-\d{4}-\d{4}$/;
const OUTCOMES: readonly ReviewOutcome[] = ['no_discrepancy_found', 'discrepancy_identified', 'staff_review_required'];
const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/api/allowance': 'GET',
  '/api/review': 'POST',
  '/api/demonstrations': 'GET',
};

export async function handleRequest(
  request: Request, env: Env, deps: Dependencies, data: ReviewDataSource = bundledDataSource(),
): Promise<Response> {
  const route = new URL(request.url).pathname;
  const respond = (status: number, code: ErrorCode, message: string, headers?: Record<string, string>) => {
    deps.log({ event: 'request_refused', route, status, code });
    return error(status, code, message, headers);
  };
  try {
    let config: WorkerConfig;
    try {
      config = parseConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) return respond(503, 'service_not_ready', 'The service is not configured.');
      throw e;
    }

    // Identity is required for every path, including static assets.
    if (!deps.identity) return respond(503, 'service_not_ready', 'Sign-in verification is not available yet.');
    const verified = await deps.identity.verify(request);
    if (!verified.ok) {
      switch (verified.reason) {
        case 'missing':
        case 'invalid':
          return respond(401, 'authentication_required', 'Please sign in to use the terminal.');
        case 'forbidden':
          return respond(403, 'access_denied', 'This sign-in does not have access to the terminal.');
        case 'unavailable':
          return respond(503, 'service_interrupted', 'Sign-in could not be checked right now. Please try again shortly.');
        default:
          return respond(503, 'service_not_ready', 'Sign-in verification is not available yet.');
      }
    }

    if (!route.startsWith('/api/')) {
      if (!env.ASSETS || (request.method !== 'GET' && request.method !== 'HEAD')) return respond(404, 'not_found', 'Not found.');
      return withAssetHeaders(await env.ASSETS.fetch(request));
    }
    const method = ROUTES[route];
    if (!method) return respond(404, 'not_found', 'Not found.');
    if (request.method !== method) return respond(405, 'method_not_allowed', `Use ${method}.`, { allow: method });

    if (route === '/api/allowance') return await allowance(config, verified.identity, deps, respond);
    if (route === '/api/demonstrations') return demonstrations(data);
    return await review(request, config, verified.identity, deps, data, respond);
  } catch (e) {
    deps.log({ event: 'internal_error', route, status: 500, code: e instanceof Error ? e.name : 'unknown' });
    return error(500, 'internal_error', 'Something went wrong. Demonstrations remain available.');
  }
}

async function allowance(
  config: WorkerConfig, identity: VisitorIdentity, deps: Dependencies,
  respond: (status: number, code: ErrorCode, message: string) => Response,
): Promise<Response> {
  if (!deps.allowance) return respond(503, 'service_not_ready', 'Review allowances are not available yet.');
  const snapshot = await deps.allowance.status(identity);
  if (!snapshot) return respond(503, 'service_interrupted', 'Review allowances are unavailable right now.');
  const body: AllowanceResponse = {
    remaining: clamp(Math.min(snapshot.visitorRemaining, snapshot.sharedRemaining), config.visitorDailyLimit),
    limit: config.visitorDailyLimit,
    resetAt: snapshot.resetAt.toISOString(),
    timeZone: PACIFIC_TIME_ZONE,
    limitedBy: snapshot.visitorRemaining <= 0 ? 'visitor' : snapshot.sharedRemaining <= 0 ? 'shared' : null,
  };
  return json(200, body);
}

function demonstrations(data: ReviewDataSource): Response {
  const body: DemonstrationsResponse = {
    demonstrations: data.demonstrations.map((d) => ({
      id: d.id, title: d.title, invoiceNo: d.invoiceNo, provisional: d.provisional,
      result: { outcome: d.result.outcome, findings: d.result.findings.map(toPublicFinding) },
    })),
    consumesReviewAllowance: false,
  };
  return json(200, body);
}

async function review(
  request: Request, config: WorkerConfig, identity: VisitorIdentity, deps: Dependencies, data: ReviewDataSource,
  respond: (status: number, code: ErrorCode, message: string, headers?: Record<string, string>) => Response,
): Promise<Response> {
  const route = '/api/review';
  // Closed until usage limits, interpretation and the unified response all exist.
  if (!deps.allowance || !deps.interpreter || !deps.composer) {
    return respond(503, 'service_not_ready', 'Live reviews are not available yet.');
  }
  if (!config.deskOpen) return respond(503, 'review_closed', 'Live reviews are closed right now.');

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) return respond(415, 'unsupported_media_type', 'Send JSON.');
  const raw = await readLimited(request, MAX_REVIEW_BODY_BYTES);
  if (raw === null) return respond(413, 'payload_too_large', 'Request is too large.');
  const invoiceNo = parseReviewRequest(raw);
  if (!invoiceNo) return respond(400, 'invalid_request', 'Choose an invoice from the terminal.');
  const record = data.findInvoice(invoiceNo);
  if (!record) return respond(404, 'unknown_invoice', 'That invoice is not available for review.');

  // Every check that can reject the request has passed; only now is an attempt consumed.
  const reservation = await deps.allowance.reserve(identity, deps.newReviewId());
  if (!reservation.ok) {
    switch (reservation.reason) {
      case 'paused':
        return respond(503, 'live_reviews_paused', 'Live reviews are paused right now. No review was used. Demonstrations remain available.');
      case 'busy':
        return respond(503, 'terminal_busy',
          `The terminal is busy. Please try again in ${reservation.retryAfterSeconds} seconds. No review was used.`,
          { 'retry-after': String(reservation.retryAfterSeconds) });
      case 'visitor_limit':
        return respond(429, 'daily_limit_reached', 'You have used today\'s live reviews. Demonstrations remain available.');
      case 'shared_limit':
        return respond(429, 'daily_limit_reached', 'All of today\'s shared live reviews have been used. Demonstrations remain available.');
      default:
        return respond(503, 'service_interrupted', 'Live reviews are interrupted. Demonstrations remain available.');
    }
  }

  let deterministic;
  try {
    deterministic = validateInvoice(record.invoice, data.catalog);
  } catch (e) {
    if (e instanceof InvoiceInputError) return respond(500, 'internal_error', 'This invoice could not be reviewed.');
    throw e;
  }
  const interpretation = await deps.interpreter.interpret({ invoiceNo, invoice: record.invoice, document: record.document, deterministic });
  if (!interpretation.ok && interpretation.reason === 'quota') {
    // Gemini refused for quota. Pause new live reviews (refused before reservation) so later visitors keep
    // their attempts. A new Pacific day is not assumed to restore Gemini quota: when the pause ends, the next
    // review is tried normally and pauses again if Gemini still refuses.
    const until = quotaPauseEnd(deps.now(), interpretation.quota);
    const paused = await deps.allowance.pause(until);
    deps.log({ event: 'live_reviews_paused', route, status: 503, invoiceNo, reason: `quota_${interpretation.quota?.scope ?? 'unknown'}${paused ? '' : '_pause_not_stored'}` });
  }
  if (!interpretation.ok) {
    // Approved: the attempt stays consumed after a downstream failure (the kiosk must say so).
    deps.log({ event: 'interpretation_failed', route, status: 503, invoiceNo, reason: interpretation.reason,
      ...(interpretation.providerStatus !== undefined ? { providerStatus: interpretation.providerStatus } : {}),
      ...(interpretation.providerCode !== undefined ? { providerCode: interpretation.providerCode } : {}) });
    return respond(503, 'service_interrupted', 'The review could not be completed, and this attempt has been used. Demonstrations remain available.');
  }
  const composed = deps.composer.compose(deterministic, interpretation);
  if (!OUTCOMES.includes(composed.outcome)) return respond(500, 'internal_error', 'This invoice could not be reviewed.');

  const body: ReviewResponse = {
    invoiceNo,
    outcome: composed.outcome,
    findings: composed.findings.map(toPublicFinding),
    staffDecisionRequired: true,
    remaining: clamp(Math.min(reservation.snapshot.visitorRemaining, reservation.snapshot.sharedRemaining), config.visitorDailyLimit),
    resetAt: reservation.snapshot.resetAt.toISOString(),
  };
  deps.log({ event: 'review_completed', route, status: 200, invoiceNo, provenance: summarizeProvenance(composed),
    ...(interpretation.usage ? { tokens: interpretation.usage.totalTokens } : {}) });
  return json(200, body);
}

/** Pause length after a Gemini quota refusal: daily quota until the next Pacific midnight, otherwise
 *  Google's suggested delay (at least 60 s, at most 1 hour). */
export function quotaPauseEnd(now: Date, quota: { scope: string; retryAfterSeconds: number | null } | undefined): Date {
  if (quota?.scope === 'day') return nextPacificMidnight(now);
  const seconds = Math.min(3600, Math.max(60, quota?.retryAfterSeconds ?? 60));
  return new Date(now.getTime() + seconds * 1000);
}

/** Static kiosk files: strict same-origin policy, no framing, no caching of authenticated pages. */
export const ASSET_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
    + "font-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cache-control': 'private, no-store',
};

function withAssetHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ASSET_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Copies only public fields, so internal provenance can never leak through a composer. */
export function toPublicFinding(f: PublicFinding): PublicFinding {
  return {
    code: f.code ?? null,
    line: f.line ? { section: f.line.section, lineNumber: f.line.lineNumber } : null,
    ruleRef: String(f.ruleRef),
    evidence: String(f.evidence),
    explanation: String(f.explanation),
  };
}

function summarizeProvenance(composed: ComposedReview): ComposedReview['provenance'] {
  const p = composed.provenance;
  return { deterministic: p.deterministic, ai: p.ai, combined: p.combined };
}

/** Accepts exactly {"invoiceNo":"PO-YYYY-####"} and nothing else (no free text). */
export function parseReviewRequest(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'invoiceNo') return null;
  const value = (parsed as { invoiceNo: unknown }).invoiceNo;
  return typeof value === 'string' && INVOICE_ID.test(value) ? value : null;
}

async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.floor(value)));
}

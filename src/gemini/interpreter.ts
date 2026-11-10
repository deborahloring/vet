// GeminiInterpreter: exactly one generateContent request per review, no retries.
// The API key is sent only in the x-goog-api-key header from the Worker; it never appears
// in URLs, results, errors or logs.

import type { InterpretationInput, InterpretationResult, InterpretationSuccess, Interpreter, QuotaRefusal } from '../api/ports.ts';
import { GEMINI_LIMITS, generateContentUrl, type GeminiModel } from './model.ts';
import { InvalidModelOutput, parseModelJson, validateInterpretation } from './parse.ts';
import { buildRequestBody, PromptLimitError } from './prompt.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiSettings {
  apiKey: string;
  model: GeminiModel;
  timeoutMs?: number;
  /** Offline evaluation only: receives the raw model text so a run can be replayed. Never set in the Worker. */
  onModelText?: (invoiceNo: string, modelText: string) => void;
}

function usage(meta: unknown): InterpretationSuccess['usage'] {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const n = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0);
  return { promptTokens: n('promptTokenCount'), outputTokens: n('candidatesTokenCount'), totalTokens: n('totalTokenCount') };
}

export class GeminiInterpreter implements Interpreter {
  private readonly settings: GeminiSettings;
  private readonly fetchFn: FetchLike;

  constructor(settings: GeminiSettings, fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.settings = settings;
    this.fetchFn = fetchFn;
  }

  async interpret(input: InterpretationInput): Promise<InterpretationResult> {
    if (!this.settings.apiKey) return { ok: false, reason: 'not_configured' };
    let body: string;
    try {
      body = JSON.stringify(buildRequestBody(input.invoice, input.document));
    } catch (e) {
      if (e instanceof PromptLimitError) return { ok: false, reason: 'invalid_input' };
      throw e;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs ?? GEMINI_LIMITS.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(generateContentUrl(this.settings.model), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.settings.apiKey },
        body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'provider_error' };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) return { ok: false, reason: 'quota', quota: quotaRefusal(text) };
    if (response.status !== 200) return { ok: false, reason: 'provider_error', ...providerError(response.status, text) };
    try {
      const envelope = parseEnvelope(text);
      const candidate = envelope.candidate;
      if (candidate['finishReason'] !== 'STOP') return { ok: false, reason: 'invalid_output' };
      const parts = ((candidate['content'] as Record<string, unknown> | undefined)?.['parts'] ?? []) as Record<string, unknown>[];
      const modelText = parts.map((p) => (typeof p['text'] === 'string' ? p['text'] : '')).join('');
      this.settings.onModelText?.(input.invoiceNo, modelText);
      const validated = validateInterpretation(parseModelJson(modelText), input.invoice, input.document.visitNotes);
      return { ok: true, ...validated, usage: usage(envelope.usageMetadata) };
    } catch (e) {
      if (e instanceof InvalidModelOutput) return { ok: false, reason: 'invalid_output' };
      throw e;
    }
  }
}

/** Reads Google's QuotaFailure / RetryInfo details from a 429 body. Unknown shapes fall back safely. */
/** Diagnostic detail for a provider error: the HTTP status and Google's status word only (never the message, which may echo request details). */
export function providerError(status: number, text: string): { providerStatus: number; providerCode?: string } {
  try {
    const code = (JSON.parse(text) as { error?: { status?: unknown } })?.error?.status;
    if (typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)) return { providerStatus: status, providerCode: code };
  } catch { /* not JSON: status only */ }
  return { providerStatus: status };
}

export function quotaRefusal(text: string): QuotaRefusal {
  let scope: QuotaRefusal['scope'] = 'unknown';
  let retryAfterSeconds: number | null = null;
  try {
    const details = (JSON.parse(text) as { error?: { details?: Record<string, unknown>[] } }).error?.details ?? [];
    for (const d of details) {
      const type = String(d['@type'] ?? '');
      if (type.endsWith('QuotaFailure')) {
        const ids = ((d['violations'] as { quotaId?: string; quotaMetric?: string }[] | undefined) ?? [])
          .map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`).join(' ');
        if (/per ?day/i.test(ids)) scope = 'day';
        else if (/per ?minute/i.test(ids) && scope !== 'day') scope = 'minute';
      }
      if (type.endsWith('RetryInfo')) {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(String(d['retryDelay'] ?? ''));
        if (match) retryAfterSeconds = Math.ceil(Number(match[1]));
      }
    }
  } catch {
    // Not JSON: keep the conservative defaults.
  }
  return { scope, retryAfterSeconds };
}

function parseEnvelope(text: string): { candidate: Record<string, unknown>; usageMetadata: unknown } {
  if (text.length > GEMINI_LIMITS.maxResponseChars * 4) throw new InvalidModelOutput('envelope too large');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new InvalidModelOutput('envelope is not JSON');
  }
  const feedback = parsed['promptFeedback'] as Record<string, unknown> | undefined;
  if (feedback?.['blockReason']) throw new InvalidModelOutput('prompt blocked');
  const candidates = parsed['candidates'];
  if (!Array.isArray(candidates) || candidates.length !== 1 || !candidates[0] || typeof candidates[0] !== 'object') {
    throw new InvalidModelOutput('expected exactly one candidate');
  }
  return { candidate: candidates[0] as Record<string, unknown>, usageMetadata: parsed['usageMetadata'] };
}

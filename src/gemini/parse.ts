// Validates Gemini's JSON against the invoice and visit notes.
//
// The model may only point at things; code decides what is accepted:
//   - every item must reference a billed line by section, line number and printed code;
//   - its excerpt must appear verbatim in the visit notes and name that line's service;
//   - quantity conflicts need a billed quantity above one; duplicates need a repeated code;
//   - one finding per line (supported findings take precedence over review items);
//   - rule references and evidence text are assigned here, never copied from the model;
//   - discount approval must be supported by a quoted note sentence, else it becomes "unclear".
// Anything unsupported is dropped and counted in `rejected`. Structurally invalid output fails.

import { RULE, type InvoiceInput, type LineRef, type RuleId } from '../billing/index.ts';
import type { AiFinding, AiFindingType, DiscountAuthorization, InterpretationSuccess } from '../api/ports.ts';
import { GEMINI_LIMITS } from './model.ts';
import { DISCOUNT_STATUSES, REVIEW_TYPES, SUPPORTED_TYPES } from './prompt.ts';

export class InvalidModelOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelOutput';
  }
}

const RULES: Record<AiFindingType, RuleId[]> = {
  declined_service_billed: [RULE.documentedService],
  unsupported_billed_service: [RULE.documentedService],
  quantity_documentation_conflict: [RULE.documentedService],
  duplicate_service: [RULE.duplicateCharge],
  insufficient_documentation: [RULE.documentationCompleteness],
  ambiguous_documentation: [RULE.documentationCompleteness],
};
// Lower index wins when several items target the same line.
const PRECEDENCE: AiFindingType[] = ['declined_service_billed', 'unsupported_billed_service', 'duplicate_service',
  'quantity_documentation_conflict', 'insufficient_documentation', 'ambiguous_documentation'];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function trimExcerpt(text: string): string {
  return normalize(text).replace(/^["'\s]+|["'\s.]+$/g, '');
}

function excerptInNotes(excerpt: string, notes: string): boolean {
  const e = trimExcerpt(excerpt);
  return e.length >= 8 && e.length <= GEMINI_LIMITS.maxExcerptChars && normalize(notes).includes(e);
}

// The model's own quote must agree with its claim, using the category definitions given in the
// prompt (general language, not dataset phrasing). Returns the type the quote supports, or null:
//  - a duplicate or quantity conflict cannot rest on a quote documenting two or more occurrences;
//  - a declined or not-performed claim whose quote says documentation is pending or not finalized
//    becomes insufficient_documentation, and one whose quote says completion is unclear becomes
//    ambiguous_documentation (both staff-review matters, same line, same quote);
//  - a declined, not-performed or staff-review claim whose quote documents exactly one occurrence
//    becomes quantity_documentation_conflict (kept only when the line bills more than one; otherwise
//    the quote shows the service was performed as billed and the claim is rejected);
//  - a declined or not-performed claim cannot rest on a quote saying the service was done,
//    or that it was only considered; a staff-review claim cannot rest on a quote saying it was done;
//  - a not-performed claim whose quote records a decline or withheld consent is labeled declined.
// Nothing is added that the model did not claim for that line.
const MULTIPLE = /\b(twice|two|second|both|several|multiple)\b/i;
const ONCE = /\b(performed once|single|only one|one occurrence|no repeat|records one)\b/i;
const DONE = /\b(completed|was done|went smoothly)\b/i;
const NOT_FINALIZED = /\b(pending|awaiting|not been finalized|not finalized|sign-?off)\b/i;
const UNCLEAR = /\b(unclear|uncertain|does not confirm|not confirmed|handoff)\b/i;
const CONSIDERED = /\bconsidered\b/i;
const DECLINED = /\b(declin\w*|refus\w*|(opted|chose|elected|decided) not|did not (want|wish|agree|consent|authorize)|consent (was )?(not given|withheld|refused|declined)|without (\w+ )?consent|no consent)\b/i;

export function reconcileType(type: AiFindingType, excerpt: string): AiFindingType | null {
  if (type === 'duplicate_service' || type === 'quantity_documentation_conflict') return MULTIPLE.test(excerpt) ? null : type;
  if (type === 'declined_service_billed' || type === 'unsupported_billed_service') {
    if (NOT_FINALIZED.test(excerpt)) return 'insufficient_documentation';
    if (UNCLEAR.test(excerpt)) return 'ambiguous_documentation';
    if (ONCE.test(excerpt)) return 'quantity_documentation_conflict';
    if (DONE.test(excerpt) || CONSIDERED.test(excerpt)) return null;
    return type === 'unsupported_billed_service' && DECLINED.test(excerpt) ? 'declined_service_billed' : type;
  }
  // insufficient_documentation / ambiguous_documentation: an unsettled quote supports the claim as made.
  if (NOT_FINALIZED.test(excerpt) || UNCLEAR.test(excerpt)) return type;
  if (ONCE.test(excerpt)) return 'quantity_documentation_conflict';
  if (DONE.test(excerpt)) return null;
  return type;
}

function describe(type: AiFindingType, line: LineRef, description: string, quantity: number, excerpt: string): string {
  const where = `${description} (${line.code}) on ${line.section} line ${line.lineNumber}`;
  const quote = `The visit notes say: "${excerpt}"`;
  switch (type) {
    case 'declined_service_billed': return `${where} is billed, but it was declined. ${quote}`;
    case 'unsupported_billed_service': return `${where} is billed, but it was not performed. ${quote}`;
    case 'quantity_documentation_conflict': return `${where} is billed with quantity ${quantity}, but the notes document fewer. ${quote}`;
    case 'duplicate_service': return `${line.code} is billed more than once, but the notes document one. ${quote}`;
    case 'insufficient_documentation': return `Documentation for ${where} is not finalized. ${quote}`;
    case 'ambiguous_documentation': return `The notes do not confirm whether ${where} was completed. ${quote}`;
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidModelOutput(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidModelOutput(`${what} is not a list`);
  if (value.length > GEMINI_LIMITS.maxFindingsPerList) throw new InvalidModelOutput(`${what} has too many items`);
  return value;
}

export function parseModelJson(text: string): Record<string, unknown> {
  if (text.length > GEMINI_LIMITS.maxResponseChars) throw new InvalidModelOutput('response too long');
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new InvalidModelOutput('response is not JSON');
  }
  return asObject(parsed, 'response');
}

export function validateInterpretation(
  raw: Record<string, unknown>, invoice: InvoiceInput, notes: string,
): Pick<InterpretationSuccess, 'findings' | 'discount' | 'rejected'> {
  const lists: [unknown[], readonly string[]][] = [
    [asList(raw['supportedFindings'], 'supportedFindings'), SUPPORTED_TYPES],
    [asList(raw['reviewNeeded'], 'reviewNeeded'), REVIEW_TYPES],
  ];
  const lines = new Map(invoice.lines.map((l) => [`${l.section}:${l.lineNumber}`, l]));
  let rejected = 0;
  const candidates: AiFinding[] = [];

  for (const [list, allowed] of lists) {
    for (const entry of list) {
      const item = asObject(entry, 'finding');
      const type = item['type'];
      const section = item['section'];
      const lineNumber = item['lineNumber'];
      const code = typeof item['code'] === 'string' ? item['code'].trim() : '';
      const excerpt = typeof item['noteExcerpt'] === 'string' ? item['noteExcerpt'].trim() : '';
      const line = typeof section === 'string' && typeof lineNumber === 'number' ? lines.get(`${section}:${lineNumber}`) : undefined;
      const sameCode = line ? invoice.lines.filter((l) => l.section === line.section && l.code === line.code) : [];
      const kind = typeof type === 'string' && allowed.includes(type) ? reconcileType(type as AiFindingType, excerpt) : null;
      const supported = kind !== null
        && line !== undefined && line.code === code
        && excerptInNotes(excerpt, notes)
        && normalize(excerpt).includes(normalize(line.description))
        && (kind !== 'quantity_documentation_conflict' || line.quantity > 1)
        && (kind !== 'duplicate_service' || sameCode.length > 1);
      if (!supported || !line) { rejected++; continue; }
      const ref: LineRef = { section: line.section, lineNumber: line.lineNumber, code: line.code };
      const other = kind === 'duplicate_service' ? sameCode.find((l) => l.lineNumber !== line.lineNumber) : undefined;
      candidates.push({
        id: `${ref.section}:${ref.lineNumber}:${kind}`,
        type: kind,
        origin: 'ai',
        ruleIds: RULES[kind],
        disposition: (REVIEW_TYPES as readonly string[]).includes(kind) ? 'staff_review' : 'discrepancy',
        line: ref,
        secondaryLine: other ? { section: other.section, lineNumber: other.lineNumber, code: other.code } : null,
        noteExcerpt: excerpt.replace(/\s+/g, ' '),
        evidence: describe(kind, ref, line.description, line.quantity, excerpt.replace(/\s+/g, ' ')),
      });
    }
  }

  // One finding per line (and one duplicate finding per code); conflicts resolved by precedence.
  candidates.sort((a, b) => PRECEDENCE.indexOf(a.type) - PRECEDENCE.indexOf(b.type));
  const taken = new Set<string>();
  const findings: AiFinding[] = [];
  for (const f of candidates) {
    const keys = [`${f.line.section}:${f.line.lineNumber}`, ...(f.secondaryLine ? [`${f.secondaryLine.section}:${f.secondaryLine.lineNumber}`] : [])];
    if (keys.some((k) => taken.has(k))) { rejected++; continue; }
    keys.forEach((k) => taken.add(k));
    findings.push(f);
  }
  findings.sort((a, b) => (a.line.section === b.line.section ? 0 : a.line.section === 'service' ? -1 : 1)
    || a.line.lineNumber - b.line.lineNumber);

  const d = asObject(raw['discountAuthorization'], 'discountAuthorization');
  const status = d['status'];
  if (typeof status !== 'string' || !(DISCOUNT_STATUSES as readonly string[]).includes(status)) {
    throw new InvalidModelOutput('discountAuthorization.status is invalid');
  }
  const discountExcerpt = typeof d['noteExcerpt'] === 'string' ? d['noteExcerpt'].trim() : '';
  const quoted = discountExcerpt ? excerptInNotes(discountExcerpt, notes) : false;
  const text = normalize(discountExcerpt);
  let discount: DiscountAuthorization;
  if (status === 'courtesy' || status === 'senior') {
    const mentionsDiscount = /discount|reduction/.test(text);
    const kindMatches = status === 'senior' ? text.includes('senior') : !text.includes('senior');
    if (quoted && mentionsDiscount && kindMatches) {
      discount = { status, noteExcerpt: discountExcerpt.replace(/\s+/g, ' ') };
    } else {
      rejected++;
      discount = { status: 'unclear', noteExcerpt: null };
    }
  } else {
    if (discountExcerpt && !quoted) rejected++;
    discount = { status: status as 'none' | 'unclear', noteExcerpt: quoted ? discountExcerpt.replace(/\s+/g, ' ') : null };
  }
  return { findings, discount, rejected };
}

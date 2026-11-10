// Step 5: one unified Temperance result from three internal sources.
//
//   deterministic  — billing engine findings (prices, arithmetic, tax, code validity)
//   ai             — verified Gemini findings about the visit notes
//   combined       — discount: printed amount (engine) + documented authorization (notes)
//
// Rules:
//   - Every valid finding from each source is kept; the sources cover different questions,
//     so independent discrepancies on the same line (e.g. a wrong price and a declined service)
//     are both reported.
//   - Discounts produce at most one finding: the engine's "impermissible amount" and the
//     combined evaluation are merged rather than reported twice.
//   - Outcome: any staff-review item -> staff_review_required; otherwise any discrepancy ->
//     discrepancy_identified; otherwise no_discrepancy_found. Staff always decide.
//   - Visitor wording is fixed application text per finding type; model text is never shown.
//   - Provenance is counted internally and never placed in the public findings.

import { formatCents, type DeterministicResult, type Finding, type RuleId } from '../billing/index.ts';
import type { PublicFinding, ReviewOutcome } from '../api/contracts.ts';
import type { AiFinding, ComposedReview, InterpretationSuccess, ResponseComposer } from '../api/ports.ts';
import { evaluateDiscount, type DiscountEvaluation } from '../gemini/discount.ts';

type Origin = 'deterministic' | 'ai' | 'combined';

export interface InternalFinding {
  key: string;
  origin: Origin;
  kind: string;
  disposition: 'discrepancy' | 'staff_review';
  code: string | null;
  line: { section: 'service' | 'product'; lineNumber: number } | null;
  ruleIds: RuleId[];
  evidence: string;
  explanation: string;
  /** Evaluation only (never public): the duplicate's other line and the verified note excerpt. */
  secondaryLine?: { section: 'service' | 'product'; lineNumber: number } | null;
  noteExcerpt?: string | null;
}

const STAFF = 'A staff member will confirm before anything on the invoice changes.';

/** Application-controlled explanations, keyed by finding type. */
const EXPLANATIONS: Record<string, string> = {
  unit_price_mismatch: `This charge doesn't match the hospital's listed price for the item. ${STAFF}`,
  line_arithmetic: `The amount on this line doesn't equal the quantity times the unit price. ${STAFF}`,
  section_total_arithmetic: `A section total doesn't add up to its lines. ${STAFF}`,
  subtotal_arithmetic: `The subtotal doesn't equal the services and products totals added together. ${STAFF}`,
  tax_arithmetic: `The tax should be 8% of the products only, and the printed tax doesn't match. ${STAFF}`,
  total_due_arithmetic: `The total due doesn't equal the subtotal minus the discount plus tax. ${STAFF}`,
  code_description_conflict: `The item code and its printed description name different services, so the intended service needs to be confirmed. ${STAFF}`,
  code_section_mismatch: `This item is listed in the wrong section of the invoice, so it needs to be checked. ${STAFF}`,
  unknown_code: `This item code isn't in the hospital's service list, so I can't check it. Staff will need to review it.`,
  declined_service_billed: `The visit notes say this service was declined, but it appears on the invoice. ${STAFF}`,
  unsupported_billed_service: `The visit notes say this service wasn't performed, but it appears on the invoice. ${STAFF}`,
  quantity_documentation_conflict: `The invoice charges for more of this service than the visit notes record. ${STAFF}`,
  duplicate_service: `This service is charged more than once, but the visit notes record it only once. ${STAFF}`,
  insufficient_documentation: `The visit record for this service isn't finished yet, so I can't confirm the charge. Staff will need to review it.`,
  ambiguous_documentation: `The visit notes don't make clear whether this service was completed. Staff will need to review it.`,
  discount_discrepancy: `The discount on the invoice doesn't match what the visit notes record. ${STAFF}`,
  discount_not_permitted: `This discount amount isn't one the hospital offers. ${STAFF}`,
  discount_unclear: `The visit notes don't make clear which discount, if any, applies. Staff will need to review it.`,
};

function fromDeterministic(f: Finding): InternalFinding {
  return {
    key: f.id,
    origin: 'deterministic',
    kind: f.type,
    disposition: f.disposition === 'staff_review' ? 'staff_review' : 'discrepancy',
    code: f.line?.code ?? null,
    line: f.line ? { section: f.line.section, lineNumber: f.line.lineNumber } : null,
    ruleIds: f.ruleIds,
    evidence: f.evidence,
    explanation: EXPLANATIONS[f.type]!,
  };
}

function fromAi(f: AiFinding): InternalFinding {
  return {
    key: f.id,
    origin: 'ai',
    kind: f.type,
    disposition: f.disposition,
    code: f.line.code,
    line: { section: f.line.section, lineNumber: f.line.lineNumber },
    ruleIds: f.ruleIds,
    evidence: f.evidence,
    explanation: EXPLANATIONS[f.type]!,
    secondaryLine: f.secondaryLine ? { section: f.secondaryLine.section, lineNumber: f.secondaryLine.lineNumber } : null,
    noteExcerpt: f.noteExcerpt,
  };
}

/** Merges the engine's discount finding (if any) with the combined evaluation into at most one finding. */
function discountFinding(engine: Finding | undefined, evaluation: DiscountEvaluation): InternalFinding | null {
  const summary = { code: null, line: null };
  if (engine) {
    // The printed amount is impermissible on its own; the notes may also tell us the correct amount.
    const known = evaluation.status === 'discrepancy' && evaluation.expectedCents !== null;
    return {
      ...summary, key: 'summary:discount', origin: known ? 'combined' : 'deterministic', kind: 'discount_arithmetic',
      disposition: 'discrepancy',
      ruleIds: known ? evaluation.ruleIds : engine.ruleIds,
      evidence: known ? `${evaluation.evidence} ${formatCents(evaluation.observedCents)} is also not an amount the hospital offers.` : engine.evidence,
      explanation: EXPLANATIONS[known ? 'discount_discrepancy' : 'discount_not_permitted']!,
    };
  }
  if (evaluation.status === 'discrepancy') {
    return { ...summary, key: 'summary:discount', origin: 'combined', kind: 'discount_arithmetic', disposition: 'discrepancy',
      ruleIds: evaluation.ruleIds, evidence: evaluation.evidence, explanation: EXPLANATIONS['discount_discrepancy']! };
  }
  if (evaluation.status === 'unclear') {
    return { ...summary, key: 'summary:discount', origin: 'combined', kind: 'discount_authorization', disposition: 'staff_review',
      ruleIds: evaluation.ruleIds, evidence: evaluation.evidence, explanation: EXPLANATIONS['discount_unclear']! };
  }
  return null;
}

function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const ORIGIN_RANK: Record<Origin, number> = { deterministic: 0, combined: 1, ai: 2 };

function order(f: InternalFinding): [number, number] {
  if (!f.line) return [2, f.kind.startsWith('discount') ? 99 : 0];
  return [f.line.section === 'service' ? 0 : 1, f.line.lineNumber];
}

export function composeReview(deterministic: DeterministicResult, interpretation: InterpretationSuccess): ComposedReview & { internal: InternalFinding[] } {
  const engineDiscount = deterministic.findings.find((f) => f.type === 'discount_arithmetic');
  const evaluation = evaluateDiscount(deterministic.discount, interpretation.discount);

  const merged = new Map<string, InternalFinding>();
  for (const f of deterministic.findings) if (f.type !== 'discount_arithmetic') merged.set(f.id, fromDeterministic(f));
  for (const f of interpretation.findings) if (!merged.has(f.id)) merged.set(f.id, fromAi(f));
  const discount = discountFinding(engineDiscount, evaluation);
  if (discount) merged.set(discount.key, discount);

  const internal = [...merged.values()].sort((a, b) => {
    const [as, al] = order(a);
    const [bs, bl] = order(b);
    return as - bs || al - bl || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.kind.localeCompare(b.kind);
  });

  const outcome: ReviewOutcome = internal.some((f) => f.disposition === 'staff_review') ? 'staff_review_required'
    : internal.length ? 'discrepancy_identified' : 'no_discrepancy_found';
  const findings: PublicFinding[] = internal.map((f) => ({
    code: f.code, line: f.line, ruleRef: f.ruleIds.join('/'), evidence: sentenceCase(f.evidence), explanation: f.explanation,
  }));
  const provenance = { deterministic: 0, ai: 0, combined: 0 };
  for (const f of internal) provenance[f.origin]++;
  return { outcome, findings, provenance, internal };
}

export const composer: ResponseComposer = {
  compose(deterministic, interpretation) {
    const { outcome, findings, provenance } = composeReview(deterministic, interpretation);
    return { outcome, findings, provenance };
  },
};

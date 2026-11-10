// Combines the printed discount (deterministic engine) with the authorization documented in
// the visit notes (interpretation) under B-06/B-07/B-08. Internal provenance: "combined".
// Dataset metadata such as discount_type is never consulted.

import { formatCents, RULE, type DiscountContext, type RuleId } from '../billing/index.ts';
import type { DiscountAuthorization } from '../api/ports.ts';

export interface DiscountEvaluation {
  origin: 'combined';
  /** consistent: printed amount matches the documented authorization.
   *  discrepancy: it does not, and the correct amount is determined.
   *  unclear: the notes do not settle it, or the documented discount is not applicable; staff review. */
  status: 'consistent' | 'discrepancy' | 'unclear';
  ruleIds: RuleId[];
  observedCents: number;
  expectedCents: number | null;
  noteExcerpt: string | null;
  evidence: string;
}

export function evaluateDiscount(printed: DiscountContext, authorization: DiscountAuthorization): DiscountEvaluation {
  const observed = printed.displayedCents;
  const base = { origin: 'combined' as const, observedCents: observed, noteExcerpt: authorization.noteExcerpt };
  const quote = authorization.noteExcerpt ? ` The visit notes say: "${authorization.noteExcerpt}"` : '';

  if (authorization.status === 'unclear') {
    return { ...base, status: 'unclear', ruleIds: [RULE.courtesyDiscount, RULE.seniorDiscount], expectedCents: null,
      evidence: `The notes do not make clear whether a discount was approved; the invoice shows ${formatCents(observed)}.${quote}` };
  }
  if (authorization.status === 'senior' && !printed.seniorEligible) {
    return { ...base, status: 'unclear', ruleIds: [RULE.seniorDiscount], expectedCents: null,
      evidence: `The notes approve a senior wellness discount, but this invoice does not meet the B-07 conditions; the invoice shows ${formatCents(observed)}.${quote}` };
  }
  const expected = authorization.status === 'courtesy' ? printed.courtesyCents
    : authorization.status === 'senior' ? printed.seniorCents : 0;
  // With no documented approval, cite the rule the printed amount claims, or both discount rules.
  const rules: RuleId[] = authorization.status === 'senior' ? [RULE.seniorDiscount]
    : authorization.status === 'courtesy' ? [RULE.courtesyDiscount]
    : printed.matchesRule ? [printed.matchesRule] : [RULE.courtesyDiscount, RULE.seniorDiscount];
  const label = authorization.status === 'none' ? 'no discount' : `a ${formatCents(expected)} ${authorization.status === 'senior' ? 'senior wellness' : 'courtesy'} discount`;
  if (observed === expected) {
    return { ...base, status: 'consistent', ruleIds: rules, expectedCents: expected,
      evidence: `The notes document ${label}, and the invoice shows ${formatCents(observed)}.${quote}` };
  }
  return { ...base, status: 'discrepancy', ruleIds: rules, expectedCents: expected,
    evidence: `The notes document ${label}, but the invoice shows a discount of ${formatCents(observed)}.${quote}` };
}

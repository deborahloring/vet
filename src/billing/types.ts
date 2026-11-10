// Input and output contracts for the deterministic billing engine.

import type { RuleId } from './policy.ts';

export type Section = 'service' | 'product';

/** One printed invoice line. Displayed values are not presumed correct. */
export interface InvoiceLineInput {
  section: Section;
  lineNumber: number;
  code: string;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface InvoiceTotalsInput {
  servicesTotal: string;
  productsTotal: string;
  subtotal: string;
  discount: string;
  tax: string;
  totalDue: string;
}

/**
 * Only facts printed on the invoice. Visit notes and internal dataset metadata
 * (for example `discount_type`) are deliberately absent: discount authorization
 * is established from documentary evidence, not by this engine.
 */
export interface InvoiceInput {
  invoiceNo: string;
  visitType: string;
  patientAgeYears: number;
  lines: readonly InvoiceLineInput[];
  totals: InvoiceTotalsInput;
}

export type DeterministicFindingType =
  | 'unit_price_mismatch'
  | 'line_arithmetic'
  | 'section_total_arithmetic'
  | 'subtotal_arithmetic'
  | 'discount_arithmetic'
  | 'tax_arithmetic'
  | 'total_due_arithmetic'
  | 'code_description_conflict'
  | 'code_section_mismatch'
  | 'unknown_code';

/**
 * discrepancy: objectively wrong under the rules.
 * needs_interpretation: objectively inconsistent, but the intended service needs documentary review.
 * staff_review: cannot be resolved without staff (for example an unknown code).
 */
export type Disposition = 'discrepancy' | 'needs_interpretation' | 'staff_review';

export interface LineRef {
  section: Section;
  lineNumber: number;
  code: string;
}

export interface Finding {
  /** Stable, unique within one result; used for de-duplication and merging. */
  id: string;
  type: DeterministicFindingType;
  /** Internal provenance. Never shown to visitors. */
  origin: 'deterministic';
  ruleIds: RuleId[];
  disposition: Disposition;
  /** Affected line, or null for invoice-summary findings. */
  line: LineRef | null;
  /** Printed field that is wrong, e.g. "unit_price" or "tax". */
  field: string;
  observedCents: number | null;
  /** Correct value when the rules determine it; null when evidence or staff must decide. */
  expectedCents: number | null;
  /** Plain-language evidence for internal logs and for the unified explanation. */
  evidence: string;
}

export type SignalType = 'discount_authorization_required' | 'quantity_above_one' | 'repeated_code';

/** Facts that are not discrepancies by themselves but need documentary interpretation. */
export interface Signal {
  id: string;
  type: SignalType;
  origin: 'deterministic';
  ruleIds: RuleId[];
  lines: LineRef[];
  detail: string;
}

export interface DiscountContext {
  displayedCents: number;
  /** Which rule the displayed amount corresponds to, if any. */
  matchesRule: 'B-06' | 'B-07' | null;
  seniorEligible: boolean;
  courtesyCents: number;
  seniorCents: number;
}

export type DeterministicStatus = 'clear' | 'needs_interpretation' | 'discrepancy' | 'staff_review';

export interface DeterministicResult {
  invoiceNo: string;
  engine: { name: 'billing-rules'; version: string };
  /** Summary of deterministic findings only; the final outcome also depends on AI interpretation. */
  status: DeterministicStatus;
  findings: Finding[];
  signals: Signal[];
  discount: DiscountContext;
  computed: {
    serviceLinesCents: number;
    productLinesCents: number;
    expectedTaxCents: number;
  };
}

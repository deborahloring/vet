// Fictional billing policy from data/billing_rules.csv. Values are mirrored here as
// constants; tests/billing/policy.test.ts fails if they drift from the CSV.

export const RULE = {
  servicePrice: 'B-01',
  productPrice: 'B-02',
  tax: 'B-03',
  lineAmount: 'B-04',
  subtotal: 'B-05',
  courtesyDiscount: 'B-06',
  seniorDiscount: 'B-07',
  totalDue: 'B-08',
  duplicateCharge: 'B-09',
  authority: 'B-10',
  documentedService: 'B-11',
  codeValidity: 'B-12',
  documentationCompleteness: 'B-13',
} as const;

export type RuleId = (typeof RULE)[keyof typeof RULE];

export const POLICY = {
  /** B-03: 8% fictional tax on products only. */
  taxNumerator: 8,
  taxDenominator: 100,
  /** B-06: fixed $10.00 courtesy discount. */
  courtesyDiscountCents: 1000,
  /** B-07: 10% of the EX-105 standard price, for an eligible senior wellness visit. */
  seniorNumerator: 10,
  seniorDenominator: 100,
  seniorExamCode: 'EX-105',
  seniorVisitType: 'Senior wellness',
  seniorMinimumAgeYears: 10,
  /** Approved invoice template capacity. */
  maxServiceLines: 7,
  maxProductLines: 3,
  maxQuantity: 99,
} as const;

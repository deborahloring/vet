// Deterministic billing validation (B-01..B-08, B-12 code validity).
// Pure function: no I/O, no network, no PDF parsing, no AI calls.
// Documentary questions (B-09, B-11, B-13, discount authorization) are surfaced as
// signals for interpretation, never decided here.

import { normalizeText, type Catalog, type CatalogEntry } from './catalog.ts';
import { InvoiceInputError } from './errors.ts';
import { applyRateHalfUp, formatCents, parseCents } from './money.ts';
import { POLICY, RULE, type RuleId } from './policy.ts';
import type {
  DeterministicFindingType, DeterministicResult, DeterministicStatus, DiscountContext, Disposition,
  Finding, InvoiceInput, InvoiceLineInput, LineRef, Section, Signal,
} from './types.ts';

export const ENGINE_VERSION = '1.0.0';

const TYPE_ORDER: DeterministicFindingType[] = [
  'unknown_code', 'code_section_mismatch', 'code_description_conflict', 'unit_price_mismatch',
  'line_arithmetic', 'section_total_arithmetic', 'subtotal_arithmetic', 'discount_arithmetic',
  'tax_arithmetic', 'total_due_arithmetic',
];
const SECTION_ORDER: Record<Section | 'summary', number> = { service: 0, product: 1, summary: 2 };

interface ParsedLine {
  ref: LineRef;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

function parseLines(invoice: InvoiceInput): ParsedLine[] {
  if (!Array.isArray(invoice.lines)) throw new InvoiceInputError('lines must be an array');
  const seen = new Set<string>();
  const parsed = invoice.lines.map((line: InvoiceLineInput): ParsedLine => {
    if (line.section !== 'service' && line.section !== 'product') {
      throw new InvoiceInputError(`line section must be service or product, received ${JSON.stringify(line.section)}`);
    }
    const label = `${line.section} line ${line.lineNumber}`;
    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1) throw new InvoiceInputError(`${label}: invalid line number`);
    const key = `${line.section}:${line.lineNumber}`;
    if (seen.has(key)) throw new InvoiceInputError(`${label}: duplicate line number`);
    seen.add(key);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > POLICY.maxQuantity) {
      throw new InvoiceInputError(`${label}: quantity must be a whole number from 1 to ${POLICY.maxQuantity}`);
    }
    const code = normalizeText(String(line.code ?? ''));
    if (!code) throw new InvoiceInputError(`${label}: missing code`);
    return {
      ref: { section: line.section, lineNumber: line.lineNumber, code },
      description: normalizeText(String(line.description ?? '')),
      quantity: line.quantity,
      unitCents: parseCents(line.unitPrice, `${label} unit price`),
      amountCents: parseCents(line.amount, `${label} amount`),
    };
  });
  for (const [section, max] of [['service', POLICY.maxServiceLines], ['product', POLICY.maxProductLines]] as const) {
    const numbers = parsed.filter((l) => l.ref.section === section).map((l) => l.ref.lineNumber).sort((a, b) => a - b);
    if (numbers.length > max) throw new InvoiceInputError(`${section} lines exceed invoice capacity of ${max}`);
    if (numbers.some((n, i) => n !== i + 1)) throw new InvoiceInputError(`${section} line numbers must run 1..${numbers.length}`);
  }
  if (!parsed.some((l) => l.ref.section === 'service')) throw new InvoiceInputError('invoice has no service lines');
  return parsed;
}

function lineLabel(ref: LineRef): string {
  return `${ref.section} line ${ref.lineNumber} (${ref.code})`;
}

export function validateInvoice(invoice: InvoiceInput, catalog: Catalog): DeterministicResult {
  if (!invoice || typeof invoice.invoiceNo !== 'string' || !invoice.invoiceNo.trim()) {
    throw new InvoiceInputError('invoiceNo is required');
  }
  if (!Number.isInteger(invoice.patientAgeYears) || invoice.patientAgeYears < 0) {
    throw new InvoiceInputError('patientAgeYears must be a non-negative whole number');
  }
  const lines = parseLines(invoice);
  const totals = invoice.totals;
  if (!totals) throw new InvoiceInputError('totals are required');
  const shown = {
    services: parseCents(totals.servicesTotal, 'services total'),
    products: parseCents(totals.productsTotal, 'products total'),
    subtotal: parseCents(totals.subtotal, 'subtotal'),
    discount: parseCents(totals.discount, 'discount'),
    tax: parseCents(totals.tax, 'tax'),
    totalDue: parseCents(totals.totalDue, 'total due'),
  };

  const findings = new Map<string, Finding>();
  const add = (
    type: DeterministicFindingType, ruleIds: RuleId[], disposition: Disposition, line: LineRef | null,
    field: string, observedCents: number | null, expectedCents: number | null, evidence: string,
  ): void => {
    const id = line ? `${line.section}:${line.lineNumber}:${type}` : `summary:${type}:${field}`;
    if (!findings.has(id)) {
      findings.set(id, { id, type, origin: 'deterministic', ruleIds, disposition, line, field, observedCents, expectedCents, evidence });
    }
  };

  // Line checks: B-12 code validity, B-01/B-02 price, B-04 line amount.
  for (const line of lines) {
    const entry: CatalogEntry | undefined = catalog.byCode.get(line.ref.code);
    if (!entry) {
      add('unknown_code', [RULE.codeValidity], 'staff_review', line.ref, 'code', null, null,
        `${lineLabel(line.ref)} is not in the service catalog; staff must confirm the intended service.`);
    } else if (entry.section !== line.ref.section) {
      add('code_section_mismatch', [RULE.codeValidity], 'needs_interpretation', line.ref, 'section', null, null,
        `${lineLabel(line.ref)} is a catalog ${entry.section} but is billed in the ${line.ref.section} section.`);
    } else {
      if (line.description !== entry.description) {
        const other = catalog.byDescription.get(line.description);
        add('code_description_conflict', [RULE.codeValidity], 'needs_interpretation', line.ref, 'description', null, null,
          `${lineLabel(line.ref)} is printed as "${line.description}", but ${entry.code} is "${entry.description}"` +
          (other ? ` ("${line.description}" is catalog code ${other.code}).` : '.'));
      }
      if (line.unitCents !== entry.standardUnitPriceCents) {
        const rule = entry.section === 'product' ? RULE.productPrice : RULE.servicePrice;
        add('unit_price_mismatch', [rule], 'discrepancy', line.ref, 'unit_price', line.unitCents, entry.standardUnitPriceCents,
          `${lineLabel(line.ref)} is billed at ${formatCents(line.unitCents)} each; the catalog price is ` +
          `${formatCents(entry.standardUnitPriceCents)}.`);
      }
    }
    const expectedAmount = line.unitCents * line.quantity;
    if (line.amountCents !== expectedAmount) {
      add('line_arithmetic', [RULE.lineAmount], 'discrepancy', line.ref, 'amount', line.amountCents, expectedAmount,
        `${lineLabel(line.ref)} shows ${formatCents(line.amountCents)}, but ${line.quantity} x ` +
        `${formatCents(line.unitCents)} is ${formatCents(expectedAmount)}.`);
    }
  }

  // Summary checks: section totals and subtotal (B-05).
  const serviceLines = lines.filter((l) => l.ref.section === 'service').reduce((sum, l) => sum + l.amountCents, 0);
  const productLines = lines.filter((l) => l.ref.section === 'product').reduce((sum, l) => sum + l.amountCents, 0);
  for (const [field, observed, expected] of [['services_total', shown.services, serviceLines],
    ['products_total', shown.products, productLines]] as const) {
    if (observed !== expected) {
      add('section_total_arithmetic', [RULE.subtotal], 'discrepancy', null, field, observed, expected,
        `The printed ${field.replace('_', ' ')} is ${formatCents(observed)}, but its lines add up to ${formatCents(expected)}.`);
    }
  }
  const expectedSubtotal = shown.services + shown.products;
  if (shown.subtotal !== expectedSubtotal) {
    add('subtotal_arithmetic', [RULE.subtotal], 'discrepancy', null, 'subtotal', shown.subtotal, expectedSubtotal,
      `The subtotal is ${formatCents(shown.subtotal)}, but services ${formatCents(shown.services)} plus products ` +
      `${formatCents(shown.products)} is ${formatCents(expectedSubtotal)}.`);
  }

  // Discount amount (B-06/B-07/B-08). Authorization is NOT decided here.
  const courtesyCents = POLICY.courtesyDiscountCents;
  const seniorExam = catalog.byCode.get(POLICY.seniorExamCode);
  const seniorCents = seniorExam ? applyRateHalfUp(seniorExam.standardUnitPriceCents, POLICY.seniorNumerator, POLICY.seniorDenominator) : 0;
  const seniorReasons: string[] = [];
  if (invoice.visitType !== POLICY.seniorVisitType) seniorReasons.push(`the visit type is "${invoice.visitType}"`);
  if (invoice.patientAgeYears < POLICY.seniorMinimumAgeYears) seniorReasons.push(`the cat is ${invoice.patientAgeYears}`);
  if (!lines.some((l) => l.ref.section === 'service' && l.ref.code === POLICY.seniorExamCode)) {
    seniorReasons.push(`${POLICY.seniorExamCode} is not billed`);
  }
  const seniorEligible = seniorExam !== undefined && seniorReasons.length === 0;
  let matchesRule: DiscountContext['matchesRule'] = null;
  if (shown.discount > shown.services) {
    add('discount_arithmetic', [RULE.totalDue], 'discrepancy', null, 'discount', shown.discount, null,
      `The discount ${formatCents(shown.discount)} exceeds the service charges ${formatCents(shown.services)}; ` +
      'discounts apply to services only.');
  } else if (shown.discount === courtesyCents) {
    matchesRule = RULE.courtesyDiscount;
  } else if (shown.discount === seniorCents && seniorCents > 0) {
    if (seniorEligible) {
      matchesRule = RULE.seniorDiscount;
    } else {
      add('discount_arithmetic', [RULE.seniorDiscount], 'discrepancy', null, 'discount', shown.discount, null,
        `The discount ${formatCents(shown.discount)} matches the senior wellness discount, but the invoice is not ` +
        `eligible: ${seniorReasons.join('; ')}.`);
    }
  } else if (shown.discount !== 0) {
    const permitted = [formatCents(courtesyCents), ...(seniorEligible ? [formatCents(seniorCents)] : [])].join(' or ');
    add('discount_arithmetic', [RULE.courtesyDiscount, RULE.seniorDiscount], 'discrepancy', null, 'discount', shown.discount, null,
      `The discount ${formatCents(shown.discount)} is not a permitted amount (${permitted}, or none); ` +
      'the correct amount depends on the authorization documented in the visit notes.');
  }

  // Product tax (B-03/B-08) on undiscounted printed products.
  const expectedTax = applyRateHalfUp(shown.products, POLICY.taxNumerator, POLICY.taxDenominator);
  if (shown.tax !== expectedTax) {
    add('tax_arithmetic', [RULE.tax, RULE.totalDue], 'discrepancy', null, 'tax', shown.tax, expectedTax,
      `The tax is ${formatCents(shown.tax)}, but 8% of products ${formatCents(shown.products)} is ${formatCents(expectedTax)}.`);
  }

  // Total due (B-08) from the printed figures.
  const expectedTotal = shown.subtotal - shown.discount + shown.tax;
  if (shown.totalDue !== expectedTotal) {
    add('total_due_arithmetic', [RULE.totalDue], 'discrepancy', null, 'total_due', shown.totalDue, expectedTotal,
      `The total due is ${formatCents(shown.totalDue)}, but subtotal - discount + tax is ${formatCents(expectedTotal)}.`);
  }

  // Signals for documentary interpretation (never findings on their own).
  const signals: Signal[] = [];
  if (matchesRule) {
    signals.push({
      id: 'summary:discount_authorization_required', type: 'discount_authorization_required', origin: 'deterministic',
      ruleIds: [matchesRule], lines: [],
      detail: `The discount ${formatCents(shown.discount)} matches ${matchesRule}; its authorization must be confirmed in the visit notes.`,
    });
  }
  for (const line of lines) {
    if (line.quantity > 1 && catalog.byCode.has(line.ref.code)) {
      signals.push({
        id: `${line.ref.section}:${line.ref.lineNumber}:quantity_above_one`, type: 'quantity_above_one', origin: 'deterministic',
        ruleIds: [RULE.documentedService], lines: [line.ref],
        detail: `${lineLabel(line.ref)} is billed with quantity ${line.quantity}; the notes must support that count.`,
      });
    }
  }
  const byCode = new Map<string, ParsedLine[]>();
  for (const line of lines) {
    const key = `${line.ref.section}:${line.ref.code}`;
    byCode.set(key, [...(byCode.get(key) ?? []), line]);
  }
  for (const [key, group] of byCode) {
    if (group.length > 1) {
      signals.push({
        id: `${key}:repeated_code`, type: 'repeated_code', origin: 'deterministic', ruleIds: [RULE.duplicateCharge],
        lines: group.map((l) => l.ref),
        detail: `${group[0]!.ref.code} appears on ${group.length} lines; the notes must establish how many were performed.`,
      });
    }
  }

  const ordered = [...findings.values()].sort((a, b) =>
    SECTION_ORDER[a.line?.section ?? 'summary'] - SECTION_ORDER[b.line?.section ?? 'summary']
    || (a.line?.lineNumber ?? 0) - (b.line?.lineNumber ?? 0)
    || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
    || a.field.localeCompare(b.field));

  let status: DeterministicStatus = 'clear';
  if (ordered.some((f) => f.disposition === 'staff_review')) status = 'staff_review';
  else if (ordered.some((f) => f.disposition === 'discrepancy')) status = 'discrepancy';
  else if (ordered.length) status = 'needs_interpretation';

  return {
    invoiceNo: invoice.invoiceNo,
    engine: { name: 'billing-rules', version: ENGINE_VERSION },
    status,
    findings: ordered,
    signals,
    discount: { displayedCents: shown.discount, matchesRule, seniorEligible, courtesyCents, seniorCents },
    computed: { serviceLinesCents: serviceLines, productLinesCents: productLines, expectedTaxCents: expectedTax },
  };
}

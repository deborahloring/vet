// Rule-by-rule fixtures built from the approved catalog and billing rules.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatCents, InvoiceInputError, validateInvoice, type DeterministicResult, type InvoiceInput,
  type InvoiceLineInput, type Section,
} from '../../src/billing/index.ts';
import { loadCatalog } from '../helpers/dataset.ts';

const catalog = loadCatalog();
const money = (cents: number) => formatCents(cents).replace('$', '');

/** Catalog-priced line; override any printed value to inject a fault. */
function line(section: Section, lineNumber: number, code: string, over: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  const entry = catalog.byCode.get(code);
  const quantity = over.quantity ?? 1;
  const unit = entry?.standardUnitPriceCents ?? 5000;
  return {
    section, lineNumber, code, description: entry?.description ?? 'Unlisted Service', quantity,
    unitPrice: money(unit), amount: money(unit * quantity), ...over,
  };
}

/** Builds an invoice whose totals are consistent with its printed lines unless overridden. */
function invoice(opts: {
  lines?: readonly InvoiceLineInput[]; discount?: string; visitType?: string; age?: number;
  totals?: Partial<InvoiceInput['totals']>;
} = {}): InvoiceInput {
  const lines = opts.lines ?? [line('service', 1, 'EX-101'), line('service', 2, 'VAC-301'), line('product', 1, 'MED-605')];
  const cents = (s: string) => Math.round(Number(s) * 100);
  const sum = (section: Section) => lines.filter((l) => l.section === section).reduce((a, l) => a + cents(l.amount), 0);
  const services = sum('service');
  const products = sum('product');
  const discount = cents(opts.discount ?? '0.00');
  const tax = Math.floor((products * 16 + 100) / 200);
  return {
    invoiceNo: 'PO-TEST-0001',
    visitType: opts.visitType ?? 'Annual wellness',
    patientAgeYears: opts.age ?? 5,
    lines: [...lines],
    totals: {
      servicesTotal: money(services), productsTotal: money(products), subtotal: money(services + products),
      discount: money(discount), tax: money(tax), totalDue: money(services + products - discount + tax),
      ...opts.totals,
    },
  };
}

const types = (r: DeterministicResult) => r.findings.map((f) => f.type);

describe('clean invoice', () => {
  test('produces no findings, no signals and status clear', () => {
    const result = validateInvoice(invoice(), catalog);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.signals, []);
    assert.equal(result.status, 'clear');
    assert.equal(result.computed.expectedTaxCents, 200);
    assert.deepEqual(result.engine, { name: 'billing-rules', version: '1.0.0' });
  });
});

describe('B-01 / B-02 catalog price', () => {
  test('service price above catalog cites B-01 with the expected price', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101', { unitPrice: '74.00', amount: '74.00' })] }), catalog);
    assert.deepEqual(types(r), ['unit_price_mismatch']);
    const f = r.findings[0]!;
    assert.deepEqual(f.ruleIds, ['B-01']);
    assert.deepEqual(f.line, { section: 'service', lineNumber: 1, code: 'EX-101' });
    assert.equal(f.observedCents, 7400);
    assert.equal(f.expectedCents, 6500);
    assert.equal(f.origin, 'deterministic');
    assert.equal(r.status, 'discrepancy');
  });
  test('product price below catalog cites B-02', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101'), line('product', 1, 'MED-605', { unitPrice: '20.00', amount: '20.00' })] }), catalog);
    assert.deepEqual(types(r), ['unit_price_mismatch']);
    assert.deepEqual(r.findings[0]!.ruleIds, ['B-02']);
  });
});

describe('B-04 line amount', () => {
  test('amount that is not quantity x unit price', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'LAB-201', { amount: '82.00' })] }), catalog);
    assert.deepEqual(types(r), ['line_arithmetic']);
    assert.equal(r.findings[0]!.expectedCents, 7500);
    assert.deepEqual(r.findings[0]!.ruleIds, ['B-04']);
  });
  test('quantity above one with a correct amount is not a finding, only a signal for the notes (B-11)', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101'), line('service', 2, 'PR-504', { quantity: 2 })] }), catalog);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.signals.map((s) => [s.type, s.ruleIds]), [['quantity_above_one', ['B-11']]]);
  });
});

describe('B-05 subtotal and section totals', () => {
  test('subtotal that is not services + products', () => {
    const r = validateInvoice(invoice({ totals: { subtotal: '136.00', totalDue: '138.00' } }), catalog);
    assert.deepEqual(types(r), ['subtotal_arithmetic']);
    assert.equal(r.findings[0]!.expectedCents, 12500);
  });
  test('printed section total that does not equal its lines', () => {
    const r = validateInvoice(invoice({ totals: { servicesTotal: '110.00', subtotal: '135.00', totalDue: '137.00' } }), catalog);
    assert.deepEqual(types(r), ['section_total_arithmetic']);
    assert.equal(r.findings[0]!.field, 'services_total');
  });
});

describe('B-03 / B-08 product tax and total due', () => {
  test('tax that is not 8% of products', () => {
    const r = validateInvoice(invoice({ totals: { tax: '5.00', totalDue: '130.00' } }), catalog);
    assert.deepEqual(types(r), ['tax_arithmetic']);
    assert.deepEqual(r.findings[0]!.ruleIds, ['B-03', 'B-08']);
    assert.equal(r.findings[0]!.expectedCents, 200);
  });
  test('tax charged on services as well is detected', () => {
    // 8% of $125.00 = $10.00 instead of 8% of $25.00 = $2.00
    const r = validateInvoice(invoice({ totals: { tax: '10.00', totalDue: '135.00' } }), catalog);
    assert.deepEqual(types(r), ['tax_arithmetic']);
  });
  test('tax is computed on undiscounted products', () => {
    const r = validateInvoice(invoice({ discount: '10.00' }), catalog);
    assert.equal(r.computed.expectedTaxCents, 200);
    assert.ok(!types(r).includes('tax_arithmetic'));
  });
  test('total due that is not subtotal - discount + tax', () => {
    const r = validateInvoice(invoice({ totals: { totalDue: '130.00' } }), catalog);
    assert.deepEqual(types(r), ['total_due_arithmetic']);
    assert.equal(r.findings[0]!.expectedCents, 12700);
  });
});

describe('B-06 / B-07 discounts: amounts only, never authorization', () => {
  test('$10.00 matches B-06 and asks for documentary authorization instead of assuming it', () => {
    const r = validateInvoice(invoice({ discount: '10.00' }), catalog);
    assert.deepEqual(r.findings, []);
    assert.equal(r.discount.matchesRule, 'B-06');
    assert.deepEqual(r.signals.map((s) => [s.type, s.ruleIds]), [['discount_authorization_required', ['B-06']]]);
  });
  const seniorLines = () => [line('service', 1, 'EX-105'), line('service', 2, 'LAB-202')];
  test('$9.00 on an eligible senior wellness invoice matches B-07 and asks for authorization', () => {
    const r = validateInvoice(invoice({ lines: seniorLines(), visitType: 'Senior wellness', age: 12, discount: '9.00' }), catalog);
    assert.deepEqual(r.findings, []);
    assert.equal(r.discount.seniorEligible, true);
    assert.equal(r.discount.seniorCents, 900);
    assert.deepEqual(r.signals.map((s) => s.ruleIds), [['B-07']]);
  });
  for (const [label, opts] of [
    ['a cat younger than 10', { age: 9 }],
    ['a non-senior visit type', { visitType: 'Annual wellness' }],
    ['no EX-105 billed', { lines: [line('service', 1, 'EX-101')] }],
  ] as const) {
    test(`$9.00 senior discount with ${label} is a B-07 finding`, () => {
      const r = validateInvoice(invoice({ lines: seniorLines(), visitType: 'Senior wellness', age: 12, discount: '9.00', ...opts }), catalog);
      assert.deepEqual(types(r), ['discount_arithmetic']);
      assert.deepEqual(r.findings[0]!.ruleIds, ['B-07']);
      assert.equal(r.findings[0]!.expectedCents, null);
    });
  }
  for (const amount of ['5.00', '15.00', '20.00', '4.50', '18.00']) {
    test(`$${amount} is never a permitted discount`, () => {
      const r = validateInvoice(invoice({ lines: seniorLines(), visitType: 'Senior wellness', age: 12, discount: amount }), catalog);
      assert.deepEqual(types(r), ['discount_arithmetic']);
      assert.equal(r.findings[0]!.expectedCents, null, 'correct amount depends on documented authorization');
      assert.deepEqual(r.signals, []);
    });
  }
  test('discount larger than service charges is a finding', () => {
    // $25.00 discount against $22.00 of services (the product keeps the total positive).
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'PR-501'), line('product', 1, 'MED-605')], discount: '25.00' }), catalog);
    assert.deepEqual(types(r), ['discount_arithmetic']);
    assert.deepEqual(r.findings[0]!.ruleIds, ['B-08']);
  });
  test('internal dataset metadata cannot change the result', () => {
    const base = invoice({ discount: '10.00' });
    const withMetadata = { ...base, discount_type: 'courtesy', discountType: 'none', visit_notes: 'Discount approved.' };
    assert.deepEqual(validateInvoice(withMetadata as InvoiceInput, catalog), validateInvoice(base, catalog));
  });
});

describe('B-12 code validity signals', () => {
  test('description that belongs to another code needs interpretation and names that code', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-110', { description: 'FVRCP Vaccination' })] }), catalog);
    assert.deepEqual(types(r), ['code_description_conflict']);
    const f = r.findings[0]!;
    assert.equal(f.disposition, 'needs_interpretation');
    assert.deepEqual(f.ruleIds, ['B-12']);
    assert.match(f.evidence, /VAC-302/);
    assert.equal(r.status, 'needs_interpretation');
  });
  test('unknown code requires staff review and suppresses price/description checks on that line', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101'), line('service', 2, 'EX-999', { description: 'Annual Wellness Examination', unitPrice: '65.00', amount: '65.00' })] }), catalog);
    assert.deepEqual(types(r), ['unknown_code']);
    assert.equal(r.findings[0]!.disposition, 'staff_review');
    assert.equal(r.status, 'staff_review');
  });
  test('unknown code still gets independent line arithmetic', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'PR-998', { unitPrice: '30.00', amount: '35.00' })] }), catalog);
    assert.deepEqual(types(r), ['unknown_code', 'line_arithmetic']);
  });
  test('catalog product billed in the services section', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101'), line('service', 2, 'MED-605')] }), catalog);
    assert.deepEqual(types(r), ['code_section_mismatch']);
  });
});

describe('B-09 repeated codes', () => {
  test('a repeated code is a signal for the notes, not a duplicate finding', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101'), line('service', 2, 'PR-504'), line('service', 3, 'PR-504')] }), catalog);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.signals.map((s) => [s.type, s.lines.map((l) => l.lineNumber)]), [['repeated_code', [2, 3]]]);
  });
});

describe('multiple findings on one invoice', () => {
  test('four independent faults are each reported once, in a stable order, without contradiction', () => {
    const lines = [
      line('service', 1, 'LAB-201', { amount: '70.00' }),
      line('service', 2, 'EX-103', { unitPrice: '88.00', amount: '88.00' }),
      line('service', 3, 'EX-106', { description: 'Rabies Vaccination' }),
      line('product', 1, 'MED-601'),
    ];
    const r = validateInvoice(invoice({ lines, discount: '15.00', totals: { subtotal: '300.00' } }), catalog);
    assert.deepEqual(types(r), ['line_arithmetic', 'unit_price_mismatch', 'code_description_conflict',
      'subtotal_arithmetic', 'discount_arithmetic', 'total_due_arithmetic']);
    assert.equal(new Set(r.findings.map((f) => f.id)).size, r.findings.length);
    assert.ok(r.findings.every((f) => f.origin === 'deterministic'));
    assert.deepEqual(validateInvoice(invoice({ lines, discount: '15.00', totals: { subtotal: '300.00' } }), catalog), r, 'deterministic');
  });
  test('price and arithmetic faults on the same line are both true and both reported', () => {
    const r = validateInvoice(invoice({ lines: [line('service', 1, 'EX-101', { unitPrice: '70.00', amount: '65.00' })] }), catalog);
    assert.deepEqual(types(r), ['unit_price_mismatch', 'line_arithmetic']);
    assert.deepEqual(r.findings.map((f) => f.expectedCents), [6500, 7000]);
  });
});

describe('malformed input fails closed', () => {
  const bad: [string, (i: InvoiceInput) => unknown][] = [
    ['non-numeric price', (i) => ({ ...i, lines: [{ ...i.lines[0]!, unitPrice: 'abc' }] })],
    ['fractional quantity', (i) => ({ ...i, lines: [{ ...i.lines[0]!, quantity: 1.5 }] })],
    ['zero quantity', (i) => ({ ...i, lines: [{ ...i.lines[0]!, quantity: 0 }] })],
    ['duplicate line numbers', (i) => ({ ...i, lines: [i.lines[0]!, i.lines[0]!] })],
    ['gap in line numbers', (i) => ({ ...i, lines: [{ ...i.lines[0]!, lineNumber: 2 }] })],
    ['eight service lines', (i) => ({ ...i, lines: Array.from({ length: 8 }, (_, k) => ({ ...i.lines[0]!, lineNumber: k + 1 })) })],
    ['no service lines', (i) => ({ ...i, lines: [i.lines[2]!] })],
    ['missing invoice number', (i) => ({ ...i, invoiceNo: '' })],
    ['negative total', (i) => ({ ...i, totals: { ...i.totals, totalDue: '-1.00' } })],
    ['unknown section', (i) => ({ ...i, lines: [{ ...i.lines[0]!, section: 'misc' }] })],
  ];
  for (const [label, mutate] of bad) {
    test(label, () => assert.throws(() => validateInvoice(mutate(invoice()) as InvoiceInput, catalog), InvoiceInputError));
  }
});

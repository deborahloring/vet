// Unified response composition: merging, de-duplication, outcomes and wording.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AiFinding, DiscountAuthorization, InterpretationSuccess } from '../../src/api/ports.ts';
import { validateInvoice, type InvoiceInput, type InvoiceLineInput } from '../../src/billing/index.ts';
import { composeReview, composer } from '../../src/compose/composer.ts';
import { loadCatalog } from '../helpers/dataset.ts';

const catalog = loadCatalog();
const money = (c: number) => (c / 100).toFixed(2);

function invoice(lines: InvoiceLineInput[], opts: { discount?: number; subtotalDelta?: number; visitType?: string; age?: number } = {}): InvoiceInput {
  const sum = (s: string) => lines.filter((l) => l.section === s).reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0);
  const services = sum('service'); const products = sum('product');
  const subtotal = services + products + (opts.subtotalDelta ?? 0);
  const discount = opts.discount ?? 0; const tax = Math.floor((products * 16 + 100) / 200);
  return { invoiceNo: 'PO-FIXT-0002', visitType: opts.visitType ?? 'Annual wellness', patientAgeYears: opts.age ?? 5, lines,
    totals: { servicesTotal: money(services), productsTotal: money(products), subtotal: money(subtotal), discount: money(discount),
      tax: money(tax), totalDue: money(subtotal - discount + tax) } };
}
const l = (section: 'service' | 'product', n: number, code: string, qty = 1, over: Partial<InvoiceLineInput> = {}): InvoiceLineInput => {
  const e = catalog.byCode.get(code);
  const unit = e?.standardUnitPriceCents ?? 5000;
  return { section, lineNumber: n, code, description: e?.description ?? 'Unlisted', quantity: qty, unitPrice: money(unit), amount: money(unit * qty), ...over };
};
const ai = (type: AiFinding['type'], n: number, code: string, disposition: AiFinding['disposition'] = 'discrepancy'): AiFinding => ({
  id: `service:${n}:${type}`, type, origin: 'ai', ruleIds: [type === 'duplicate_service' ? 'B-09' : disposition === 'staff_review' ? 'B-13' : 'B-11'],
  disposition, line: { section: 'service', lineNumber: n, code }, secondaryLine: null, noteExcerpt: 'excerpt', evidence: `AI evidence for ${code}.`,
});
const interp = (findings: AiFinding[] = [], discount: DiscountAuthorization = { status: 'none', noteExcerpt: null }): InterpretationSuccess =>
  ({ ok: true, findings, discount, rejected: 0, usage: null });
const run = (inv: InvoiceInput, i: InterpretationSuccess) => composeReview(validateInvoice(inv, catalog), i);

describe('outcomes', () => {
  test('nothing found by either source: no_discrepancy_found', () => {
    const r = run(invoice([l('service', 1, 'EX-101'), l('service', 2, 'VAC-301')]), interp());
    assert.deepEqual([r.outcome, r.findings, r.provenance], ['no_discrepancy_found', [], { deterministic: 0, ai: 0, combined: 0 }]);
  });
  test('discrepancies from both sources are kept independently', () => {
    const inv = invoice([l('service', 1, 'EX-101', 1, { amount: '70.00' }), l('service', 2, 'VAC-301'), l('service', 3, 'PR-501')]);
    const r = run(inv, interp([ai('declined_service_billed', 2, 'VAC-301')]));
    assert.equal(r.outcome, 'discrepancy_identified');
    assert.deepEqual(r.findings.map((f) => [f.code, f.ruleRef]), [['EX-101', 'B-04'], ['VAC-301', 'B-11']]);
    assert.deepEqual(r.provenance, { deterministic: 1, ai: 1, combined: 0 });
  });
  test('two true findings on the same line are both reported (price and declined service)', () => {
    const inv = invoice([l('service', 1, 'EX-101'), l('service', 2, 'VAC-301', 1, { unitPrice: '44.00', amount: '44.00' })]);
    const r = run(inv, interp([ai('declined_service_billed', 2, 'VAC-301')]));
    assert.deepEqual(r.findings.map((f) => f.ruleRef), ['B-01', 'B-11']);
  });
  test('any staff-review item makes the outcome staff_review_required, keeping other findings', () => {
    const inv = invoice([l('service', 1, 'EX-101', 1, { amount: '70.00' }), l('service', 2, 'LAB-203')]);
    const r = run(inv, interp([ai('insufficient_documentation', 2, 'LAB-203', 'staff_review')]));
    assert.equal(r.outcome, 'staff_review_required');
    assert.equal(r.findings.length, 2);
  });
  test('an unknown code requires staff review', () => {
    const r = run(invoice([l('service', 1, 'EX-101'), l('service', 2, 'EX-999', 1, { description: 'Annual Wellness Examination' })]), interp());
    assert.equal(r.outcome, 'staff_review_required');
    assert.match(r.findings[0]!.explanation, /isn't in the hospital's service list/);
  });
  test('a code-description conflict is a discrepancy', () => {
    const r = run(invoice([l('service', 1, 'EX-110', 1, { description: 'FVRCP Vaccination' })]), interp());
    assert.deepEqual([r.outcome, r.findings[0]!.ruleRef], ['discrepancy_identified', 'B-12']);
  });
});

describe('discounts: at most one finding', () => {
  const lines = [l('service', 1, 'EX-101'), l('service', 2, 'VAC-301')];
  const courtesy: DiscountAuthorization = { status: 'courtesy', noteExcerpt: 'A $10 courtesy discount was authorized.' };
  test('authorized and printed amounts agree: no finding', () => {
    assert.deepEqual(run(invoice(lines, { discount: 1000 }), interp([], courtesy)).findings, []);
  });
  test('impermissible printed amount + documented authorization: one combined finding with the documented amount', () => {
    const r = run(invoice(lines, { discount: 1500 }), interp([], courtesy));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.ruleRef, 'B-06');
    assert.match(r.findings[0]!.evidence, /notes document a \$10\.00 courtesy discount, but the invoice shows a discount of \$15\.00/);
    assert.deepEqual(r.provenance, { deterministic: 0, ai: 0, combined: 1 });
  });
  test('impermissible printed amount, notes document no discount: one finding, documented amount $0.00', () => {
    const r = run(invoice(lines, { discount: 500 }), interp());
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.evidence, /notes document no discount, but the invoice shows a discount of \$5\.00/);
    assert.deepEqual(r.provenance, { deterministic: 0, ai: 0, combined: 1 });
  });
  test('impermissible printed amount, authorization unclear: one engine finding, no guessed amount', () => {
    const r = run(invoice(lines, { discount: 500 }), interp([], { status: 'unclear', noteExcerpt: null }));
    assert.equal(r.findings.length, 1);
    assert.doesNotMatch(r.findings[0]!.evidence, /notes document/);
    assert.deepEqual(r.provenance, { deterministic: 1, ai: 0, combined: 0 });
  });
  test('authorized discount omitted ($0 printed): combined discrepancy the engine alone cannot see', () => {
    const r = run(invoice(lines), interp([], courtesy));
    assert.deepEqual([r.outcome, r.findings.length, r.findings[0]!.ruleRef], ['discrepancy_identified', 1, 'B-06']);
    assert.match(r.findings[0]!.explanation, /doesn't match what the visit notes record/);
  });
  test('$10 printed but only the $9 senior discount documented', () => {
    const senior = [l('service', 1, 'EX-105'), l('service', 2, 'LAB-202')];
    const r = run(invoice(senior, { discount: 1000, visitType: 'Senior wellness', age: 12 }), interp([], { status: 'senior', noteExcerpt: 'Senior discount approved.' }));
    assert.deepEqual([r.findings.length, r.findings[0]!.ruleRef], [1, 'B-07']);
  });
  test('unclear authorization is a staff-review item', () => {
    const r = run(invoice(lines, { discount: 1000 }), interp([], { status: 'unclear', noteExcerpt: null }));
    assert.equal(r.outcome, 'staff_review_required');
    assert.equal(r.findings.length, 1);
  });
});

describe('merging and contract', () => {
  test('repeated AI ids are not duplicated', () => {
    const inv = invoice([l('service', 1, 'EX-101'), l('service', 2, 'VAC-301')]);
    const r = run(inv, interp([ai('declined_service_billed', 2, 'VAC-301'), ai('declined_service_billed', 2, 'VAC-301')]));
    assert.equal(r.findings.length, 1);
  });
  test('findings are ordered: service lines, product lines, then invoice totals, discount last', () => {
    const inv = invoice([l('service', 1, 'EX-101'), l('service', 2, 'VAC-301', 1, { amount: '40.00' }), l('product', 1, 'MED-605', 1, { unitPrice: '30.00', amount: '30.00' })],
      { discount: 500, subtotalDelta: 1100 });
    const r = run(inv, interp([ai('declined_service_billed', 1, 'EX-101')]));
    assert.deepEqual(r.findings.map((f) => f.line ? `${f.line.section}:${f.line.lineNumber}` : `summary:${f.ruleRef}`),
      ['service:1', 'service:2', 'product:1', 'summary:B-05', 'summary:B-06/B-07']);
  });
  test('public findings carry only the contract fields; provenance stays internal', () => {
    const inv = invoice([l('service', 1, 'EX-101', 1, { amount: '70.00' }), l('service', 2, 'VAC-301')]);
    const result = composer.compose(validateInvoice(inv, catalog), interp([ai('declined_service_billed', 2, 'VAC-301')]));
    assert.deepEqual(Object.keys(result).sort(), ['findings', 'outcome', 'provenance']);
    for (const f of result.findings) assert.deepEqual(Object.keys(f).sort(), ['code', 'evidence', 'explanation', 'line', 'ruleRef']);
    const text = JSON.stringify(result.findings);
    for (const leaked of ['"origin"', 'deterministic', '"ai"', 'combined', 'noteExcerpt']) assert.ok(!text.includes(leaked), leaked);
  });
  test('explanations are application wording: every one names staff and none promises money back', () => {
    const inv = invoice([l('service', 1, 'EX-101', 1, { unitPrice: '70.00', amount: '75.00' }), l('service', 2, 'VAC-301'), l('service', 3, 'EX-999')], { discount: 500 });
    const r = run(inv, interp([ai('declined_service_billed', 2, 'VAC-301')], { status: 'unclear', noteExcerpt: null }));
    for (const f of r.findings) {
      assert.match(f.explanation, /[Ss]taff/);
      assert.doesNotMatch(f.explanation, /refund|credit|you (will|are) (owed|get)|approved|guarantee/i);
    }
  });
});

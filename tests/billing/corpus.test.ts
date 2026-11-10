// Runs the engine over all 300 public synthetic invoices (no private answers used).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateInvoice, type DeterministicResult } from '../../src/billing/index.ts';
import { loadCatalog, loadInvoices } from '../helpers/dataset.ts';

const catalog = loadCatalog();
const invoices = loadInvoices();
const results = invoices.map((invoice) => validateInvoice(invoice, catalog));

test('all 300 public invoices validate without input errors', () => {
  assert.equal(invoices.length, 300);
  assert.equal(results.length, 300);
});

test('results are deterministic', () => {
  assert.deepEqual(invoices.map((invoice) => validateInvoice(invoice, catalog)), results);
});

test('finding IDs are unique per invoice and every finding is deterministic with rule IDs', () => {
  for (const r of results) {
    assert.equal(new Set(r.findings.map((f) => f.id)).size, r.findings.length, r.invoiceNo);
    for (const f of r.findings) {
      assert.equal(f.origin, 'deterministic');
      assert.ok(f.ruleIds.length > 0 && f.ruleIds.every((id) => /^B-(0[1-9]|1[0-3])$/.test(id)), `${r.invoiceNo} ${f.id}`);
      assert.ok(f.evidence.length > 0);
    }
  }
});

test('no contradictory findings: an unknown code never also gets price or description findings', () => {
  for (const r of results) {
    const unknown = new Set(r.findings.filter((f) => f.type === 'unknown_code').map((f) => `${f.line!.section}:${f.line!.lineNumber}`));
    for (const f of r.findings) {
      if (f.line && unknown.has(`${f.line.section}:${f.line.lineNumber}`)) {
        assert.ok(!['unit_price_mismatch', 'code_description_conflict', 'code_section_mismatch'].includes(f.type), `${r.invoiceNo} ${f.id}`);
      }
    }
  }
});

test('faults the dataset never contains are never reported (section totals, total due, section mismatch)', () => {
  const unexpected = results.flatMap((r) => r.findings)
    .filter((f) => ['section_total_arithmetic', 'total_due_arithmetic', 'code_section_mismatch'].includes(f.type));
  assert.deepEqual(unexpected, []);
});

test('every non-zero permitted discount is surfaced for documentary authorization, never assumed', () => {
  for (const r of results) {
    const asked = r.signals.some((s) => s.type === 'discount_authorization_required');
    assert.equal(asked, r.discount.matchesRule !== null, r.invoiceNo);
    if (r.discount.displayedCents === 0) assert.equal(asked, false, r.invoiceNo);
  }
});

test('the corpus exercises every deterministic finding type the dataset contains', () => {
  const seen = new Set(results.flatMap((r) => r.findings.map((f) => f.type)));
  for (const type of ['unit_price_mismatch', 'line_arithmetic', 'subtotal_arithmetic', 'discount_arithmetic',
    'tax_arithmetic', 'code_description_conflict', 'unknown_code']) {
    assert.ok(seen.has(type as DeterministicResult['findings'][number]['type']), type);
  }
  const statuses = new Set(results.map((r) => r.status));
  for (const s of ['clear', 'discrepancy', 'staff_review']) assert.ok(statuses.has(s as DeterministicResult['status']), s);
});

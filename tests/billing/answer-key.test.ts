// OPT-IN check against the private answer key. Skipped unless PAWS_PRIVATE_DATA_DIR is set.
// Reads the key from outside the repository, prints aggregate counts only, and never
// copies answers anywhere. The engine is not tuned from these results; they verify
// that the specified rules reproduce the dataset's deterministic findings.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateInvoice } from '../../src/billing/index.ts';
import { loadCatalog, loadInvoices, readCsv, REPO } from '../helpers/dataset.ts';

const dir = process.env['PAWS_PRIVATE_DATA_DIR'];
const skip = !dir ? 'set PAWS_PRIVATE_DATA_DIR to run against the private answer key' : false;

// Answer-key finding types that the deterministic engine is responsible for.
const FULLY_DETERMINISTIC = ['unit_price_mismatch', 'line_arithmetic', 'subtotal_arithmetic', 'tax_arithmetic',
  'code_description_conflict', 'unknown_code'];

test('deterministic findings match the private answer key', { skip }, () => {
  const root = resolve(dir!);
  assert.ok(!root.startsWith(resolve(REPO)), 'private answer key must be outside the repository');
  assert.ok(existsSync(join(root, 'expected_findings.csv')), 'expected_findings.csv not found');
  const expected = readCsv(join(root, 'expected_findings.csv'));
  const catalog = loadCatalog();
  const invoices = loadInvoices();
  const key = (inv: string, type: string, section: string, lineNo: string) => `${inv}|${type}|${section}|${lineNo}`;

  const engine = new Set<string>();
  const shownDiscount = new Map<string, number>();
  for (const invoice of invoices) {
    const r = validateInvoice(invoice, catalog);
    shownDiscount.set(invoice.invoiceNo, r.discount.displayedCents);
    for (const f of r.findings) {
      engine.add(key(invoice.invoiceNo, f.type, f.line?.section ?? 'summary', f.line ? String(f.line.lineNumber) : ''));
    }
  }
  const truth = new Map<string, string>();
  for (const f of expected) {
    if (FULLY_DETERMINISTIC.includes(f['finding_type']!) || f['finding_type'] === 'discount_arithmetic') {
      truth.set(key(f['invoice_no']!, f['finding_type']!, f['affected_section']!, f['affected_line']!), f['finding_type']!);
    }
  }

  const rows: Record<string, { expected: number; found: number; missed: number }> = {};
  for (const [k, type] of truth) {
    const row = (rows[type] ??= { expected: 0, found: 0, missed: 0 });
    row.expected++;
    if (engine.has(k)) row.found++; else row.missed++;
  }
  const falsePositives = [...engine].filter((k) => !truth.has(k));
  console.log('Deterministic engine vs private answer key (aggregate only):');
  for (const [type, r] of Object.entries(rows).sort()) console.log(`  ${type.padEnd(28)} expected ${r.expected}  found ${r.found}  missed ${r.missed}`);
  console.log(`  false positives: ${falsePositives.length}`);

  assert.equal(falsePositives.length, 0, 'engine reported findings the answer key does not contain');
  for (const type of FULLY_DETERMINISTIC) assert.equal(rows[type]?.missed ?? 0, 0, `${type} missed`);
  // Discount errors are only detectable without the notes when the printed amount is never
  // permitted. Wrong-but-permitted amounts ($0.00, $10.00) need documentary interpretation.
  for (const [k, type] of truth) {
    if (type !== 'discount_arithmetic' || engine.has(k)) continue;
    const shown = shownDiscount.get(k.split('|')[0]!)!;
    assert.ok(shown === 0 || shown === 1000, `undetected discount error with impermissible amount ${shown}`);
  }
});

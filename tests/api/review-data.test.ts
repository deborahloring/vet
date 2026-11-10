// The Worker's bundled data: fresh, allowlisted, verified, and free of private or internal fields.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReviewData, FORBIDDEN_TERMS, OUTPUT, pdfSource, renderModule } from '../../scripts/build-review-data.ts';
import { validateInvoice } from '../../src/billing/index.ts';
import { createDataSource } from '../../src/data/index.ts';
import { REVIEW_DATA } from '../../src/generated/review-data.ts';
import { loadInvoices, REPO } from '../helpers/dataset.ts';

test('src/generated/review-data.ts is up to date with the CSVs and config (run npm run build:data)', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8'), renderModule(buildReviewData()));
});

test('the visitor pool is the frozen public-characteristics selection: 30 invoices, 3 per visit type', async () => {
  const { candidates, selectPool, PUBLISHED_EXAMPLES } = await import('../../scripts/select-visitor-pool.ts');
  const pool = JSON.parse(readFileSync(join(REPO, 'config', 'review-invoices.json'), 'utf8')).invoices as string[];
  assert.deepEqual(pool, selectPool(candidates()));
  assert.equal(pool.length, 30);
  const types = new Map<string, number>();
  for (const c of candidates().filter((x) => pool.includes(x.invoiceNo))) types.set(c.visitType, (types.get(c.visitType) ?? 0) + 1);
  assert.deepEqual([...types.values()], Array(10).fill(3));
  for (const id of PUBLISHED_EXAMPLES) assert.ok(pool.includes(id), id);
  const selector = readFileSync(join(REPO, 'scripts', 'select-visitor-pool.ts'), 'utf8');
  assert.doesNotMatch(selector, /expected_|PAWS_PRIVATE|evaluation-private/, 'the selection never reads the private answer key');
});

test('only allowlisted invoices are bundled', () => {
  const allowlist = JSON.parse(readFileSync(join(REPO, 'config', 'review-invoices.json'), 'utf8')).invoices as string[];
  assert.deepEqual(REVIEW_DATA.invoices.map((r) => r.invoice.invoiceNo), [...allowlist].sort());
  assert.ok(REVIEW_DATA.invoices.length < 300, 'the full corpus is never bundled');
});

test('bundled invoice facts match the public CSVs exactly', () => {
  const fromCsv = new Map(loadInvoices().map((i) => [i.invoiceNo, i]));
  for (const record of REVIEW_DATA.invoices) assert.deepEqual(record.invoice, fromCsv.get(record.invoice.invoiceNo));
});

test('each bundled invoice references the SHA-256 of its approved PDF', () => {
  for (const record of REVIEW_DATA.invoices) {
    const source = pdfSource(REPO, record.invoice.invoiceNo);
    assert.ok(source, `${record.invoice.invoiceNo}: PDF missing (run npm run pdfs)`);
    const bytes = readFileSync(source);
    assert.equal(record.document.pdf.sha256, createHash('sha256').update(bytes).digest('hex'), record.invoice.invoiceNo);
  }
});

test('no private answers, internal metadata or client contact details are bundled', () => {
  const text = readFileSync(OUTPUT, 'utf8');
  for (const term of FORBIDDEN_TERMS) assert.ok(!text.includes(term), term);
  assert.ok(!/Carrotpatch Lane|\(800\) 555-/.test(text), 'client address/phone not needed for review');
  for (const record of REVIEW_DATA.invoices) {
    assert.deepEqual(Object.keys(record.invoice).sort(), ['invoiceNo', 'lines', 'patientAgeYears', 'totals', 'visitType']);
  }
});

test('every bundled invoice is valid input for the deterministic engine', () => {
  const source = createDataSource(REVIEW_DATA);
  for (const record of REVIEW_DATA.invoices) assert.doesNotThrow(() => validateInvoice(record.invoice, source.catalog));
});

test('Worker source never imports Node APIs or parses PDFs', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of files(join(REPO, 'src'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/from ['"]node:|require\(|pdf-?(lib|js|parse)|PdfReader/i.test(text), file);
  }
});

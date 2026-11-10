// Build-time step: turns the public synthetic CSVs into src/generated/review-data.ts,
// the only invoice data the Worker can see. No PDF parsing, no network, no private data.
//
// Usage:
//   node scripts/build-review-data.ts          write src/generated/review-data.ts
//   node scripts/build-review-data.ts --check  exit 1 if the generated file is stale

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildCatalog, validateInvoice, type CatalogRow, type InvoiceInput, type Section } from '../src/billing/index.ts';
import type { DemonstrationRecord, ReviewData, ReviewInvoiceRecord } from '../src/data/types.ts';
import { buildRequestBody } from '../src/gemini/prompt.ts';
import { parseModelJson, validateInterpretation } from '../src/gemini/parse.ts';
import { composer } from '../src/compose/composer.ts';
import { parseCsv } from './lib/csv.ts';

export const REPO = join(import.meta.dirname, '..');
export const OUTPUT = join(REPO, 'src', 'generated', 'review-data.ts');
const INVOICE_ID = /^PO-\d{4}-\d{4}$/;
// Answer-key vocabulary and internal metadata that must never reach the Worker bundle.
export const FORBIDDEN_TERMS = ['expected_outcome', 'primary_scenario', 'finding_type', 'scenario_types',
  'expected_total_due', 'note_evidence', 'expected_findings', 'expected_reviews', 'discount_type'];

const SOURCES = ['data/service_catalog.csv', 'data/visits.csv', 'data/invoice_items.csv', 'data/invoice_totals.csv',
  'data/patients.csv', 'config/review-invoices.json', 'config/demonstrations.json'];

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message: string): never {
  throw new Error(`build-review-data: ${message}`);
}

/** Committed example PDFs first, then PDFs generated at build time into the ignored invoices/ folder. */
export function pdfSource(repo: string, invoiceNo: string): string | null {
  for (const folder of ['examples', 'invoices']) {
    const path = join(repo, folder, `${invoiceNo}.pdf`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function buildReviewData(repo = REPO): ReviewData {
  const text = (path: string) => readFileSync(join(repo, path), 'utf8');
  // Text sources are hashed with LF line endings so the result is the same on every checkout.
  const sources = Object.fromEntries(SOURCES.map((path) => [path, sha256(text(path).replace(/\r\n/g, '\n'))]));

  const catalogRows = parseCsv(text('data/service_catalog.csv')).map((r): CatalogRow => ({
    code: r['code']!, section: r['section']!, description: r['description']!,
    standard_unit_price: r['standard_unit_price']!, taxable: r['taxable']!,
  }));
  const catalog = buildCatalog(catalogRows);

  const allowlist = JSON.parse(text('config/review-invoices.json')) as { invoices?: unknown };
  if (!Array.isArray(allowlist.invoices) || allowlist.invoices.length === 0) fail('config/review-invoices.json needs a non-empty "invoices" list');
  const wanted = allowlist.invoices.map(String);
  for (const id of wanted) if (!INVOICE_ID.test(id)) fail(`invalid invoice number ${JSON.stringify(id)}`);
  if (new Set(wanted).size !== wanted.length) fail('duplicate invoice numbers in the allowlist');

  const visits = new Map(parseCsv(text('data/visits.csv')).map((v) => [v['invoice_no']!, v]));
  const patients = new Map(parseCsv(text('data/patients.csv')).map((p) => [p['patient_id']!, p]));
  const totals = new Map(parseCsv(text('data/invoice_totals.csv')).map((t) => [t['invoice_no']!, t]));
  const items = parseCsv(text('data/invoice_items.csv'));

  const invoices = [...wanted].sort().map((invoiceNo): ReviewInvoiceRecord => {
    const visit = visits.get(invoiceNo) ?? fail(`${invoiceNo} is not in data/visits.csv`);
    const patient = patients.get(visit['patient_id']!) ?? fail(`${invoiceNo}: unknown patient`);
    const total = totals.get(invoiceNo) ?? fail(`${invoiceNo}: no totals`);
    const pdfPath = pdfSource(repo, invoiceNo);
    if (!pdfPath) fail(`${invoiceNo}: PDF not found in examples/ or invoices/ (run npm run pdfs)`);
    const invoice: InvoiceInput = {
      invoiceNo,
      visitType: visit['visit_type']!,
      patientAgeYears: Number(patient['age_years']),
      lines: items.filter((x) => x['invoice_no'] === invoiceNo)
        .map((x) => ({
          section: x['section'] as Section, lineNumber: Number(x['line_number']), code: x['code']!,
          description: x['description']!, quantity: Number(x['quantity']), unitPrice: x['unit_price']!, amount: x['amount']!,
        }))
        .sort((a, b) => (a.section === b.section ? 0 : a.section === 'service' ? -1 : 1) || a.lineNumber - b.lineNumber),
      totals: {
        servicesTotal: total['services_total']!, productsTotal: total['products_total']!, subtotal: total['subtotal']!,
        discount: total['discount']!, tax: total['tax']!, totalDue: total['total_due']!,
      },
    };
    validateInvoice(invoice, catalog); // malformed data fails the build, not a visitor request
    const document = {
      visitId: visit['visit_id']!, visitDate: visit['visit_date']!, issueDate: visit['issue_date']!,
      patientName: patient['pet_name']!, breed: patient['breed']!, veterinarian: visit['veterinarian']!,
      visitNotes: visit['visit_notes']!,
      pdf: { filename: `${invoiceNo}.pdf`, sha256: sha256(readFileSync(pdfPath)) },
    };
    buildRequestBody(invoice, document); // every bundled invoice must fit the Gemini prompt limits
    return { invoice, document };
  });

  const demoConfig = JSON.parse(text('config/demonstrations.json')) as { demonstrations?: unknown };
  if (!Array.isArray(demoConfig.demonstrations)) fail('config/demonstrations.json needs a "demonstrations" list');
  const demonstrations = demoConfig.demonstrations.map((d, i): DemonstrationRecord => {
    const record = d as { id?: unknown; title?: unknown; invoiceNo?: unknown; approved?: unknown;
      recording?: { source?: unknown; reply?: unknown } };
    const label = `demonstration ${i + 1}`;
    if (typeof record.id !== 'string' || !/^demo-\d{2}$/.test(record.id)) fail(`${label}: id must look like demo-01`);
    if (typeof record.title !== 'string' || !record.title.trim()) fail(`${label}: title is required`);
    if (typeof record.approved !== 'boolean') fail(`${label}: approved must be true or false`);
    const source = record.recording?.source;
    if (source !== 'provisional' && source !== 'live-recording') fail(`${label}: recording.source must be provisional or live-recording`);
    const pool = invoices.find((r) => r.invoice.invoiceNo === record.invoiceNo);
    if (!pool) fail(`${label}: ${String(record.invoiceNo)} is not in the visitor pool`);
    // Replay the recorded model reply through the same checker and composer as a live review.
    const checked = validateInterpretation(parseModelJson(JSON.stringify(record.recording?.reply)), pool.invoice, pool.document.visitNotes);
    // Hand-written provisional recordings must be fully supported; live recordings replay exactly as the live checker treats them.
    if (source === 'provisional' && checked.rejected !== 0) fail(`${label}: the provisional recording contains ${checked.rejected} claim(s) the checker rejects`);
    const composed = composer.compose(validateInvoice(pool.invoice, catalog), { ok: true, ...checked, usage: null });
    return {
      id: record.id, title: record.title.trim(), invoiceNo: pool.invoice.invoiceNo,
      provisional: !record.approved || source !== 'live-recording',
      result: { outcome: composed.outcome, findings: composed.findings },
    };
  });
  if (new Set(demonstrations.map((d) => d.id)).size !== demonstrations.length) fail('duplicate demonstration ids');

  return { schemaVersion: 1, sources, catalog: catalogRows, invoices, demonstrations };
}

export function renderModule(data: ReviewData): string {
  const body = JSON.stringify(data, null, 2);
  for (const term of FORBIDDEN_TERMS) if (body.includes(term)) fail(`generated data contains forbidden term "${term}"`);
  return [
    '// GENERATED by scripts/build-review-data.ts from public synthetic data. Do not edit by hand.',
    '// Regenerate with: npm run build:data',
    "import type { ReviewData } from '../data/types.ts';",
    '',
    `export const REVIEW_DATA: ReviewData = ${body};`,
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const rendered = renderModule(buildReviewData());
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== rendered) {
      console.error('FAIL: src/generated/review-data.ts is stale; run npm run build:data');
      process.exit(1);
    }
    console.log('PASS: src/generated/review-data.ts is up to date');
  } else {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, rendered, 'utf8');
    console.log(`Wrote ${OUTPUT}`);
  }
}

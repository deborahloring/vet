// Selects the 30-invoice live visitor pool from PUBLIC dataset characteristics only.
// The private answer key is never read. The selection is deterministic (fixed seed) and is
// frozen by writing config/review-invoices.json; later evaluation splits the remaining 270
// invoices into blind (150) and development (120) sets, so the visitor pool never overlaps
// the blind set.
//
// Usage: node scripts/select-visitor-pool.ts            write config/review-invoices.json
//        node scripts/select-visitor-pool.ts --check    exit 1 if the config differs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCsv } from './lib/csv.ts';

export const REPO = join(import.meta.dirname, '..');
export const CONFIG = join(REPO, 'config', 'review-invoices.json');
export const POOL_SIZE = 30;
export const PER_VISIT_TYPE = 3;
export const SEED = 20261109;
/** Already published in examples/ (committed), so they stay in the non-blind visitor pool. */
export const PUBLISHED_EXAMPLES = ['PO-2023-0005', 'PO-2024-0001', 'PO-2024-0003', 'PO-2025-0006'];

export interface Candidate {
  invoiceNo: string;
  visitType: string;
  year: string;
  serviceLines: number;
  hasProducts: boolean;
  printedDiscount: boolean;
  ageBand: string;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function candidates(repo = REPO): Candidate[] {
  const read = (name: string) => parseCsv(readFileSync(join(repo, 'data', name), 'utf8'));
  const patients = new Map(read('patients.csv').map((p) => [p['patient_id'], p]));
  const totals = new Map(read('invoice_totals.csv').map((t) => [t['invoice_no'], t]));
  const items = read('invoice_items.csv');
  return read('visits.csv').map((v) => {
    const lines = items.filter((x) => x['invoice_no'] === v['invoice_no']);
    const age = Number(patients.get(v['patient_id'])!['age_years']);
    return {
      invoiceNo: v['invoice_no']!,
      visitType: v['visit_type']!,
      year: v['visit_date']!.slice(0, 4),
      serviceLines: lines.filter((x) => x['section'] === 'service').length,
      hasProducts: lines.some((x) => x['section'] === 'product'),
      printedDiscount: Number(totals.get(v['invoice_no'])!['discount']) > 0,
      ageBand: age <= 2 ? 'young' : age >= 10 ? 'senior' : 'adult',
    };
  });
}

const features = (c: Candidate) => [`year:${c.year}`, `lines:${Math.min(c.serviceLines, 5)}`, `products:${c.hasProducts}`,
  `discount:${c.printedDiscount}`, `age:${c.ageBand}`];

export function selectPool(all: Candidate[]): string[] {
  const random = rng(SEED);
  const chosen: Candidate[] = all.filter((c) => PUBLISHED_EXAMPLES.includes(c.invoiceNo));
  const seen = new Map<string, number>();
  const note = (c: Candidate) => features(c).forEach((f) => seen.set(f, (seen.get(f) ?? 0) + 1));
  chosen.forEach(note);
  const order = [...all].map((c) => ({ c, r: random() })).sort((a, b) => a.r - b.r).map((x) => x.c);
  for (const type of [...new Set(all.map((c) => c.visitType))].sort()) {
    while (chosen.filter((c) => c.visitType === type).length < PER_VISIT_TYPE) {
      const pool = order.filter((c) => c.visitType === type && !chosen.includes(c));
      // Prefer the candidate whose characteristics are least represented so far (ties keep seeded order).
      const score = (c: Candidate) => features(c).reduce((s, f) => s + (seen.get(f) ?? 0), 0);
      const best = pool.reduce((a, b) => (score(b) < score(a) ? b : a));
      chosen.push(best);
      note(best);
    }
  }
  if (chosen.length !== POOL_SIZE) throw new Error(`select-visitor-pool: selected ${chosen.length}, expected ${POOL_SIZE}`);
  return chosen.map((c) => c.invoiceNo).sort();
}

export function renderConfig(invoices: string[]): string {
  return `${JSON.stringify({
    purpose: 'Server allowlist of the 30-invoice live visitor pool. Only these invoices are bundled into the Worker; their PDFs are generated at build time. Selected by scripts/select-visitor-pool.ts from public characteristics only (three per visit type, published examples kept, diverse year, line count, products, printed discount and age band); the private answer key was not used. These invoices are excluded from the blind evaluation set.',
    seed: SEED,
    invoices,
  }, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const rendered = renderConfig(selectPool(candidates()));
  if (process.argv.includes('--check')) {
    if (readFileSync(CONFIG, 'utf8').replace(/\r\n/g, '\n') !== rendered) {
      console.error('FAIL: config/review-invoices.json does not match the pool selection');
      process.exit(1);
    }
    console.log('PASS: visitor pool matches the selection');
  } else {
    writeFileSync(CONFIG, rendered);
    console.log(`Wrote ${CONFIG}`);
  }
}

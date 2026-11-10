// Public synthetic dataset loader for offline tools (evaluation runner, tests). Never reads
// private answer keys and is never bundled into the Worker.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogRow, InvoiceInput, Section } from '../../src/billing/index.ts';
import type { InvoiceDocument } from '../../src/data/types.ts';
import { parseCsv } from './csv.ts';

export const PUBLIC_FILES = ['service_catalog.csv', 'clients.csv', 'patients.csv', 'visits.csv', 'invoice_items.csv', 'invoice_totals.csv',
  'billing_rules.csv'];

export interface PublicRecord {
  invoice: InvoiceInput;
  document: InvoiceDocument;
}

export interface PublicDataset {
  catalog: CatalogRow[];
  records: Map<string, PublicRecord>;
  /** SHA-256 over the public CSVs (LF line endings), for reproducibility reports. */
  sha256: string;
}

export function loadPublicDataset(repo: string): PublicDataset {
  const text = (name: string) => readFileSync(join(repo, 'data', name), 'utf8');
  const hash = createHash('sha256');
  for (const name of PUBLIC_FILES) hash.update(`${name}\n`).update(text(name).replace(/\r\n/g, '\n'));
  const catalog = parseCsv(text('service_catalog.csv')).map((r): CatalogRow => ({
    code: r['code']!, section: r['section']!, description: r['description']!, standard_unit_price: r['standard_unit_price']!, taxable: r['taxable']!,
  }));
  const patients = new Map(parseCsv(text('patients.csv')).map((p) => [p['patient_id']!, p]));
  const totals = new Map(parseCsv(text('invoice_totals.csv')).map((t) => [t['invoice_no']!, t]));
  const items = new Map<string, Record<string, string>[]>();
  for (const x of parseCsv(text('invoice_items.csv'))) items.set(x['invoice_no']!, [...(items.get(x['invoice_no']!) ?? []), x]);
  const records = new Map<string, PublicRecord>();
  for (const v of parseCsv(text('visits.csv'))) {
    const no = v['invoice_no']!;
    const patient = patients.get(v['patient_id']!)!;
    const total = totals.get(no)!;
    const invoice: InvoiceInput = {
      invoiceNo: no,
      visitType: v['visit_type']!,
      patientAgeYears: Number(patient['age_years']),
      lines: (items.get(no) ?? [])
        .map((x) => ({ section: x['section'] as Section, lineNumber: Number(x['line_number']), code: x['code']!, description: x['description']!,
          quantity: Number(x['quantity']), unitPrice: x['unit_price']!, amount: x['amount']! }))
        .sort((a, b) => (a.section === b.section ? 0 : a.section === 'service' ? -1 : 1) || a.lineNumber - b.lineNumber),
      totals: { servicesTotal: total['services_total']!, productsTotal: total['products_total']!, subtotal: total['subtotal']!,
        discount: total['discount']!, tax: total['tax']!, totalDue: total['total_due']! },
    };
    const document: InvoiceDocument = {
      visitId: v['visit_id']!, visitDate: v['visit_date']!, issueDate: v['issue_date']!, patientName: patient['pet_name']!,
      breed: patient['breed']!, veterinarian: v['veterinarian']!, visitNotes: v['visit_notes']!, pdf: { filename: `${no}.pdf`, sha256: '' },
    };
    records.set(no, { invoice, document });
  }
  return { catalog, records, sha256: hash.digest('hex') };
}

// Test-only loaders for the public synthetic CSVs. The Worker never reads these files.

import { join } from 'node:path';
import { readCsv } from '../../scripts/lib/csv.ts';
import { buildCatalog, type Catalog, type CatalogRow, type InvoiceInput, type Section } from '../../src/billing/index.ts';

export const REPO = join(import.meta.dirname, '..', '..');
export const DATA = join(REPO, 'data');
export { readCsv };

export function loadCatalog(): Catalog {
  return buildCatalog(readCsv(join(DATA, 'service_catalog.csv')) as unknown as CatalogRow[]);
}

/**
 * Builds engine inputs from printed invoice facts only. visit_notes and the internal
 * discount_type metadata are intentionally not passed to the deterministic engine.
 */
export function loadInvoices(): InvoiceInput[] {
  const patients = new Map(readCsv(join(DATA, 'patients.csv')).map((p) => [p['patient_id'], p]));
  const totals = new Map(readCsv(join(DATA, 'invoice_totals.csv')).map((t) => [t['invoice_no'], t]));
  const items = new Map<string, Record<string, string>[]>();
  for (const item of readCsv(join(DATA, 'invoice_items.csv'))) {
    items.set(item['invoice_no']!, [...(items.get(item['invoice_no']!) ?? []), item]);
  }
  return readCsv(join(DATA, 'visits.csv')).map((v) => {
    const t = totals.get(v['invoice_no'])!;
    return {
      invoiceNo: v['invoice_no']!,
      visitType: v['visit_type']!,
      patientAgeYears: Number(patients.get(v['patient_id'])!['age_years']),
      lines: (items.get(v['invoice_no']!) ?? []).map((x) => ({
        section: x['section'] as Section,
        lineNumber: Number(x['line_number']),
        code: x['code']!,
        description: x['description']!,
        quantity: Number(x['quantity']),
        unitPrice: x['unit_price']!,
        amount: x['amount']!,
      })),
      totals: {
        servicesTotal: t['services_total']!, productsTotal: t['products_total']!, subtotal: t['subtotal']!,
        discount: t['discount']!, tax: t['tax']!, totalDue: t['total_due']!,
      },
    };
  });
}

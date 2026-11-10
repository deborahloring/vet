// Service catalog in integer cents, built from rows shaped like data/service_catalog.csv.
// The Worker receives these rows from build-time data; nothing here reads files.

import { InvoiceInputError } from './errors.ts';
import { parseCents } from './money.ts';
import type { Section } from './types.ts';

export interface CatalogRow {
  code: string;
  section: string;
  description: string;
  standard_unit_price: string;
  taxable: string;
}

export interface CatalogEntry {
  code: string;
  section: Section;
  description: string;
  standardUnitPriceCents: number;
  taxable: boolean;
}

export interface Catalog {
  byCode: ReadonlyMap<string, CatalogEntry>;
  byDescription: ReadonlyMap<string, CatalogEntry>;
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function buildCatalog(rows: readonly CatalogRow[]): Catalog {
  const byCode = new Map<string, CatalogEntry>();
  const byDescription = new Map<string, CatalogEntry>();
  for (const row of rows) {
    const code = normalizeText(row.code);
    if (row.section !== 'service' && row.section !== 'product') {
      throw new InvoiceInputError(`catalog ${code}: unknown section ${JSON.stringify(row.section)}`);
    }
    const taxable = row.taxable === 'yes';
    if ((row.section === 'product') !== taxable) {
      throw new InvoiceInputError(`catalog ${code}: only products are taxable under B-03`);
    }
    const entry: CatalogEntry = {
      code,
      section: row.section,
      description: normalizeText(row.description),
      standardUnitPriceCents: parseCents(row.standard_unit_price, `catalog ${code} price`),
      taxable,
    };
    if (byCode.has(code)) throw new InvoiceInputError(`catalog: duplicate code ${code}`);
    if (byDescription.has(entry.description)) throw new InvoiceInputError(`catalog: duplicate description ${entry.description}`);
    byCode.set(code, entry);
    byDescription.set(entry.description, entry);
  }
  if (byCode.size === 0) throw new InvoiceInputError('catalog is empty');
  return { byCode, byDescription };
}

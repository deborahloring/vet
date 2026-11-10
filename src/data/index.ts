// Runtime access to the build-time review data. Built once per isolate; no file or PDF access.

import { buildCatalog, type Catalog } from '../billing/index.ts';
import { REVIEW_DATA } from '../generated/review-data.ts';
import type { DemonstrationRecord, ReviewData, ReviewInvoiceRecord } from './types.ts';

export interface ReviewDataSource {
  catalog: Catalog;
  findInvoice(invoiceNo: string): ReviewInvoiceRecord | undefined;
  demonstrations: readonly DemonstrationRecord[];
}

export function createDataSource(data: ReviewData): ReviewDataSource {
  const catalog = buildCatalog(data.catalog);
  const byId = new Map(data.invoices.map((record) => [record.invoice.invoiceNo, record]));
  return {
    catalog,
    findInvoice: (invoiceNo) => byId.get(invoiceNo),
    demonstrations: data.demonstrations,
  };
}

let bundled: ReviewDataSource | undefined;
export function bundledDataSource(): ReviewDataSource {
  bundled ??= createDataSource(REVIEW_DATA);
  return bundled;
}

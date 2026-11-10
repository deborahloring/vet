// Shape of the build-time review data bundled into the Worker.
// Produced by scripts/build-review-data.ts from public CSVs; never from PDFs at request time.

import type { CatalogRow, InvoiceInput } from '../billing/index.ts';
import type { PublicFinding, ReviewOutcome } from '../api/contracts.ts';

/** Printed invoice context and visit notes for later documentary interpretation (Step 4). */
export interface InvoiceDocument {
  visitId: string;
  visitDate: string;
  issueDate: string;
  patientName: string;
  breed: string;
  veterinarian: string;
  visitNotes: string;
  /** The approved flattened PDF this record corresponds to. */
  pdf: { filename: string; sha256: string };
}

export interface ReviewInvoiceRecord {
  /** Printed facts for the deterministic engine. No dataset metadata such as discount_type. */
  invoice: InvoiceInput;
  document: InvoiceDocument;
}

/**
 * An in-kiosk replay. `result` was composed at build time by replaying a recorded model reply
 * through the live billing engine, response checker and composer; playback calls nothing.
 */
export interface DemonstrationRecord {
  id: string;
  title: string;
  invoiceNo: string;
  /** True until the owner approves the demonstration and a live recording replaces the provisional one. */
  provisional: boolean;
  result: { outcome: ReviewOutcome; findings: PublicFinding[] };
}

export interface ReviewData {
  schemaVersion: 1;
  /** SHA-256 of each source file, so stale generated data is detectable. */
  sources: Record<string, string>;
  catalog: CatalogRow[];
  invoices: ReviewInvoiceRecord[];
  demonstrations: DemonstrationRecord[];
}

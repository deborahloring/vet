// OWNER-RUN LIVE CHECK. Makes real requests to Google's Gemini API; run only with approval.
//
//   node scripts/check-gemini.ts --metadata   one model-metadata request (no generation)
//   node scripts/check-gemini.ts --sample     one generateContent request with a hand-written
//                                              fixture invoice (never a dataset/evaluation invoice)
//
// The API key is read only from the GEMINI_API_KEY environment variable of the current
// terminal session. This script never reads .dev.vars files and never prints the key.

import type { InterpretationInput } from '../src/api/ports.ts';
import { buildCatalog, validateInvoice, type InvoiceInput } from '../src/billing/index.ts';
import { REVIEW_DATA } from '../src/generated/review-data.ts';
import { GeminiInterpreter } from '../src/gemini/interpreter.ts';
import { APPROVED_GEMINI_MODELS, GEMINI_API_BASE, GEMINI_LIMITS } from '../src/gemini/model.ts';
import { buildRequestBody } from '../src/gemini/prompt.ts';
import { loadGeminiKey, scrubKey } from './lib/gemini-key.ts';

const MODEL = APPROVED_GEMINI_MODELS[0];
const key = loadGeminiKey(process.argv.includes('--key-from-deploy-vars'));
const mode = process.argv.includes('--sample') ? 'sample' : process.argv.includes('--metadata') ? 'metadata' : null;

function scrub(text: string): string {
  return scrubKey(text);
}

// Hand-written fixture: not drawn from the 300-invoice dataset, so no evaluation case is used.
const INVOICE: InvoiceInput = {
  invoiceNo: 'PO-LIVE-CHECK', visitType: 'Annual wellness', patientAgeYears: 6,
  lines: [
    { section: 'service', lineNumber: 1, code: 'EX-101', description: 'Annual Wellness Examination', quantity: 1, unitPrice: '65.00', amount: '65.00' },
    { section: 'service', lineNumber: 2, code: 'VAC-302', description: 'FVRCP Vaccination', quantity: 1, unitPrice: '40.00', amount: '40.00' },
    { section: 'service', lineNumber: 3, code: 'PR-501', description: 'Nail Trim', quantity: 2, unitPrice: '22.00', amount: '44.00' },
    { section: 'service', lineNumber: 4, code: 'LAB-203', description: 'Urinalysis', quantity: 1, unitPrice: '55.00', amount: '55.00' },
  ],
  totals: { servicesTotal: '204.00', productsTotal: '0.00', subtotal: '204.00', discount: '10.00', tax: '0.00', totalDue: '194.00' },
};
const NOTES = 'Annual exam completed. The owner declined the FVRCP vaccination today. Only one nail trim was done. '
  + 'The urinalysis result is awaiting clinician sign-off. A $10 courtesy discount was approved at the front desk.';
const EXPECTED = 'declined VAC-302 (line 2), quantity conflict PR-501 (line 3), insufficient documentation LAB-203 (line 4), courtesy discount';

async function metadata(): Promise<void> {
  const started = Date.now();
  const response = await fetch(`${GEMINI_API_BASE}/models/${MODEL}`, { headers: { 'x-goog-api-key': key } });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  console.log(`HTTP ${response.status} in ${Date.now() - started} ms`);
  if (!response.ok || !body) {
    console.log(scrub(JSON.stringify(body?.['error'] ?? body, null, 2)));
    process.exitCode = 1;
    return;
  }
  const pick = ['name', 'baseModelId', 'version', 'displayName', 'inputTokenLimit', 'outputTokenLimit', 'supportedGenerationMethods',
    'temperature', 'maxTemperature', 'thinking'];
  console.log(JSON.stringify(Object.fromEntries(pick.filter((k) => k in body).map((k) => [k, body[k]])), null, 2));
  const methods = (body['supportedGenerationMethods'] as string[] | undefined) ?? [];
  console.log(methods.includes('generateContent') ? 'OK: generateContent is supported.' : 'WARNING: generateContent is not listed.');
  if (typeof body['outputTokenLimit'] === 'number' && body['outputTokenLimit'] < GEMINI_LIMITS.maxOutputTokens) {
    console.log(`WARNING: outputTokenLimit is below the configured ${GEMINI_LIMITS.maxOutputTokens}.`);
  }
}

async function sample(): Promise<void> {
  const catalog = buildCatalog(REVIEW_DATA.catalog);
  const document = { visitId: 'VIS-LIVE', visitDate: '2026-01-05', issueDate: '2026-01-05', patientName: 'Fixture Cat', breed: 'Siamese',
    veterinarian: 'Dr. Fixture', visitNotes: NOTES, pdf: { filename: 'none.pdf', sha256: '0'.repeat(64) } };
  const input: InterpretationInput = { invoiceNo: INVOICE.invoiceNo, invoice: INVOICE, document, deterministic: validateInvoice(INVOICE, catalog) };
  console.log(`Prompt characters: ${JSON.stringify(buildRequestBody(INVOICE, document)).length}`);
  let requests = 0;
  const interpreter = new GeminiInterpreter({ apiKey: key, model: MODEL }, (url, init) => { requests++; return fetch(url, init); });
  const started = Date.now();
  const result = await interpreter.interpret(input);
  console.log(`Requests sent: ${requests}; elapsed ${Date.now() - started} ms (timeout ${GEMINI_LIMITS.timeoutMs} ms)`);
  if (!result.ok) {
    console.log(`Result: failed (${result.reason})`);
    process.exitCode = 1;
    return;
  }
  console.log(`Expected from the notes: ${EXPECTED}`);
  console.log('Accepted findings:');
  for (const f of result.findings) console.log(`  ${f.type} ${f.line.code} (line ${f.line.lineNumber}) [${f.disposition}] "${f.noteExcerpt}"`);
  console.log(`Discount authorization: ${result.discount.status}${result.discount.noteExcerpt ? ` "${result.discount.noteExcerpt}"` : ''}`);
  console.log(`Rejected model claims: ${result.rejected}`);
  console.log(`Tokens: ${result.usage ? `${result.usage.promptTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total` : 'not reported'}`);
}

if (!mode) {
  console.log('Usage: node scripts/check-gemini.ts --metadata | --sample   (live requests; owner approval required)');
  process.exit(2);
}
if (!key) {
  console.log('GEMINI_API_KEY is not set in this terminal session.');
  process.exit(2);
}
try {
  await (mode === 'metadata' ? metadata() : sample());
} catch (e) {
  console.log(`Request failed: ${scrub(e instanceof Error ? e.message : String(e))}`);
  process.exitCode = 1;
}

// Demonstration replays: composed at build time through the live checker and composer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateInvoice } from '../../src/billing/index.ts';
import { composer } from '../../src/compose/composer.ts';
import { createDataSource } from '../../src/data/index.ts';
import { REVIEW_DATA } from '../../src/generated/review-data.ts';
import { parseModelJson, validateInterpretation } from '../../src/gemini/parse.ts';
import { SAY } from '../../src/kiosk/format.js';
import { REPO } from '../helpers/dataset.ts';

const config = JSON.parse(readFileSync(join(REPO, 'config', 'demonstrations.json'), 'utf8')).demonstrations as
  { id: string; invoiceNo: string; recording: { source: string; reply: unknown } }[];
const pool = JSON.parse(readFileSync(join(REPO, 'config', 'review-invoices.json'), 'utf8')).invoices as string[];

test('nine demonstrations, all from the visitor pool, one per distinct visit type', () => {
  assert.equal(REVIEW_DATA.demonstrations.length, 9);
  assert.equal(new Set(REVIEW_DATA.demonstrations.map((d) => d.id)).size, 9);
  for (const d of REVIEW_DATA.demonstrations) assert.ok(pool.includes(d.invoiceNo), d.invoiceNo);
  const types = REVIEW_DATA.demonstrations.map((d) => REVIEW_DATA.invoices.find((r) => r.invoice.invoiceNo === d.invoiceNo)!.invoice.visitType);
  assert.equal(new Set(types).size, 9);
});

test('the demonstrations cover all three outcomes', () => {
  const outcomes = new Set(REVIEW_DATA.demonstrations.map((d) => d.result.outcome));
  assert.deepEqual([...outcomes].sort(), ['discrepancy_identified', 'no_discrepancy_found', 'staff_review_required']);
});

test('every replay equals running its recording through the live checker and composer today', () => {
  const catalog = createDataSource(REVIEW_DATA).catalog;
  for (const entry of config) {
    const record = REVIEW_DATA.invoices.find((r) => r.invoice.invoiceNo === entry.invoiceNo)!;
    const checked = validateInterpretation(parseModelJson(JSON.stringify(entry.recording.reply)), record.invoice, record.document.visitNotes);
    if (entry.recording.source === 'provisional') assert.equal(checked.rejected, 0, `${entry.id}: provisional recording contains unsupported claims`);
    const composed = composer.compose(validateInvoice(record.invoice, catalog), { ok: true, ...checked, usage: null });
    const replay = REVIEW_DATA.demonstrations.find((d) => d.id === entry.id)!;
    assert.deepEqual(replay.result, { outcome: composed.outcome, findings: composed.findings }, entry.id);
  }
});

test('a demonstration stays provisional until it is approved and its recording is live', () => {
  for (const entry of config as unknown as { id: string; approved: boolean; recording: { source: string } }[]) {
    const replay = REVIEW_DATA.demonstrations.find((d) => d.id === entry.id)!;
    assert.equal(replay.provisional, !entry.approved || entry.recording.source !== 'live-recording', entry.id);
  }
  // Release: all nine are owner-approved live recordings, so none is provisional.
  assert.ok(REVIEW_DATA.demonstrations.every((d) => !d.provisional), 'every released demonstration is approved and live');
});

test('demonstrations have no story: each goes straight to its recorded review', () => {
  for (const d of REVIEW_DATA.demonstrations) assert.ok(!('story' in d), d.id);
  for (const entry of config as unknown as Record<string, unknown>[]) assert.ok(!('story' in entry), String(entry['id']));
});

test('Temperance never promises money back or approves anything', () => {
  const lines = Object.values(SAY).flatMap((v) => (typeof v === 'function' ? [v('PO-0000-0000')] : v));
  for (const line of lines) assert.doesNotMatch(String(line), /refund|credit|owed|approved|guarantee|you will get/i);
});

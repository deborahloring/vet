// Replaces demonstration recordings in config/demonstrations.json with live model replies saved
// by `scripts/eval/run-eval.ts --live --recordings DIR` for the demonstration invoices.
// Each reply is replayed through the response checker; claims it rejects are dropped (as live) and counted.
// Owner approval is separate: entries stay provisional until each demonstration is approved.
//
// Usage: node scripts/apply-demo-recordings.ts --recordings <dir outside the repo>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseModelJson, validateInterpretation } from '../src/gemini/parse.ts';
import { loadPublicDataset } from './lib/dataset.ts';

const REPO = join(import.meta.dirname, '..');
const CONFIG = join(REPO, 'config', 'demonstrations.json');

export function applyRecordings(dir: string): string[] {
  const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { demonstrations: { id: string; invoiceNo: string; recording: unknown }[] };
  const dataset = loadPublicDataset(REPO);
  const updated: string[] = [];
  for (const demo of config.demonstrations) {
    const file = join(dir, `${demo.invoiceNo}.json`);
    if (!existsSync(file)) throw new Error(`apply-demo-recordings: no recording for ${demo.id} (${demo.invoiceNo})`);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { model: string; recordedAt: string; modelText: string };
    const record = dataset.records.get(demo.invoiceNo)!;
    const model = parseModelJson(saved.modelText);
    const checked = validateInterpretation(model, record.invoice, record.document.visitNotes);
    // Rejected claims are dropped on replay exactly as in a live review, so the replay shows what a visitor would see.
    demo.recording = { source: 'live-recording', model: saved.model, recordedAt: saved.recordedAt, rejectedClaims: checked.rejected, reply: model };
    updated.push(demo.id);
  }
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  return updated;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const i = process.argv.indexOf('--recordings');
  if (i < 0) { console.log('Usage: node scripts/apply-demo-recordings.ts --recordings DIR'); process.exit(2); }
  console.log(`Applied live recordings: ${applyRecordings(process.argv[i + 1]!).join(', ')}`);
}

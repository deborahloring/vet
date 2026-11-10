// LOCAL PREVIEW ONLY — never deployed. Serves dist/ through the real Worker router on
// http://127.0.0.1:8787 with local stand-ins for the two external services:
//   - sign-in: a fixed local test identity (Cloudflare Access is not involved);
//   - Gemini: a local stand-in that only reads discount sentences in the public notes and
//     reports no other findings (no network request is made; this is not AI output).
// Counters run on the real DeskState/SQLite code in memory. Billing checks and the
// combined response are the real implementations.
//
// Usage: npm run build && npm run preview:local
// Options (environment): PREVIEW_MODE=open|closed|interrupted|limit  (default open)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { DurableAllowanceStore } from '../src/allowance/durable-store.ts';
import type { SqlValue } from '../src/allowance/ledger.ts';
import { composer } from '../src/compose/composer.ts';
import type { Dependencies, InterpretationResult } from '../src/api/ports.ts';
import { handleRequest } from '../src/api/router.ts';
import { DeskState } from '../src/desk-state.ts';
import type { Env } from '../src/env.ts';

const REPO = join(import.meta.dirname, '..');
const DIST = join(REPO, 'dist');
const PORT = 8787;
const MODE = process.env['PREVIEW_MODE'] ?? 'open';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.pdf': 'application/pdf' };

const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(q: string, ...b: SqlValue[]) {
    const s = db.prepare(q);
    const rows = /^\s*(SELECT|WITH)/i.test(q) ? s.all(...b) : (s.run(...b), []);
    return { toArray: () => rows as Record<string, SqlValue>[] };
  } },
  transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};
const env: Env = { DESK_OPEN: MODE === 'closed' ? 'false' : 'true', VISITOR_DAILY_LIMIT: '3', SHARED_DAILY_LIMIT: MODE === 'limit' ? '1' : '50',
  RECORDING_URL: '', GEMINI_MODEL: 'gemini-3.5-flash-lite' };
const desk = new DeskState({ storage }, env);
env.DESK = { idFromName: (n) => n, get: () => ({ fetch: (r) => desk.fetch(r) }) };
env.ASSETS = {
  async fetch(request: Request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404 });
    let bytes: Buffer | string = readFileSync(file);
    if (extname(file) === '.html') {
      // Label every local page so screenshots are never mistaken for live results.
      bytes = bytes.toString('utf8').replace('Fictional demonstration. All clients, pets and invoices are synthetic.',
        'LOCAL PREVIEW: sign-in and Gemini are stand-ins, so results differ from the live system.');
    }
    return new Response(bytes, { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
  },
};

const deps: Dependencies = {
  identity: { verify: async () => ({ ok: true, identity: { visitorKey: 'f'.repeat(64) } }) },
  allowance: new DurableAllowanceStore(env.DESK),
  interpreter: {
    async interpret(input): Promise<InterpretationResult> {
      await new Promise((r) => setTimeout(r, 1200)); // visible waiting state
      if (MODE === 'interrupted') return { ok: false, reason: 'provider_error' };
      const sentence = input.document.visitNotes.split(/(?<=\.)\s+/)
        .find((s) => /(discount|reduction)/i.test(s) && /(approved|authorized|granted|confirmed|approval)/i.test(s) && !/\b(none|not)\b/i.test(s));
      const status = !sentence ? 'none' : /senior/i.test(sentence) ? 'senior' : 'courtesy';
      return { ok: true, findings: [], discount: { status, noteExcerpt: sentence ?? null }, rejected: 0, usage: null };
    },
  },
  composer,
  now: () => new Date(),
  newReviewId: () => crypto.randomUUID(),
  log: (e) => console.log('[preview]', JSON.stringify(e)),
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
}

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Preview-only driver page (not part of dist/) used for screenshots of each kiosk state.
  if (req.url?.startsWith('/preview-driver.js')) {
    res.writeHead(200, { 'content-type': TYPES['.js']! });
    res.end(readFileSync(join(REPO, 'scripts', 'preview-driver.js')));
    return;
  }
  if (req.url?.startsWith('/preview-driver')) {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8')
      .replace('</head>', '  <script type="module" src="/preview-driver.js"></script>\n</head>');
    res.writeHead(200, { 'content-type': TYPES['.html']! });
    res.end(html);
    return;
  }
  const response = await handleRequest(await toRequest(req), env, deps);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`LOCAL PREVIEW (mode: ${MODE}) at http://127.0.0.1:${PORT}/  — sign-in and Gemini are local stand-ins.`);
});

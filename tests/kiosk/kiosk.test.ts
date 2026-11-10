// Kiosk presentation helpers, build output, and static-asset security.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ART, buildKiosk, HEARTHY_HANDOFF, KEYBOARD_RECOLOR, KIOSK_FILES, KIOSK_SIGN, kioskContent, publicInvoices, publicRules, REMOVED_STATIC_PAPERS, applyArtEdits } from '../../scripts/build-kiosk.ts';
import { REVIEW_DATA } from '../../src/generated/review-data.ts';
import { FORBIDDEN_TERMS } from '../../scripts/build-review-data.ts';
import { ASSET_HEADERS, handleRequest } from '../../src/api/router.ts';
import type { Dependencies } from '../../src/api/ports.ts';
import * as format from '../../src/kiosk/format.js';
import { REPO } from '../helpers/dataset.ts';

describe('kiosk wording', () => {
  test('the three approved outcomes', () => {
    assert.equal(format.outcomeTitle('no_discrepancy_found'), 'No Discrepancy Found');
    assert.equal(format.outcomeTitle('discrepancy_identified'), 'Discrepancy Identified');
    assert.equal(format.outcomeTitle('staff_review_required'), 'Staff Review Required');
  });
  test('the attempt notice says starting a review uses one of the three daily reviews', () => {
    assert.match(format.ATTEMPT_NOTICE, /uses one of your live reviews/);
    assert.match(format.ATTEMPT_NOTICE, /one of your three daily reviews will be used/);
  });
  test('an interrupted review says plainly that the attempt was used', () => {
    assert.match(format.errorView(0, null, true).message, /attempt may have been used/);
  });
  test('results are advisory, and the billing department or staff decide', () => {
    assert.match(format.ADVISORY, /^This review is advisory\. The hospital billing department will review and finalize/);
    assert.match(format.DEMO_ADVISORY, /^This review is advisory\. Billing staff make every final decision\.$/);
    assert.match(format.MENU_NOTICE, /^No changes to your invoice can or will be made during this visit\./);
  });
  test('Temperance result lines', () => {
    assert.match(format.outcomeIntro('discrepancy_identified', 1), /one item that does not match/);
    assert.match(format.outcomeIntro('discrepancy_identified', 3), /3 items that do not match/);
    assert.match(format.outcomeIntro('staff_review_required', 1), /billing team member/);
    assert.match(format.outcomeIntro('no_discrepancy_found', 0), /did not find a discrepancy/);
  });
  test('finding headings name the line, code and rule', () => {
    assert.equal(format.findingHeading({ line: { section: 'service', lineNumber: 2 }, code: 'LAB-205', ruleRef: 'B-11' }), 'Service line 2 · LAB-205 · Rule B-11');
    assert.equal(format.findingHeading({ line: null, code: null, ruleRef: 'B-05' }), 'Invoice totals · Rule B-05');
  });
  test('reset text names midnight Pacific Time and the visitor’s local time', () => {
    assert.equal(format.resetText('2026-07-16T07:00:00.000Z', 'en-US', 'America/New_York'), 'Resets at midnight Pacific Time (Thu 3:00 AM your time).');
    assert.equal(format.resetText('2026-07-16T07:00:00.000Z', 'en-US', 'America/Los_Angeles'), 'Resets at midnight Pacific Time (Thu 12:00 AM your time).');
    assert.match(format.allowanceText({ remaining: 1, limit: 3, resetAt: '2026-07-16T07:00:00.000Z' }, 'en-US', 'UTC'), /^1 live review left today \(of 3\)/);
  });
  test('errors: sign-in, limits, interruption (with the server’s attempt-used message), closed', () => {
    assert.equal(format.errorView(401, { error: { code: 'authentication_required' } }).reload, true);
    assert.match(format.errorView(429, { error: { code: 'daily_limit_reached' } }).message, /demonstrations are still available/i);
    const used = 'The review could not be completed, and this attempt has been used. Demonstrations remain available.';
    assert.equal(format.errorView(503, { error: { code: 'service_interrupted', message: used } }, true).message, used);
    assert.equal(format.errorView(503, { error: { code: 'review_closed' } }).title, 'Live reviews are closed');
    const paused = format.errorView(503, { error: { code: 'live_reviews_paused' } });
    assert.equal(paused.title, 'Live reviews are paused');
    assert.match(paused.message, /No review was used/);
    assert.doesNotMatch(paused.message, /\d/, 'no quota numbers');
    assert.match(format.errorView(0, null, true).message, /attempt may have been used/);
  });
});

describe('kiosk source', () => {
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  test('no inline scripts, styles or event handlers (strict CSP)', () => {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\son[a-z]+=|style="/i);
  });
  test('no free-text inputs and no stored feedback', () => {
    for (const source of [html, js]) {
      assert.doesNotMatch(source, /<input|<textarea|contenteditable|localStorage|indexedDB|document\.cookie/i);
    }
    assert.doesNotMatch(html, /sessionStorage/);
  });
  test('session storage holds only the invoice numbers reviewed this visit, under one key', () => {
    const uses = js.match(/sessionStorage\.\w+\([^)]*\)/g) ?? [];
    assert.deepEqual(uses, ['sessionStorage.getItem(REVIEWED_KEY)', 'sessionStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])']);
    assert.match(js, /const REVIEWED_KEY = 'paws-and-order:reviewed-this-visit';/);
    assert.match(js, /try \{ return parseReviewed\(sessionStorage\.getItem\(REVIEWED_KEY\)\); \} catch \{ return new Set\(\); \}/, 'works without storage');
  });
  test('server text is never inserted as HTML', () => {
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  test('approved copy is used verbatim', () => {
    assert.ok(html.includes(`<p id="hearthy-text" aria-live="polite">${HEARTHY_HANDOFF}</p>`), 'no-JavaScript fallback is the approved line');
    assert.ok(html.includes('Your satisfaction is our pleasure. Thank you for stopping in, see you next time!'));
    assert.ok(html.includes('Paws &amp; Order Billing Assistance Terminal'));
    assert.ok(html.includes('kioskware v16.2.17'));
  });
  test('View Demonstrations is always present in the page chrome', () => {
    assert.match(html, /<header class="site-bar">[\s\S]*data-action="demos"[\s\S]*View Demonstrations[\s\S]*<\/header>/);
  });
  test('Temperance has no avatar image', () => {
    assert.doesNotMatch(html + js, /temperance[^"']*\.(png|svg|jpe?g|gif|webp)/i);
  });
});

describe('kiosk build', () => {
  test('dist contains the kiosk, only approved art, the public invoice list and allowlisted PDFs', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-'));
    try {
      const written = buildKiosk(REPO, out);
      for (const f of KIOSK_FILES) assert.ok(existsSync(join(out, f)), f);
      assert.deepEqual(readdirSync(join(out, 'art')).sort(), [...ART].sort());
      const invoices = JSON.parse(readFileSync(join(out, 'data', 'invoices.json'), 'utf8'));
      assert.deepEqual(invoices, publicInvoices());
      assert.deepEqual(Object.keys(invoices[0]).sort(), ['ageYears', 'breed', 'invoiceNo', 'lines', 'patientName', 'pdf', 'totals',
        'veterinarian', 'visitDate', 'visitNotes', 'visitType']);
      const text = JSON.stringify(invoices);
      for (const term of FORBIDDEN_TERMS) assert.ok(!text.includes(term), term);
      assert.ok(!/Carrotpatch|\(800\) 555-|discountType/.test(text), 'no client contact details or dataset metadata');
      // The on-screen invoice shows exactly the printed lines, totals and notes the engine and model reviewed.
      for (const inv of invoices) {
        const record = REVIEW_DATA.invoices.find((r) => r.invoice.invoiceNo === inv.invoiceNo)!;
        assert.deepEqual(inv.lines, record.invoice.lines);
        assert.deepEqual(inv.totals, record.invoice.totals);
        assert.equal(inv.visitNotes, record.document.visitNotes);
      }
      const rules = JSON.parse(readFileSync(join(out, 'data', 'rules.json'), 'utf8'));
      assert.deepEqual(rules, publicRules());
      assert.equal(rules.length, 13);
      assert.equal(readdirSync(join(out, 'invoices')).length, invoices.length);
      assert.ok(written.length > 0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('static assets through the Worker', () => {
  const deps = (ok: boolean): Dependencies => ({
    identity: { verify: async () => (ok ? { ok: true, identity: { visitorKey: 'a'.repeat(64) } } : { ok: false, reason: 'missing' }) },
    allowance: null, interpreter: null, composer: null, now: () => new Date(), newReviewId: () => 'x', log: () => {},
  });
  const env = { DESK_OPEN: 'false', VISITOR_DAILY_LIMIT: '3', SHARED_DAILY_LIMIT: '50', ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) } };
  test('assets need a verified sign-in', async () => {
    const r = await handleRequest(new Request('https://vet.deborahloring.com/'), env, deps(false));
    assert.equal(r.status, 401);
  });
  test('assets carry the security headers', async () => {
    const r = await handleRequest(new Request('https://vet.deborahloring.com/'), env, deps(true));
    assert.equal(r.status, 200);
    for (const [name, value] of Object.entries(ASSET_HEADERS)) assert.equal(r.headers.get(name), value, name);
    assert.equal(r.headers.get('content-type'), 'text/html');
  });
});

describe('approved scenes are embedded for animation without altering the artwork', () => {
  test('both scenes are inline SVG with unique, resolvable ids and the original accessible names', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-art-'));
    try {
      buildKiosk(REPO, out);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.equal((html.match(/<svg class="scene-art"/g) ?? []).length, 2);
      assert.doesNotMatch(html, /<img src="\/art\//);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate ids across scenes');
      const refs = [...html.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
      assert.deepEqual(refs.filter((r) => !ids.includes(r)), []);
      const source = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
      for (const alt of [...source.matchAll(/<img src="\/art\/[^"]+"[^>]*alt="([^"]+)"/g)].map((m) => m[1]!)) {
        assert.ok(html.includes(`aria-label="${alt}"`), 'scene keeps its accessible description');
      }
      // Hooks for later animation exist under their scene prefix.
      for (const id of ['desk-eyel', 'desk-eyer', 'desk-headg', 'desk-kiosk', 'ext-sky']) assert.ok(ids.includes(id), id);
      // Drawing content is unchanged apart from id prefixes.
      const original = applyArtEdits('hospital-scene-05.svg', readFileSync(join(REPO, 'local_docs', 'art', 'hospital-scene-05.svg'), 'utf8'));
      const paths = original.match(/\sd="[^"]*"/g) ?? [];
      assert.ok(paths.length > 50);
      assert.deepEqual(paths.filter((d) => !html.includes(d)), [], 'every drawing path is present unchanged');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\sstyle="/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('keyboard, narrow screens and motion', () => {
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  const css = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.css'), 'utf8');
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  test('scene click areas are mouse-only duplicates: out of the Tab order and hidden from assistive technology', () => {
    const hotspots = html.match(/<button[^>]*class="hotspot[^"]*"[^>]*>/g) ?? [];
    assert.equal(hotspots.length, 3);
    assert.ok(hotspots.some((h) => h.includes('hotspot-story') && h.includes('data-action="behind"')), 'the pinboard flyer opens Behind the Desk');
    for (const h of hotspots) assert.match(h, /tabindex="-1"[^>]*aria-hidden="true"/);
    for (const go of ['desk', 'terminal']) assert.match(html, new RegExp(`<button type="button" class="primary" data-go="${go}">`), `visible ${go} button`);
  });
  test('invoice tables scroll sideways inside a labelled, focusable region on small screens', () => {
    assert.match(js, /class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label'/);
    assert.match(css, /\.table-scroll \{ overflow-x: auto;/);
  });
  test('narrow screens stack actions, the invoice grid and the paper invoice', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 40rem)'));
    for (const rule of ['.actions { flex-direction: column; }', '.invoice-grid { grid-template-columns: 1fr; }']) assert.ok(narrow.includes(rule), rule);
    assert.match(css, /@media \(max-width: 64rem\) \{\s*\.terminal-screen\.with-paper \{ flex-direction: column;/);
  });
  test('every animation is switched off for reduced-motion preferences', () => {
    assert.ok((css.match(/animation:/g) ?? []).length >= 10);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
  });
  test('status changes are announced and new screens move focus to their heading', () => {
    assert.match(html, /id="announcer" aria-live="polite"/);
    assert.match(js, /first\.setAttribute\('tabindex', '-1'\); first\.focus\(\);/);
    assert.match(js, /role: 'status'/);
  });
});

describe('Hearthy introduction and Behind the Desk', () => {
  const content = kioskContent();
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  test('the introduction is short and ends with the approved line verbatim', () => {
    assert.ok(content.hearthyIntro.length >= 2 && content.hearthyIntro.length <= 4);
    assert.equal(content.hearthyIntro.at(-1), HEARTHY_HANDOFF);
    assert.match(html, /id="intro-skip" data-go="terminal" hidden>Skip to the terminal</);
  });
  test('Behind the Desk is reachable from every screen and returns to where the visitor was', () => {
    assert.match(html, /<header class="site-bar">[\s\S]*data-action="behind"[\s\S]*<\/header>/);
    assert.match(html, /id="screen-behind"[\s\S]*data-action="back">Return</);
  });
  test('Behind the Desk discloses AI, fiction and synthetic results; it explains the design in general but never per-finding sources', () => {
    const text = JSON.stringify(content.behindTheDesk);
    assert.match(text, /AI-powered invoice assistant/);
    assert.match(text, /fictional/);
    assert.match(text, /Illustrations were created with AI assistance/);
    assert.match(text, /synthetic test cases designed to be challenging, not a measure of accuracy on real invoices/);
    assert.match(text, /keeps only an anonymous daily count, not names or email addresses/);
    assert.match(text, /3 reviews per visitor and 50 shared, resetting at midnight Pacific Time/);
    assert.doesNotMatch(text, /provenance|which finding|deterministic finding|AI finding/i);
    assert.doesNotMatch(text, /refund(s)? (are|is) (approved|issued)|guarantee/i);
  });
});

describe('rotating kiosk messages', () => {
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  test('the build publishes exactly the validated kiosk content from config/kiosk-content.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-ticker-'));
    try {
      buildKiosk(REPO, out);
      assert.deepEqual(JSON.parse(readFileSync(join(out, 'data', 'kiosk.json'), 'utf8')), kioskContent());
      assert.equal(kioskContent().rotatingMessages.length, 3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  test('the slot is hidden until messages exist, and rotation can be paused (WCAG 2.2.2)', () => {
    assert.match(html, /<div class="ticker" id="ticker" hidden>/);
    assert.match(html, /id="ticker-toggle" aria-pressed="false">Pause messages</);
    assert.match(js, /if \(!messages\.length\) return;/);
    assert.match(js, /prefers-reduced-motion: reduce/);
    assert.match(js, /if \(paused \|\| hovered \|\| box\.contains\(document\.activeElement\)/);
  });
});


describe('interior adjustments: dialogue panel, removed mid-air pages, keyboard colours', () => {
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  const css = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.css'), 'utf8');
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  test('Hearthy speaks in a subtitle panel under the scene, with her name and the Continue control inside it', () => {
    const desk = html.slice(html.indexOf('id="screen-desk"'), html.indexOf('id="screen-terminal"'));
    const panel = desk.slice(desk.indexOf('<div class="dialogue"'));
    assert.match(panel, /role="group" aria-labelledby="dialogue-speaker"/);
    assert.match(panel, /<p class="dialogue-speaker" id="dialogue-speaker">Hearthy<\/p>/);
    assert.match(panel, /<p id="hearthy-text" aria-live="polite">/);
    assert.match(panel, /<button type="button" class="primary" data-go="terminal">/);
    assert.match(panel, /id="intro-skip"/);
    assert.ok(desk.indexOf('class="art-frame"') < desk.indexOf('class="dialogue"'), 'panel follows the artwork');
    assert.doesNotMatch(desk, /class="speech"|class="scene-actions"/);
    assert.doesNotMatch(css, /\.speech\b/);
    assert.match(js, /document\.querySelector\('#screen-desk \.dialogue \.primary'\)/);
  });
  test('scenes are sized to the window height so the dialogue controls need no scrolling on short desktop windows', () => {
    assert.match(css, /\.stage\.stage-with-dialogue \{\s*width: min\(100%, 1200px, calc\(\(100vh - 12\.5rem\) \* 16 \/ 9\)\);\s*width: min\(100%, 1200px, calc\(\(100dvh - 12\.5rem\) \* 16 \/ 9\)\);/);
    assert.match(css, /@media \(max-height: 40rem\) and \(min-width: 40\.0625rem\)/);
    assert.match(css, /@container \(max-width: 46rem\)/);
    const narrow = css.slice(css.indexOf('@media (max-width: 40rem)'));
    assert.ok(narrow.includes('.dialogue { flex-direction: column;'), 'phones stack the panel');
  });
  test('the mid-air pages are removed and the keyboard recoloured; nothing else in the drawing changes', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-adjust-'));
    try {
      buildKiosk(REPO, out);
      const built = readFileSync(join(out, 'index.html'), 'utf8');
      for (const opening of REMOVED_STATIC_PAPERS) assert.ok(!built.includes(opening), opening);
      assert.ok(built.includes('<g transform="rotate(33 1032.0 827.0)">'), 'the floor pile stays');
      for (const [from, to] of [...KEYBOARD_RECOLOR, KIOSK_SIGN]) { assert.ok(!built.includes(from), from); assert.ok(built.includes(to), to); }
      assert.match(built, />The Story of<\/text>[\s\S]*?>Paws &amp; Order<\/text>/, 'the pinboard flyer keeps its title');
      assert.doesNotMatch(built, /#3b3e44|#c9ccd1/, 'no dark keyboard colours remain');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  test('the Help Wanted flyer is shortened and enlarged, and the door notice enlarged, outside and seen from inside', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-signs-'));
    try {
      buildKiosk(REPO, out);
      const built = readFileSync(join(out, 'index.html'), 'utf8');
      assert.doesNotMatch(built, /Must be reliable|neurotic mess|Bonus points|with cats preferred/, 'the long flyer text is gone everywhere');
      assert.equal((built.match(/>Apply Inside<\/text>/g) ?? []).length, 2, 'street side and mirrored inside');
      assert.equal((built.match(/textLength="124" lengthAdjust="spacingAndGlyphs"[^>]*>HELP WANTED<\/text>/g) ?? []).length, 2, 'HELP WANTED is fitted to the paper');
      assert.ok(built.includes('<rect x="649" y="273" width="136" height="92"'), 'wider, much shorter flyer outside');
      assert.ok(built.includes('<rect x="870" y="232" width="154" height="94"'), 'larger door notice outside');
      assert.equal((built.match(/>Short staffed\.<\/text>/g) ?? []).length, 2);
      // The flyer stays on the window glass (x 646-788 outside; 316-458 inside).
      for (const [x, lo, hi] of [[649, 646, 788], [319, 316, 458]]) assert.ok(x >= lo && x + 136 <= hi);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('invoices reviewed this visit', () => {
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  const inv = (n: string) => ({ invoiceNo: n });
  test('the stored list accepts only invoice numbers; anything else is an empty visit', () => {
    assert.deepEqual([...format.parseReviewed('["PO-2024-0003","PO-2025-0006"]')], ['PO-2024-0003', 'PO-2025-0006']);
    assert.deepEqual([...format.parseReviewed('["PO-2024-0003","<b>x</b>",7,null]')], ['PO-2024-0003']);
    for (const raw of [null, '', 'not json', '{"a":1}', '42']) assert.equal(format.parseReviewed(raw).size, 0, String(raw));
  });
  test('reviewed invoices move to their own section, keeping the original order', () => {
    const all = ['PO-1', 'PO-2', 'PO-3', 'PO-4'].map(inv);
    const groups = format.splitInvoices(all, new Set(['PO-3', 'PO-1']));
    assert.deepEqual(groups.available.map((i) => i.invoiceNo), ['PO-2', 'PO-4']);
    assert.deepEqual(groups.reviewed.map((i) => i.invoiceNo), ['PO-1', 'PO-3']);
  });
  test('an attempt counts as not used only when the server says it was refused before reservation', () => {
    for (const code of ['review_closed', 'daily_limit_reached', 'terminal_busy', 'live_reviews_paused', 'authentication_required']) {
      assert.equal(format.attemptNotUsed(503, { error: { code } }), true, code);
    }
    assert.equal(format.attemptNotUsed(503, { error: { code: 'service_interrupted' } }), false, 'interrupted after start');
    assert.equal(format.attemptNotUsed(500, { error: { code: 'internal_error' } }), false);
    assert.equal(format.attemptNotUsed(0, null), false, 'timeout or network failure');
    assert.equal(format.attemptNotUsed(200, { outcome: 'no_discrepancy_found' }), false);
  });
  test('the invoice is marked as the attempt begins, before the review request is sent', () => {
    const run = js.slice(js.indexOf('async function runReview'));
    assert.ok(run.indexOf('reviewed.add(inv.invoiceNo)') < run.indexOf("api('/api/review'"));
    assert.match(run, /if \(markedNow && attemptNotUsed\(r\.status, r\.body\)\) \{ reviewed\.delete/);
  });
  test('the selection screen has both sections, a Reviewed badge, and a confirmation before another live review', () => {
    assert.match(js, /'Available to Review'/);
    assert.match(js, /'Reviewed This Visit'/);
    assert.match(js, /el\('span', \{ class: 'pick-tag reviewed-tag' \}, 'Reviewed'\)/);
    assert.match(js, /reviewed\.has\(inv\.invoiceNo\) \? reviewAgainView\(inv\) : runReview\(inv\)/);
    const again = js.slice(js.indexOf('function reviewAgainView'), js.indexOf('async function runReview'));
    assert.match(again, /'Review Again'/);
    assert.match(again, /'Cancel'/);
    assert.match(again, /showPaper\(inv\)/, 'the invoice and its PDF link stay open');
    assert.match(format.SAY.reviewAgain('PO-2024-0003'), /uses one more of your live reviews/);
  });
});

describe('desk bell, Return to Hospital and ambient animation', () => {
  const html = readFileSync(join(REPO, 'src', 'kiosk', 'index.html'), 'utf8');
  const css = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.css'), 'utf8');
  const js = readFileSync(join(REPO, 'src', 'kiosk', 'kiosk.js'), 'utf8');
  test('the bell is a keyboard-operable button with a name; the floating word is hidden from assistive technology', () => {
    assert.match(html, /<button type="button" class="bell-button" id="desk-bell" aria-label="Ring the desk bell"><\/button>/);
    assert.doesNotMatch(html, /class="bell-button"[^>]*tabindex/);
    assert.match(html, /<span class="ding" id="ding" aria-hidden="true">Ding!<\/span>/);
    assert.match(css, /\.bell-button:focus-visible \{ outline: 3px solid/);
    assert.match(css, /min-width: 24px; min-height: 24px;/, 'target size');
    assert.match(js, /announce\('Ding!'\)/);
    assert.match(js, /clearTimeout\(state\.bellTimer\)/, 'repeated rings restart instead of stacking');
    assert.doesNotMatch(js, /new Audio|AudioContext|\.play\(/, 'no sound');
  });
  test('Return to Hospital is in the terminal header, goes to the interior, and is disabled while a review runs', () => {
    assert.match(html, /<button type="button" class="return-hospital" id="return-hospital" data-go="desk"><span aria-hidden="true">&larr; <\/span>Return to Hospital<\/button>/);
    const terminal = html.slice(html.indexOf('id="screen-terminal"'), html.indexOf('id="screen-behind"'));
    assert.ok(terminal.includes('id="return-hospital"'));
    assert.match(js, /\$\('return-hospital'\)\.disabled = true;/);
    assert.match(js, /\$\('return-hospital'\)\.disabled = false;/);
    assert.match(js, /if \(go === 'terminal'\) \{ show\('terminal'\); if \(!body\(\)\.childElementCount\) menuView\(\); \}/, 'returns to where the visitor left off');
    assert.match(js, /let index = state\.introSeen \? lines\.length - 1 : 0;/, 'the introduction is not replayed on return');
  });
  test('the build adds animation hooks without changing any drawing, and Hearthy moves within the first seconds', () => {
    const out = mkdtempSync(join(tmpdir(), 'kiosk-anim-'));
    try {
      buildKiosk(REPO, out);
      const built = readFileSync(join(out, 'index.html'), 'utf8');
      for (const id of ['desk-anim-fan-head', 'desk-anim-fan-blades', 'desk-anim-calendar', 'desk-anim-flyer', 'desk-anim-bell',
        'desk-anim-page-1', 'desk-anim-page-2', 'desk-anim-steam-1', 'ext-anim-clouds', 'ext-anim-canopy']) {
        assert.ok(built.includes(`id="${id}"`), id);
      }
      for (const file of ART) {
        const original = applyArtEdits(file, readFileSync(join(REPO, 'local_docs', 'art', file), 'utf8'));
        const paths = original.match(/\sd="[^"]*"/g) ?? [];
        assert.deepEqual(paths.filter((d) => !built.includes(d)), [], `${file}: every drawing path is present unchanged`);
      }
      assert.doesNotMatch(built, /\sstyle="/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    assert.match(css, /@keyframes hearthy-blink \{ 0%, 10%, 14%/, 'first blink under a second after entering');
    assert.match(css, /@keyframes cursor-blink/, 'the waiting cursor keeps its own blink');
    assert.equal((css.match(/@keyframes blink\b/g) ?? []).length, 0, 'no duplicate keyframe name');
  });
});

// Builds the static kiosk into dist/ (git-ignored), served only through the Worker after
// Cloudflare Access verification. Copies the two approved scene SVGs from local_docs/art
// (never committed), the kiosk files, and a public invoice list for allowlisted invoices.
//
// Usage: node scripts/build-kiosk.ts

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REVIEW_DATA } from '../src/generated/review-data.ts';
import { FORBIDDEN_TERMS, pdfSource } from './build-review-data.ts';
import { parseCsv } from './lib/csv.ts';

export const REPO = join(import.meta.dirname, '..');
export const DIST = join(REPO, 'dist');
export const KIOSK_FILES = ['index.html', 'kiosk.css', 'kiosk.js', 'format.js'];
/** Approved artwork used by the kiosk (local_docs/02-art-direction.md). Hearthy appears inside the interior scene. */
export const ART = ['hospital-exterior-02.svg', 'hospital-scene-05.svg'];

/** What the visitor's printed invoice shows (client address and phone are left out). */
export interface PublicInvoice {
  invoiceNo: string;
  patientName: string;
  breed: string;
  ageYears: number;
  visitType: string;
  visitDate: string;
  veterinarian: string;
  lines: { section: 'service' | 'product'; lineNumber: number; code: string; description: string;
    quantity: number; unitPrice: string; amount: string }[];
  totals: { servicesTotal: string; productsTotal: string; subtotal: string; discount: string; tax: string; totalDue: string };
  visitNotes: string;
  pdf: string;
}

export interface PublicRule {
  id: string;
  name: string;
}

export function publicInvoices(): PublicInvoice[] {
  return REVIEW_DATA.invoices.map((r) => ({
    invoiceNo: r.invoice.invoiceNo,
    patientName: r.document.patientName,
    breed: r.document.breed,
    ageYears: r.invoice.patientAgeYears,
    visitType: r.invoice.visitType,
    visitDate: r.document.visitDate,
    veterinarian: r.document.veterinarian,
    lines: r.invoice.lines.map((l) => ({ ...l })),
    totals: { ...r.invoice.totals },
    visitNotes: r.document.visitNotes,
    pdf: `/invoices/${r.document.pdf.filename}`,
  }));
}

/** Short public names for billing rules, from data/billing_rules.csv. */
export function publicRules(repo = REPO): PublicRule[] {
  return parseCsv(readFileSync(join(repo, 'data', 'billing_rules.csv'), 'utf8'))
    .map((r) => ({ id: r['rule_id']!, name: r['rule_name']! }));
}

/** Scene prefixes keep IDs unique when both SVGs are in one document. */
export const ART_PREFIX: Record<string, string> = { 'hospital-exterior-02.svg': 'ext', 'hospital-scene-05.svg': 'desk' };

/**
 * Replaces `<img src="/art/FILE">` with the SVG itself so its parts can be animated with
 * external CSS. The artwork is unchanged except that every id (and every reference to it) is
 * prefixed, and the img's alt text becomes the accessible name.
 */
export function inlineArt(html: string, file: string, svg: string): string {
  const prefix = ART_PREFIX[file];
  if (!prefix) throw new Error(`build-kiosk: no prefix for ${file}`);
  const img = new RegExp(`<img src="/art/${file.replace('.', '\\.')}"([^>]*)>`);
  const match = img.exec(html);
  if (!match) throw new Error(`build-kiosk: index.html has no <img> for ${file}`);
  const alt = /alt="([^"]*)"/.exec(match[1]!)?.[1] ?? '';
  const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  let out = svg.replace(/<\?xml[^>]*>\s*/, '');
  out = out.replace(/\sid="([^"]+)"/g, (_, id) => ` id="${prefix}-${id}"`);
  out = out.replace(/url\(#([^)]+)\)/g, (whole, id) => (ids.has(id) ? `url(#${prefix}-${id})` : whole));
  out = out.replace(/(xlink:href|href)="#([^"]+)"/g, (whole, attr, id) => (ids.has(id) ? `${attr}="#${prefix}-${id}"` : whole));
  out = out.replace(/aria-labelledby="[^"]*"/, '');
  out = out.replace(/<svg\b/, `<svg class="scene-art" data-scene="${prefix}" role="img" aria-label="${alt}" focusable="false"`);
  out = out.replace(/\swidth="1600"\s+height="900"/, '');
  return html.replace(match[0], out.trim());
}

/** Index just past the `</g>` that closes the `<g ...>` starting at `start` (nested groups counted). */
function matchingGroupEnd(svg: string, start: number): number {
  const tag = /<g\b[^>]*?(\/?)>|<\/g>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(svg); m; m = tag.exec(svg)) {
    if (m[0] === '</g>') depth--;
    else if (m[1] !== '/') depth++;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error('build-kiosk: unbalanced <g> in artwork');
}

function wrapGroup(svg: string, opening: string, id: string): string {
  const start = svg.indexOf(opening);
  if (start < 0 || svg.indexOf(opening, start + 1) >= 0) throw new Error(`build-kiosk: animation anchor ${opening} not found exactly once`);
  const end = matchingGroupEnd(svg, start);
  return `${svg.slice(0, start)}<g id="${id}">${svg.slice(start, end)}</g>${svg.slice(end)}`;
}

/** Static mid-air pages in the approved artwork, removed at build time (owner request). */
export const REMOVED_STATIC_PAPERS = ['<g transform="rotate(28 1125.0 661.0)">', '<g transform="rotate(-24 1101.0 743.0)">'];

/** Keyboard colours only (shape, size and placement unchanged): ivory case with an outline, light keys with beige edges. */
export const KEYBOARD_RECOLOR: [string, string][] = [
  ['<rect x="292" y="652" width="280" height="84" rx="10" fill="#3b3e44"/>',
    '<rect x="292" y="652" width="280" height="84" rx="10" fill="#d8ccae" stroke="#a89b7b" stroke-width="3"/>'],
  ['<g fill="#c9ccd1">', '<g fill="#efe9d8" stroke="#a89b7b" stroke-width="1.4">'],
];

/** The drawn kiosk's orange sign names the assistant (owner request); same font, size, colour and position. */
export const KIOSK_SIGN: [string, string] = [
  '<text x="1214" y="239" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-size="18" font-weight="bold" fill="#fff8ea">Paws &amp; Order</text>',
  '<text x="1214" y="239" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-size="18" font-weight="bold" fill="#fff8ea" letter-spacing="1.5">TEMPERANCE</text>',
];

/* The window flyer and door notice, shortened and enlarged (owner request). Each sign appears twice: readable
   from the street, and mirrored and faint from inside the hospital. Spans run from `start` through `end`. */
const SERIF = 'font-family="Georgia, \'Times New Roman\', serif"';
/** "HELP WANTED" is fitted to a fixed width so it always stays on the paper. */
const HELP = 'font-size="20" font-weight="bold" textLength="124" lengthAdjust="spacingAndGlyphs"';
export interface SignEdit { start: string; end: string; to: string }
export const SIGN_EDITS: Record<string, SignEdit[]> = {
  'hospital-exterior-02.svg': [
    {
      // Ends inside the original text group, whose closing tag stays in place.
      start: '<rect x="656" y="226" width="122" height="186"', end: 'you are a cat!</text>',
      to: `<rect x="649" y="273" width="136" height="92" fill="#fbf7ef" stroke="#cfc4ac"/>
    <text x="717" y="309" text-anchor="middle" ${SERIF} ${HELP} fill="#b5541b">HELP WANTED</text>
    <g ${SERIF} font-size="16" fill="#3b3a36" text-anchor="middle">
      <text x="717" y="341">Apply Inside</text>`,
    },
    {
      start: '<rect x="884" y="232" width="126" height="72"', end: 'fill="#b5541b">Short staffed.</text>',
      to: `<rect x="870" y="232" width="154" height="94" rx="3" fill="#fbf7ef" stroke="#cfc4ac"/>
  <text x="947" y="270" text-anchor="middle" ${SERIF} font-size="16.5" fill="#3b3a36">Please be patient.</text>
  <text x="947" y="304" text-anchor="middle" ${SERIF} font-size="19.5" font-weight="bold" fill="#b5541b">Short staffed.</text>`,
    },
  ],
  'hospital-scene-05.svg': [
    {
      start: '<rect x="326" y="226" width="122" height="186"', end: '<path d="M433 398l26 7-3 11-26-7z"/></g>',
      to: `<rect x="319" y="273" width="136" height="92" fill="#f3ecdc" stroke="#cfc4ac"/>
    <g transform="translate(774 0) scale(-1 1)" ${SERIF} text-anchor="middle" fill="#8f8775" opacity=".3">
      <text x="387" y="309" ${HELP}>HELP WANTED</text>
      <text x="387" y="341" font-size="16">Apply Inside</text>
    </g>
    <g fill="#e9dcae" opacity=".9"><path d="M311 269l26 7-3 11-26-7z"/><path d="M437 276l26-7 3 11-26 7z"/><path d="M308 358l26-7 3 11-26 7z"/><path d="M440 351l26 7-3 11-26-7z"/></g>`,
    },
    {
      start: '<rect x="78" y="232" width="126" height="72"', end: 'font-weight="bold">Short staffed.</text>',
      to: `<rect x="64" y="232" width="154" height="94" rx="3" fill="#efe7d6" stroke="#cfc4ac"/>
  <g transform="translate(282 0) scale(-1 1)" ${SERIF} text-anchor="middle" fill="#8f8775" opacity=".28">
    <text x="141" y="270" font-size="16.5">Please be patient.</text><text x="141" y="304" font-size="19.5" font-weight="bold">Short staffed.</text>`,
    },
  ],
};

function replaceSpan(svg: string, { start, end, to }: SignEdit): string {
  const at = svg.indexOf(start);
  const endAt = svg.indexOf(end, at);
  if (at < 0 || endAt < 0 || svg.indexOf(start, at + 1) >= 0) throw new Error(`build-kiosk: sign span ${start} … ${end} not found exactly once`);
  return svg.slice(0, at) + to + svg.slice(endAt + end.length);
}

/**
 * Every owner-approved change to the drawing itself, applied before animation hooks are added. Tests compare the
 * built scenes against this result, so nothing else in the artwork can change unnoticed.
 */
export function applyArtEdits(file: string, svg: string): string {
  let out = svg;
  if (file === 'hospital-scene-05.svg') {
    // The two pages drawn frozen in mid-air are removed (the animated pages make that journey), the keyboard
    // takes the computer's ivory and beige, and the kiosk sign names the assistant.
    for (const opening of REMOVED_STATIC_PAPERS) out = removeGroup(out, opening);
    for (const [from, to] of KEYBOARD_RECOLOR) out = replaceOnce(out, from, to);
    out = replaceOnce(out, ...KIOSK_SIGN);
  }
  for (const edit of SIGN_EDITS[file] ?? []) out = replaceSpan(out, edit);
  return out;
}

function replaceOnce(svg: string, from: string, to: string): string {
  const at = svg.indexOf(from);
  if (at < 0 || svg.indexOf(from, at + 1) >= 0) throw new Error(`build-kiosk: ${from} not found exactly once`);
  return svg.slice(0, at) + to + svg.slice(at + from.length);
}

function removeGroup(svg: string, opening: string): string {
  const start = svg.indexOf(opening);
  if (start < 0 || svg.indexOf(opening, start + 1) >= 0) throw new Error(`build-kiosk: ${opening} not found exactly once`);
  return svg.slice(0, start) + svg.slice(matchingGroupEnd(svg, start));
}

/** Wraps the `<g>` that directly encloses `anchor` (which must occur exactly once). */
function wrapEnclosingGroup(svg: string, anchor: string, id: string): string {
  const at = svg.indexOf(anchor);
  if (at < 0 || svg.indexOf(anchor, at + 1) >= 0) throw new Error(`build-kiosk: animation anchor ${anchor} not found exactly once`);
  const start = svg.lastIndexOf('<g', at);
  const end = matchingGroupEnd(svg, start);
  if (end < at) throw new Error(`build-kiosk: ${anchor} is not inside a group`);
  return `${svg.slice(0, start)}<g id="${id}">${svg.slice(start, end)}</g>${svg.slice(end)}`;
}

/** Wraps the exact run of markup from `first` through `last` (each occurring exactly once). */
function wrapRun(svg: string, first: string, last: string, id: string): string {
  const start = svg.indexOf(first);
  const lastAt = svg.indexOf(last);
  if (start < 0 || lastAt < start || svg.indexOf(first, start + 1) >= 0 || svg.indexOf(last, lastAt + 1) >= 0) {
    throw new Error(`build-kiosk: animation run ${first} … ${last} not found exactly once`);
  }
  const end = lastAt + last.length;
  return `${svg.slice(0, start)}<g id="${id}">${svg.slice(start, end)}</g>${svg.slice(end)}`;
}

function insertBefore(svg: string, anchor: string, markup: string): string {
  const at = svg.indexOf(anchor);
  if (at < 0 || svg.indexOf(anchor, at + 1) >= 0) throw new Error(`build-kiosk: insertion anchor ${anchor} not found exactly once`);
  return `${svg.slice(0, at)}${markup}\n${svg.slice(at)}`;
}

/** A loose page drawn exactly like the scene's desk papers, centred on its own origin. */
function loosePage(id: string, x: number, y: number, angle: number): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle})"><g id="${id}">`
    + '<rect x="-31" y="-16" width="62" height="32" rx="1.5" fill="#fbf7ef" stroke="#d8cdb6"/>'
    + '<path d="M-23 -6H20" stroke="#bdb39c" stroke-width="2"/><path d="M-23 3H14" stroke="#bdb39c" stroke-width="2"/></g></g>';
}

/** A wisp of steam rising from the carrot mug, drawn upward from its own origin. */
function steamWisp(id: string, x: number): string {
  return `<g transform="translate(${x} 532)"><path id="${id}" d="M0 0C-6 -7 6 -13 0 -20C-6 -27 5 -32 1 -40" fill="none" stroke="#fffaf0" stroke-width="3" stroke-linecap="round" opacity=".7"/></g>`;
}

/**
 * Adds empty wrapper groups (no transforms, no paint) around parts of the approved artwork so
 * CSS can animate them without touching any drawn element, plus a few small ambient pieces in
 * the scene's own styles (two loose desk pages and steam from the mug). Applied before id prefixing.
 */
export function addAnimationWrappers(file: string, svg: string): string {
  if (file === 'hospital-exterior-02.svg') {
    let out = applyArtEdits(file, svg);
    out = wrapGroup(out, '<g fill="#fbf8ee" opacity=".85" filter="url(#b6)">', 'anim-clouds');
    out = wrapEnclosingGroup(out, '<ellipse cx="128" cy="470" rx="118" ry="108" fill="#5f8340"/>', 'anim-canopy');
    return out;
  }
  if (file !== 'hospital-scene-05.svg') return svg;
  let out = applyArtEdits(file, svg);
  // Oscillating fan: the head swings on its stem; the blades spin about the hub.
  out = wrapGroup(out, '<g fill="#a8b8a2">', 'anim-fan-blades');
  out = wrapGroup(out, '<g transform="translate(572 212) rotate(24)">', 'anim-fan-head');
  // Pinboard sheets that flutter when the fan turns toward them.
  out = wrapGroup(out, '<g transform="translate(760 130) scale(.7) rotate(1.5) translate(-1035 -197)">', 'anim-calendar');
  out = wrapGroup(out, '<g transform="translate(965 214) scale(.88) rotate(2) translate(-1452 -300)">', 'anim-flyer');
  // Desk bell dome and plunger (the base stays put).
  out = wrapRun(out, '<path d="M960 616C960 586 1016 586 1016 616Z" fill="#d6b24e"/>', '<circle cx="988" cy="589" r="5" fill="#a8842e"/>', 'anim-bell');
  out = insertBefore(out, '<!-- Pages Hearthy pinned under the bell. She missed several. -->',
    `<!-- Steam from the carrot mug (animation) -->\n<g>${steamWisp('anim-steam-1', 924)}${steamWisp('anim-steam-2', 936)}${steamWisp('anim-steam-3', 947)}</g>`);
  // Drawn above the floor pile, so a page that lands visibly joins it; resting spots sit clear of the bell.
  out = insertBefore(out, '<!-- Warm light tying the room together -->',
    `<!-- Loose pages the fan carries off the desk (animation) -->\n<g>${loosePage('anim-page-1', 1102, 612, 6)}${loosePage('anim-page-2', 1050, 650, -5)}</g>`);
  // A tiny, occasional spark at the overloaded power strip (hidden unless animating).
  out = insertBefore(out, '<!-- Hearthy -->',
    '<!-- Spark at the power strip (animation) -->\n<g transform="translate(421 508)"><g id="anim-spark">'
    + '<path d="M0 -8L1.8 -1.8L8 0L1.8 1.8L0 8L-1.8 1.8L-8 0L-1.8 -1.8Z" fill="#f3d36b"/><circle r="1.8" fill="#fffaf0"/></g></g>');
  out = wrapGroup(out, '<g transform="translate(322 232) scale(.85) translate(-322 -232)">', 'anim-ear-l');
  out = wrapGroup(out, '<g transform="translate(478 232) scale(.85) translate(-478 -232)">', 'anim-ear-r');
  out = wrapGroup(out, '<g transform="translate(336 312) scale(.9) translate(-336 -312)">', 'anim-eye-l');
  out = wrapGroup(out, '<g transform="translate(464 312) scale(.9) translate(-464 -312)">', 'anim-eye-r');
  const headStart = out.indexOf('<!-- Ears -->');
  const front = out.indexOf('<!-- Front desk -->');
  const hearthyClose = out.lastIndexOf('</g>', front);
  if (headStart < 0 || front < 0 || hearthyClose < headStart) throw new Error('build-kiosk: Hearthy head anchors not found');
  return `${out.slice(0, headStart)}<g id="anim-head">${out.slice(headStart, hearthyClose)}</g>\n${out.slice(hearthyClose)}`;
}

export const HEARTHY_HANDOFF = 'Temperance is next to the front desk, on the right-hand side.';

/** A paragraph, or a bulleted list. Text may mark bold with **double asterisks** (rendered as text, never HTML). */
export type BehindBlock = string | { list: string[] };
export interface BehindTheDesk {
  subtitle: string;
  intro: string[];
  sections: { heading: string; blocks: BehindBlock[] }[];
}

export interface KioskContent {
  hearthyIntro: string[];
  rotatingMessages: string[];
  behindTheDesk: BehindTheDesk;

}

/** Validated kiosk copy from config/kiosk-content.json. Hearthy's intro must end with the approved handoff line. */
export function kioskContent(repo = REPO): KioskContent {
  const raw = JSON.parse(readFileSync(join(repo, 'config', 'kiosk-content.json'), 'utf8')) as Partial<KioskContent>;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const intro = Array.isArray(raw.hearthyIntro) ? raw.hearthyIntro : [];
  if (!intro.every(text) || intro[intro.length - 1] !== HEARTHY_HANDOFF) {
    throw new Error(`build-kiosk: hearthyIntro must end with the approved line "${HEARTHY_HANDOFF}"`);
  }
  const messages = Array.isArray(raw.rotatingMessages) ? raw.rotatingMessages : [];
  if (!messages.every(text)) throw new Error('build-kiosk: rotatingMessages must be non-empty strings');
  const behind = raw.behindTheDesk;
  // Bold markers must pair up so no stray asterisks reach the page.
  const line = (v: unknown) => text(v) && ((v as string).match(/\*\*/g) ?? []).length % 2 === 0;
  const block = (b: unknown) => line(b)
    || (!!b && typeof b === 'object' && Array.isArray((b as { list?: unknown }).list) && (b as { list: unknown[] }).list.length > 0
      && (b as { list: unknown[] }).list.every(line));
  if (!behind || !line(behind.subtitle) || !Array.isArray(behind.intro) || !behind.intro.length || !behind.intro.every(line)
    || !Array.isArray(behind.sections) || !behind.sections.length
    || !behind.sections.every((s) => line(s.heading) && Array.isArray(s.blocks) && s.blocks.length && s.blocks.every(block))) {
    throw new Error('build-kiosk: behindTheDesk needs a subtitle, intro paragraphs and sections of paragraphs or lists (with paired ** markers)');
  }
  return { hearthyIntro: intro, rotatingMessages: messages, behindTheDesk: { subtitle: behind.subtitle, intro: behind.intro, sections: behind.sections } };
}

export function buildKiosk(repo = REPO, dist = DIST): string[] {
  const written: string[] = [];
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'art'), { recursive: true });
  mkdirSync(join(dist, 'data'), { recursive: true });
  mkdirSync(join(dist, 'invoices'), { recursive: true });

  for (const file of KIOSK_FILES) {
    cpSync(join(repo, 'src', 'kiosk', file), join(dist, file));
    written.push(file);
  }
  let html = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const file of ART) {
    const source = join(repo, 'local_docs', 'art', file);
    if (!existsSync(source)) throw new Error(`build-kiosk: approved artwork local_docs/art/${file} not found`);
    const svg = readFileSync(source, 'utf8');
    if (/<script|<foreignObject|xlink:href="(?!#)|href="http|\sstyle=|<style|\son[a-z]+=/i.test(svg)) {
      throw new Error(`build-kiosk: ${file} contains scripts, styles, handlers or external references`);
    }
    writeFileSync(join(dist, 'art', file), svg);
    written.push(`art/${file}`);
    html = inlineArt(html, file, addAnimationWrappers(file, svg));
  }
  writeFileSync(join(dist, 'index.html'), html);
  const invoices = publicInvoices();
  const json = JSON.stringify(invoices, null, 2);
  for (const term of FORBIDDEN_TERMS) if (json.includes(term)) throw new Error(`build-kiosk: invoice list contains "${term}"`);
  writeFileSync(join(dist, 'data', 'invoices.json'), `${json}\n`);
  written.push('data/invoices.json');
  writeFileSync(join(dist, 'data', 'rules.json'), `${JSON.stringify(publicRules(repo), null, 2)}\n`);
  writeFileSync(join(dist, 'data', 'kiosk.json'), `${JSON.stringify(kioskContent(repo), null, 2)}\n`);
  written.push('data/kiosk.json');
  written.push('data/rules.json');
  for (const inv of invoices) {
    const name = inv.pdf.replace('/invoices/', '');
    const source = pdfSource(repo, inv.invoiceNo);
    if (!source) throw new Error(`build-kiosk: PDF for ${inv.invoiceNo} not found (run npm run pdfs)`);
    cpSync(source, join(dist, 'invoices', name));
    written.push(`invoices/${name}`);
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const written = buildKiosk();
  console.log(`PASS: kiosk built into dist/ (${written.length} files): ${written.join(', ')}`);
}

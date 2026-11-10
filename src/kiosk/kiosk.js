// Paws & Order kiosk. Plain ES module; all server text is inserted with textContent.

import {
  ADVISORY, ATTEMPT_NOTICE, DEMO_ADVISORY, MENU_NOTICE, SAY, allowanceText, attemptNotUsed, errorView, findingHeading, money, outcomeIntro, outcomeTitle,
  parseReviewed, splitInvoices,
} from './format.js';

const SCREENS = ['exterior', 'desk', 'terminal', 'behind', 'closing'];
const CLIENT_TIMEOUT_MS = 30_000;
const state = {
  allowance: null, invoices: null, demos: null, rules: {}, busy: false, content: null, screen: 'exterior', returnTo: 'exterior',
  introSeen: false, bellTimer: 0,
};

/* Invoices reviewed during this visit: session storage only (cleared when the tab closes), never sent anywhere.
   Storage can be unavailable (private windows, blocked site data); the list then lasts for this page only. */
const REVIEWED_KEY = 'paws-and-order:reviewed-this-visit';
const reviewed = (() => {
  try { return parseReviewed(sessionStorage.getItem(REVIEWED_KEY)); } catch { return new Set(); }
})();
function saveReviewed() {
  try { sessionStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])); } catch { /* kept in memory only */ }
}

const $ = (id) => document.getElementById(id);
const body = () => $('terminal-body');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [event, fn] of Object.entries(v)) node.addEventListener(event, fn);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function announce(text) {
  const a = $('announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = text; }, 50);
}

function show(screen) {
  if (screen === 'behind' && state.screen !== 'behind') state.returnTo = state.screen;
  state.screen = screen;
  for (const name of SCREENS) $(`screen-${name}`).hidden = name !== screen;
  if (screen === 'desk') startIntro();
  if (screen === 'behind') renderBehind();
  const heading = $(`screen-${screen}`).querySelector('h1');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus();
  if (screen === 'terminal') { state.introSeen = true; refreshAllowance(); }
}

function render(...nodes) {
  const target = body();
  target.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  const first = target.querySelector('h2');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus(); }
}

function temperance(...lines) {
  return el('div', { class: 'say' }, el('p', { class: 'speaker' }, 'Temperance'), ...lines.map((t) => el('p', {}, t)));
}

async function api(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(path, { credentials: 'same-origin', redirect: 'manual', signal: controller.signal, ...init });
    if (response.type === 'opaqueredirect') return { status: 401, body: { error: { code: 'authentication_required' } } };
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, body: data };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAllowance() {
  const line = $('allowance');
  const r = await api('/api/allowance');
  if (r.status === 200 && r.body) {
    state.allowance = r.body;
    line.textContent = allowanceText(r.body);
  } else {
    state.allowance = null;
    line.textContent = errorView(r.status, r.body).title === 'Please sign in again'
      ? 'Sign-in needed to check live reviews.'
      : 'Live review count unavailable right now.';
  }
}

async function loadInvoices() {
  if (state.invoices) return state.invoices;
  const [r, rules] = await Promise.all([api('/data/invoices.json'), api('/data/rules.json')]);
  state.invoices = r.status === 200 && Array.isArray(r.body) ? r.body : [];
  if (rules.status === 200 && Array.isArray(rules.body)) {
    state.rules = Object.fromEntries(rules.body.map((rule) => [rule.id, rule.name]));
  }
  return state.invoices;
}

/* The visitor's printed invoice, shown beside the terminal. `marks` maps "section:line" to finding numbers. */
function showPaper(inv, marks = new Map(), summaryMarks = []) {
  const paper = $('paper');
  if (!inv) { paper.hidden = true; paper.replaceChildren(); $('screen-terminal').classList.remove('with-paper'); return; }
  const markFor = (key) => (marks.get(key) ?? []).map((n) => el('span', { class: 'mark', 'aria-label': `Finding ${n}` }, String(n)));
  const row = (l) => {
    const key = `${l.section}:${l.lineNumber}`;
    return el('tr', { class: marks.has(key) ? 'flagged' : '' },
      el('td', { class: 'code' }, markFor(key), l.code),
      el('td', {}, l.description),
      el('td', { class: 'num' }, String(l.quantity)),
      el('td', { class: 'num' }, money(l.unitPrice)),
      el('td', { class: 'num' }, money(l.amount)));
  };
  const table = (section, caption) => {
    const lines = inv.lines.filter((l) => l.section === section);
    if (!lines.length) return null;
    return el('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': `${caption} (scrolls sideways on small screens)` },
      el('table', {},
        el('caption', {}, caption),
        el('thead', {}, el('tr', {}, ['Code', 'Description', 'Qty', 'Unit price', 'Amount'].map((h, i) =>
          el('th', { scope: 'col', class: i >= 2 ? 'num' : '' }, h)))),
        el('tbody', {}, lines.map(row))));
  };
  const t = inv.totals;
  const total = (label, value, strong = false) => el('div', { class: strong ? 'total strong' : 'total' }, el('dt', {}, label), el('dd', {}, money(value)));
  paper.replaceChildren(...[
    el('p', { class: 'paper-brand' }, 'Paws & Order Cat Hospital'),
    el('h2', { id: 'paper-title' }, `Invoice ${inv.invoiceNo}`),
    el('p', { class: 'paper-fiction' }, 'Fictional sample for demonstration only'),
    el('dl', { class: 'paper-meta' },
      [['Patient', `${inv.patientName} (${inv.breed}, ${inv.ageYears})`], ['Visit', `${inv.visitDate} · ${inv.visitType}`],
        ['Veterinarian', inv.veterinarian]].map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))),
    table('service', 'Services'),
    table('product', 'Medications & products'),
    summaryMarks.length ? el('p', { class: 'summary-marks' }, 'Invoice totals: ',
      summaryMarks.map((n) => el('span', { class: 'mark', 'aria-label': `Finding ${n}` }, String(n)))) : null,
    el('dl', { class: 'paper-totals' },
      total('Services', t.servicesTotal), total('Products', t.productsTotal), total('Subtotal', t.subtotal),
      total('Discount', t.discount), total('Tax', t.tax), total('Total due', t.totalDue, true)),
    el('h3', {}, 'Visit notes'),
    el('p', { class: 'paper-notes' }, inv.visitNotes),
    el('p', {}, el('a', { href: inv.pdf, target: '_blank', rel: 'noopener' }, 'Open the printed PDF (new tab)')),
  ].filter(Boolean));
  paper.hidden = false;
  $('screen-terminal').classList.add('with-paper');
}

/* Views */

function menuView() {
  showPaper(null);
  render(
    el('h2', {}, 'Main menu'),
    temperance(...SAY.greeting),
    el('p', { class: 'notice' }, MENU_NOTICE),
    el('ul', { class: 'menu' },
      el('li', {}, el('button', { type: 'button', class: 'go', on: { click: invoicesView } }, '1  Review my invoice')),
      el('li', {}, el('button', { type: 'button', on: { click: demonstrationsView } }, '2  View Demonstrations')),
      el('li', {}, el('button', { type: 'button', on: { click: finishVisit } }, '3  Finish visit'))),
  );
}

async function invoicesView() {
  showPaper(null);
  render(el('h2', {}, 'Choose your invoice'), el('p', {}, 'Loading invoices…'));
  const invoices = await loadInvoices();
  if (!invoices.length) {
    render(el('h2', {}, 'Choose your invoice'), temperance(SAY.noInvoices), backToMenu());
    return;
  }
  const groups = splitInvoices(invoices, reviewed);
  const card = (inv, done) => el('li', {}, el('button', { type: 'button', class: done ? 'invoice-pick reviewed' : 'invoice-pick', on: { click: () => confirmView(inv) } },
    el('span', { class: 'pick-name' }, inv.patientName),
    el('span', { class: 'pick-meta' }, `${inv.visitType} · `, el('span', { class: 'nowrap' }, inv.visitDate)),
    el('span', { class: 'pick-no' }, 'Invoice ', el('span', { class: 'nowrap' }, inv.invoiceNo)),
    done ? el('span', { class: 'pick-tag reviewed-tag' }, 'Reviewed') : null));
  render(
    el('h2', {}, 'Choose your invoice'),
    temperance(groups.available.length ? SAY.choose : SAY.allReviewed),
    el('section', { class: 'invoice-section', 'aria-labelledby': 'available-heading' },
      el('h3', { id: 'available-heading' }, 'Available to Review'),
      groups.available.length
        ? el('ul', { class: 'invoice-grid' }, groups.available.map((inv) => card(inv, false)))
        : el('p', { class: 'fine' }, 'None left. Reviewed invoices are listed below.')),
    groups.reviewed.length ? el('section', { class: 'invoice-section reviewed-section', 'aria-labelledby': 'reviewed-heading' },
      el('h3', { id: 'reviewed-heading' }, 'Reviewed This Visit'),
      el('ul', { class: 'invoice-grid' }, groups.reviewed.map((inv) => card(inv, true)))) : null,
    backToMenu(),
  );
}

function confirmView(inv) {
  const remaining = state.allowance?.remaining;
  const canStart = remaining === undefined || remaining > 0;
  showPaper(inv);
  render(
    el('h2', {}, `Invoice ${inv.invoiceNo}`),
    temperance(canStart ? SAY.ready(inv.invoiceNo) : SAY.noneLeft),
    el('p', { class: 'notice' }, ATTEMPT_NOTICE),
    canStart || !state.allowance ? null : el('p', { class: 'fine' }, allowanceText(state.allowance)),
    reviewed.has(inv.invoiceNo) ? el('p', { class: 'fine' }, SAY.reviewedBefore) : null,
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'go', disabled: !canStart, on: { click: () => (reviewed.has(inv.invoiceNo) ? reviewAgainView(inv) : runReview(inv)) } },
        reviewed.has(inv.invoiceNo) ? 'Review this invoice again' : 'Ask Temperance to review'),
      el('button', { type: 'button', on: { click: invoicesView } }, 'Choose a different invoice'),
      el('button', { type: 'button', on: { click: demonstrationsView } }, 'View Demonstrations')),
  );
}

/** Asked before a second live review of an invoice already reviewed this visit. */
function reviewAgainView(inv) {
  showPaper(inv);
  render(
    el('h2', {}, 'Review this invoice again?'),
    temperance(SAY.reviewAgain(inv.invoiceNo)),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'go', on: { click: () => runReview(inv) } }, 'Review Again'),
      el('button', { type: 'button', on: { click: () => confirmView(inv) } }, 'Cancel')),
  );
}

async function runReview(inv) {
  if (state.busy) return;
  state.busy = true;
  $('return-hospital').disabled = true;
  // Marked as the attempt begins: a review that fails after it starts still used an attempt.
  const markedNow = !reviewed.has(inv.invoiceNo);
  reviewed.add(inv.invoiceNo);
  saveReviewed();
  const started = Date.now();
  const seconds = el('span', {}, '0');
  render(
    el('h2', {}, `Reviewing invoice ${inv.invoiceNo}`),
    el('p', { class: 'waiting', role: 'status' }, SAY.waiting, el('span', { class: 'cursor', 'aria-hidden': 'true' })),
    el('p', { class: 'fine' }, 'Elapsed: ', seconds, ' s. This usually takes a few seconds and stops after 30.'),
  );
  announce('Review started. Waiting for Temperance.');
  const tick = setInterval(() => { seconds.textContent = String(Math.floor((Date.now() - started) / 1000)); }, 1000);
  const r = await api('/api/review', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceNo: inv.invoiceNo }),
  });
  clearInterval(tick);
  state.busy = false;
  $('return-hospital').disabled = false;
  // Refused before anything was reserved (for example closed, busy or paused): no attempt was used.
  if (markedNow && attemptNotUsed(r.status, r.body)) { reviewed.delete(inv.invoiceNo); saveReviewed(); }
  if (r.status === 200 && r.body) resultView(inv, r.body);
  else errorScreen(r, true);
  refreshAllowance();
}

/** A completed review, live or recorded. `demo` is the demonstration record when replaying. */
function resultView(inv, result, demo = null) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const marks = new Map();
  const summaryMarks = [];
  findings.forEach((f, i) => {
    if (!f.line) { summaryMarks.push(i + 1); return; }
    const key = `${f.line.section}:${f.line.lineNumber}`;
    marks.set(key, [...(marks.get(key) ?? []), i + 1]);
  });
  showPaper(inv, marks, summaryMarks);
  render(
    el('h2', {}, demo ? demo.title : `Review of invoice ${inv.invoiceNo}`),
    demo ? el('p', { class: 'notice' }, SAY.demoNotice) : null,
    el('p', { class: `outcome outcome-${result.outcome}` }, outcomeTitle(result.outcome)),
    temperance(outcomeIntro(result.outcome, findings.length)),
    findings.length ? el('ol', { class: 'findings' }, findings.map((f, i) =>
      el('li', { class: 'finding' },
        el('h3', {}, el('span', { class: 'mark', 'aria-hidden': 'true' }, String(i + 1)), findingHeading(f, state.rules)),
        el('p', { class: 'evidence' }, f.evidence),
        el('p', {}, f.explanation)))) : null,
    el('p', { class: 'fine' }, demo ? DEMO_ADVISORY : ADVISORY),
    demo ? null : el('p', { class: 'fine' }, allowanceText({ remaining: result.remaining, limit: state.allowance?.limit ?? 3,
      resetAt: result.resetAt, limitedBy: null })),
    el('div', { class: 'actions' },
      demo ? el('button', { type: 'button', on: { click: demonstrationsView } }, 'More demonstrations') : null,
      el('button', { type: 'button', on: { click: menuView } }, 'Main menu'),
      el('button', { type: 'button', on: { click: finishVisit } }, 'Finish visit')),
  );
  announce(`${demo ? 'Recorded review' : 'Review'} complete: ${outcomeTitle(result.outcome)}.`);
}

function errorScreen(r, afterStart = false) {
  const view = errorView(r.status, r.body, afterStart);
  render(
    el('h2', {}, view.title),
    temperance(view.message),
    el('div', { class: 'actions' },
      view.reload ? el('button', { type: 'button', class: 'go', on: { click: () => location.reload() } }, 'Reload and sign in') : null,
      el('button', { type: 'button', class: view.reload ? '' : 'go', on: { click: demonstrationsView } }, 'View Demonstrations'),
      el('button', { type: 'button', on: { click: menuView } }, 'Main menu')),
  );
  announce(view.title);
}

async function loadDemonstrations() {
  if (state.demos) return state.demos;
  const r = await api('/api/demonstrations');
  if (r.status !== 200 || !r.body) return r;
  state.demos = Array.isArray(r.body.demonstrations) ? r.body.demonstrations : [];
  return state.demos;
}

async function demonstrationsView() {
  if ($('screen-terminal').hidden) show('terminal');
  showPaper(null);
  render(el('h2', {}, 'Recorded demonstrations'), el('p', {}, 'Loading…'));
  const [demos] = await Promise.all([loadDemonstrations(), loadInvoices()]);
  if (!Array.isArray(demos)) { errorScreen(demos); return; }
  render(
    el('h2', {}, 'Recorded demonstrations'),
    temperance(demos.length ? SAY.demosIntro : SAY.noDemos),
    demos.length ? el('ul', { class: 'invoice-grid' }, demos.map((d) => {
      const inv = state.invoices.find((i) => i.invoiceNo === d.invoiceNo);
      return el('li', {}, el('button', { type: 'button', class: 'invoice-pick', on: { click: () => demoView(d) } },
        el('span', { class: 'pick-name' }, d.title),
        el('span', { class: 'pick-meta' }, inv ? [`${inv.visitType} · `, el('span', { class: 'nowrap' }, inv.visitDate)] : `Invoice ${d.invoiceNo}`)));
    })) : null,
    backToMenu(),
  );
}

function demoView(demo) {
  const inv = state.invoices.find((i) => i.invoiceNo === demo.invoiceNo);
  if (!inv) { errorScreen({ status: 404, body: { error: { code: 'unknown_invoice' } } }); return; }
  showPaper(inv);
  render(
    el('h2', {}, demo.title),
    temperance(SAY.demoReady),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'go', on: { click: () => resultView(inv, demo.result, demo) } }, 'Play the recorded review'),
      el('button', { type: 'button', on: { click: demonstrationsView } }, 'Choose another demonstration')),
  );
}

function finishVisit() {
  showPaper(null);
  body().replaceChildren();
  state.introSeen = false; // Start over is a new visit: Hearthy introduces herself again.
  show('closing');
}

function backToMenu() {
  return el('div', { class: 'actions' }, el('button', { type: 'button', on: { click: menuView } }, 'Main menu'));
}

/* Wiring */

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-go], [data-action]') : null;
  if (!target) return;
  if (target.getAttribute('data-action') === 'demos') { demonstrationsView(); return; }
  if (target.getAttribute('data-action') === 'behind') { show('behind'); return; }
  if (target.getAttribute('data-action') === 'back') { show(state.returnTo); if (state.returnTo === 'terminal') menuView(); return; }
  const go = target.getAttribute('data-go');
  if (go === 'terminal') { show('terminal'); if (!body().childElementCount) menuView(); } else if (go) show(go);
});

/* The desk bell rings silently: a short press and wiggle, and "Ding!" floats up. Each ring restarts the
   effect instead of stacking another one. Under reduced motion the word simply shows for a moment. */
$('desk-bell').addEventListener('click', () => {
  const bell = document.querySelector('.scene-art[data-scene="desk"]');
  const ding = $('ding');
  const parts = [bell, ding].filter(Boolean);
  for (const part of parts) part.classList.remove('ringing');
  void ding.offsetWidth; // restart the CSS animations from the beginning
  for (const part of parts) part.classList.add('ringing');
  clearTimeout(state.bellTimer);
  state.bellTimer = setTimeout(() => { for (const part of parts) part.classList.remove('ringing'); }, 950);
  announce('Ding!');
});

async function loadContent() {
  if (state.content) return state.content;
  const r = await api('/data/kiosk.json');
  state.content = r.status === 200 && r.body ? r.body : { hearthyIntro: [], rotatingMessages: [], behindTheDesk: null };
  return state.content;
}

/* Hearthy's short introduction: one line at a time, always skippable, ending with the approved handoff line. */
async function startIntro() {
  const content = await loadContent();
  const lines = Array.isArray(content.hearthyIntro) && content.hearthyIntro.length ? content.hearthyIntro : null;
  const text = $('hearthy-text');
  const primary = document.querySelector('#screen-desk .dialogue .primary');
  const skip = $('intro-skip');
  if (!lines || lines.length < 2) return;
  let index = state.introSeen ? lines.length - 1 : 0;
  const step = () => {
    text.textContent = lines[index];
    const last = index === lines.length - 1;
    primary.textContent = last ? 'Use the terminal' : 'Continue';
    if (last) primary.setAttribute('data-go', 'terminal'); else primary.removeAttribute('data-go');
    skip.hidden = last;
  };
  primary.onclick = () => { if (index < lines.length - 1) { index++; step(); } };
  step();
}

/* "**bold** rest" -> [<strong>bold</strong>, " rest"], built as text nodes (never parsed as HTML). */
function rich(text) {
  return String(text).split('**').map((part, i) => (i % 2 ? el('strong', {}, part) : part)).filter((part) => part !== '');
}

async function renderBehind() {
  const content = await loadContent();
  const behind = content.behindTheDesk;
  const target = $('behind-body');
  if (!behind) { target.replaceChildren(el('p', {}, 'This page is not available right now.')); return; }
  target.replaceChildren(
    el('p', { class: 'behind-subtitle' }, behind.subtitle),
    ...behind.intro.map((p) => el('p', {}, rich(p))),
    ...behind.sections.map((s) => el('section', {}, el('h2', {}, s.heading),
      ...s.blocks.map((b) => (typeof b === 'string' ? el('p', {}, rich(b)) : el('ul', {}, b.list.map((item) => el('li', {}, rich(item)))))))));
}

/* Rotating kiosk messages (config/kiosk-content.json). Hidden when none.
   Pauses on hover/focus and with the Pause button (WCAG 2.2.2); never rotates under reduced motion. */
async function startTicker() {
  const content = await loadContent();
  const messages = Array.isArray(content.rotatingMessages) ? content.rotatingMessages.filter((m) => typeof m === 'string') : [];
  if (!messages.length) return;
  const box = $('ticker');
  const text = $('ticker-text');
  const toggle = $('ticker-toggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let index = 0;
  let paused = reduced;
  let hovered = false;
  text.textContent = messages[0];
  box.hidden = false;
  toggle.hidden = messages.length < 2;
  toggle.textContent = paused ? 'Play messages' : 'Pause messages';
  toggle.setAttribute('aria-pressed', String(paused));
  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.textContent = paused ? 'Play messages' : 'Pause messages';
    toggle.setAttribute('aria-pressed', String(paused));
  });
  box.addEventListener('mouseenter', () => { hovered = true; });
  box.addEventListener('mouseleave', () => { hovered = false; });
  setInterval(() => {
    if (paused || hovered || box.contains(document.activeElement) || messages.length < 2) return;
    index = (index + 1) % messages.length;
    text.textContent = messages[index];
  }, 8000);
}
startTicker();

// Optional deep link for reviewers: #desk, #terminal, #closing.
const start = location.hash.slice(1);
if (start === 'terminal') { show('terminal'); menuView(); } else if (SCREENS.includes(start)) show(start); else show('exterior');

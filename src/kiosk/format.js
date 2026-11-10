// Pure presentation helpers for the kiosk (unit-tested in tests/kiosk). No DOM access.

export const OUTCOME_TITLES = {
  no_discrepancy_found: 'No Discrepancy Found',
  discrepancy_identified: 'Discrepancy Identified',
  staff_review_required: 'Staff Review Required',
};

/** Shown under a live review result. */
export const ADVISORY = 'This review is advisory. The hospital billing department will review and finalize our findings '
  + 'and reach out to you with the final results within 3-5 business days.';
/** Shown under a recorded demonstration result. */
export const DEMO_ADVISORY = 'This review is advisory. Billing staff make every final decision.';
/** Shown on the main menu under Temperance's greeting. */
export const MENU_NOTICE = 'No changes to your invoice can or will be made during this visit. The hospital billing department '
  + 'will review and finalize our findings and reach out to you with the final results within 3-5 business days.';

/* Temperance's dialogue, kept in one place for review before release. She is courteous, precise
   and text-only; findings themselves are always stated plainly. */
export const SAY = {
  greeting: [
    'Welcome to the Paws & Order Billing Assistance Terminal. I am Temperance, your friendly customer service agent.',
    'I can check your invoices against the hospital’s current price list, billing rules, and visit notes. If I find anything that doesn\'t look right I will escalate this to the billing department on your behalf.',
  ],
  choose: 'Select the invoice you would like to review together.',
  noInvoices: 'No invoices are available for review right now. The recorded demonstrations are still available.',
  ready: (invoiceNo) => `Invoice ${invoiceNo} is ready. I will compare every line with the price list and the visit notes, then explain what I find.`,
  noneLeft: 'You have no live reviews left today, but the recorded demonstrations are always available.',
  waiting: 'Reviewing your invoice now.',
  demosIntro: 'These are recorded reviews. Watching one never uses a live review, and nothing is sent for review.',
  noDemos: 'No recorded demonstrations are available yet.',
  demoReady: 'This is a recorded review. Play it to see the result exactly as it was recorded.',
  demoNotice: 'Recorded demonstration. No live review was used.',
  farewell: 'Thank you for using the terminal. Clinic staff can help with anything in your review.',
  allReviewed: 'You have reviewed every invoice during this visit. Each one is listed below.',
  reviewedBefore: 'You already reviewed this invoice during this visit.',
  reviewAgain: (invoiceNo) => `You already reviewed invoice ${invoiceNo} during this visit. Another review uses one more of your live reviews for today.`,
};

/* Invoices reviewed during this visit (browser session only; never sent to the server). */

const INVOICE_NO = /^PO-\d{4}-\d{4}$/;

/** Reads the stored list; anything malformed is treated as an empty visit. */
export function parseReviewed(raw) {
  try {
    const list = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((v) => typeof v === 'string' && INVOICE_NO.test(v)) : []);
  } catch {
    return new Set();
  }
}

/**
 * Splits the invoice list into those not yet reviewed this visit and those already reviewed, keeping list order.
 * @template {{ invoiceNo: string }} T
 * @param {T[]} invoices
 * @param {Set<string>} reviewed
 * @returns {{ available: T[], reviewed: T[] }}
 */
export function splitInvoices(invoices, reviewed) {
  return {
    available: invoices.filter((inv) => !reviewed.has(inv.invoiceNo)),
    reviewed: invoices.filter((inv) => reviewed.has(inv.invoiceNo)),
  };
}

/** Server refusals that happen before an attempt is reserved, so no live review was used. */
export const NO_ATTEMPT_CODES = ['authentication_required', 'access_denied', 'review_closed', 'daily_limit_reached', 'terminal_busy',
  'live_reviews_paused', 'service_not_ready', 'invalid_request', 'unknown_invoice', 'unsupported_media_type', 'payload_too_large',
  'method_not_allowed', 'not_found'];

/** True only when the response says plainly that no attempt was used. Timeouts and interruptions count as used. */
export function attemptNotUsed(status, body) {
  return status !== 200 && NO_ATTEMPT_CODES.includes(body?.error?.code);
}

export const ATTEMPT_NOTICE = 'Starting a review uses one of your live reviews for today. '
  + 'Once you select \'Ask Temperance to review\' one of your three daily reviews will be used.';

export function outcomeTitle(outcome) {
  return OUTCOME_TITLES[outcome] ?? 'Review Result';
}

/** Temperance's opening line for a result (application wording, not model text). */
export function outcomeIntro(outcome, count) {
  if (outcome === 'no_discrepancy_found') {
    return 'I checked the prices, quantities, totals, and visit notes on this invoice and did not find a discrepancy.';
  }
  if (outcome === 'staff_review_required') {
    return 'Part of this invoice needs a billing team member to check it before anything can be confirmed. Here is what I noticed.';
  }
  return `I found ${count === 1 ? 'one item' : `${count} items`} that ${count === 1 ? 'does' : 'do'} not match the hospital's price list, billing rules, or visit notes.`;
}

export function lineLabel(line) {
  if (!line) return 'Invoice totals';
  return `${line.section === 'product' ? 'Product' : 'Service'} line ${line.lineNumber}`;
}

/** "Line amount (B-04)" or "Tax, Total due (B-03/B-08)"; falls back to the bare reference. */
export function ruleLabel(ruleRef, ruleNames = {}) {
  const ids = String(ruleRef ?? '').split('/').filter(Boolean);
  const names = ids.map((id) => ruleNames[id]).filter(Boolean);
  return names.length === ids.length && names.length ? `${names.join(', ')} (${ids.join('/')})` : `Rule ${ruleRef}`;
}

export function findingHeading(finding, ruleNames = {}) {
  return [lineLabel(finding.line), finding.code, ruleLabel(finding.ruleRef, ruleNames)].filter(Boolean).join(' · ');
}

/** "$1,234.56" from a two-decimal string as printed on the invoice. */
export function money(text) {
  const [whole, cents = '00'] = String(text).split('.');
  return `$${Number(whole).toLocaleString('en-US')}.${cents.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * "Resets at midnight Pacific Time (3:00 AM your time, Tue)"
 * @param {string} resetAtIso
 * @param {string} [locale] defaults to the visitor's browser locale
 * @param {string} [timeZone] defaults to the visitor's time zone
 */
export function resetText(resetAtIso, locale, timeZone) {
  const at = new Date(resetAtIso);
  if (Number.isNaN(at.getTime())) return 'Resets at midnight Pacific Time.';
  const local = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', weekday: 'short', timeZone }).format(at);
  return `Resets at midnight Pacific Time (${local} your time).`;
}

/**
 * @param {{ remaining: number, limit: number, resetAt: string, limitedBy?: string | null }} allowance
 * @param {string} [locale]
 * @param {string} [timeZone]
 */
export function allowanceText(allowance, locale, timeZone) {
  const reset = resetText(allowance.resetAt, locale, timeZone);
  if (allowance.remaining <= 0 && allowance.limitedBy === 'shared') {
    return `All of today's shared live reviews have been used. ${reset}`;
  }
  const left = allowance.remaining === 1 ? '1 live review' : `${allowance.remaining} live reviews`;
  return `${left} left today (of ${allowance.limit}). ${reset}`;
}

/**
 * Maps an API failure to what the terminal shows. `afterStart` is true when the failure
 * came from POST /api/review; the server message already states when an attempt was used.
 */
export function errorView(status, body, afterStart = false) {
  const code = body?.error?.code;
  const serverMessage = typeof body?.error?.message === 'string' ? body.error.message : '';
  switch (code) {
    case 'authentication_required':
      return { title: 'Please sign in again', message: 'Your sign-in has expired. Reload the page to sign in again.', reload: true };
    case 'access_denied':
      return { title: 'No access', message: 'This sign-in does not have access to the terminal.', reload: false };
    case 'daily_limit_reached':
      return { title: 'Today’s live reviews are used', message: serverMessage || 'You have used today’s live reviews. Recorded demonstrations are still available.', reload: false };
    case 'live_reviews_paused':
      return { title: 'Live reviews are paused', message: serverMessage || 'Live reviews are paused right now. No review was used. Recorded demonstrations are still available.', reload: false };
    case 'terminal_busy':
      return { title: 'The terminal is busy', message: serverMessage || 'The terminal is busy. Please try again in a few minutes. No review was used.', reload: false };
    case 'service_interrupted':
      return { title: 'Service interrupted', message: serverMessage || 'This service was interrupted. Recorded demonstrations are still available.', reload: false };
    case 'review_closed':
    case 'service_not_ready':
      return { title: 'Live reviews are closed', message: 'Live reviews are not available right now. Recorded demonstrations are still available.', reload: false };
    case 'unknown_invoice':
    case 'invalid_request':
      return { title: 'Invoice not available', message: 'That invoice can’t be reviewed here. Please choose one from the list.', reload: false };
    default:
      return {
        title: 'Something went wrong',
        message: afterStart
          ? 'The terminal could not finish this review. If it had already started, the attempt may have been used. Recorded demonstrations are still available.'
          : 'The terminal could not complete that request. Recorded demonstrations are still available.',
        reload: status === 0,
      };
  }
}

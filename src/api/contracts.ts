// Public HTTP contracts. These shapes are what the kiosk sees; they never carry
// internal provenance (deterministic vs AI), private evaluation data, or identity.

export type ReviewOutcome = 'no_discrepancy_found' | 'discrepancy_identified' | 'staff_review_required';

export interface PublicFinding {
  /** Affected billed code, or null for invoice-summary findings. */
  code: string | null;
  line: { section: 'service' | 'product'; lineNumber: number } | null;
  /** Billing rule reference(s), e.g. "B-04" or "B-03/B-08". */
  ruleRef: string;
  /** What the invoice or notes show. */
  evidence: string;
  /** Temperance's plain-language explanation and recommended staff action. */
  explanation: string;
}

/** GET /api/allowance — read-only; never calls the model. */
export interface AllowanceResponse {
  remaining: number;
  limit: number;
  /** Next 00:00 Pacific Time as an ISO-8601 instant; the kiosk may display it in local time. */
  resetAt: string;
  timeZone: 'America/Los_Angeles';
  /** Which daily limit is exhausted when remaining is 0: the visitor's own or the shared one. */
  limitedBy: 'visitor' | 'shared' | null;
}

/** POST /api/review request body: a predefined invoice identifier only. No free text. */
export interface ReviewRequest {
  invoiceNo: string;
}

/** POST /api/review — one unified Temperance result. Advisory; staff decide. */
export interface ReviewResponse {
  invoiceNo: string;
  outcome: ReviewOutcome;
  findings: PublicFinding[];
  staffDecisionRequired: true;
  remaining: number;
  resetAt: string;
}

/** A recorded demonstration replayed in the kiosk; playback uses no live review and calls no model. */
export interface DemonstrationSummary {
  id: string;
  title: string;
  invoiceNo: string;
  provisional: boolean;
  result: { outcome: ReviewOutcome; findings: PublicFinding[] };
}

/** GET /api/demonstrations — prerecorded; never consumes review allowance or calls the model. */
export interface DemonstrationsResponse {
  demonstrations: DemonstrationSummary[];
  consumesReviewAllowance: false;
}

export type ErrorCode =
  | 'not_found'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_request'
  | 'unknown_invoice'
  | 'authentication_required'
  | 'access_denied'
  | 'service_not_ready'
  | 'review_closed'
  | 'daily_limit_reached'
  | 'terminal_busy'
  | 'live_reviews_paused'
  | 'service_interrupted'
  | 'internal_error';

export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
  /** The kiosk always offers View Demonstrations. */
  demonstrationsAvailable: true;
}

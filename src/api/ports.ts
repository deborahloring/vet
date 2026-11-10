// Interfaces for components delivered in later steps. The Worker is wired with
// "not configured" implementations (see dependencies.ts) that deny everything, so no
// protection is simulated: until a real implementation exists, requests fail closed.

import type { DeterministicResult, InvoiceInput, LineRef, RuleId } from '../billing/index.ts';
import type { InvoiceDocument } from '../data/types.ts';
import type { PublicFinding, ReviewOutcome } from './contracts.ts';

/** Cloudflare Access JWT verification (src/auth/access.ts). */
export interface VisitorIdentity {
  /** SHA-256 of the verified token's issuer and subject. The raw subject, email and JWT are never kept. */
  visitorKey: string;
}
export type IdentityFailure = 'missing' | 'invalid' | 'forbidden' | 'not_configured' | 'unavailable';
export type IdentityResult = { ok: true; identity: VisitorIdentity } | { ok: false; reason: IdentityFailure };
export interface IdentityVerifier {
  verify(request: Request): Promise<IdentityResult>;
}

/** SQLite Durable Object counters per Pacific Time day (src/allowance). */
export interface AllowanceSnapshot {
  visitorRemaining: number;
  visitorLimit: number;
  sharedRemaining: number;
  sharedLimit: number;
  /** Pacific calendar day (YYYY-MM-DD) the counters belong to. */
  dayKey: string;
  resetAt: Date;
}
export type ReservationResult =
  | { ok: true; snapshot: AllowanceSnapshot }
  | { ok: false; reason: 'visitor_limit' | 'shared_limit' | 'unavailable'; snapshot?: AllowanceSnapshot }
  /** More than the approved number of review starts in the rolling window; nothing was consumed. */
  | { ok: false; reason: 'busy'; retryAfterSeconds: number; snapshot?: AllowanceSnapshot }
  /** Live reviews are paused after a Gemini quota refusal; nothing was consumed. */
  | { ok: false; reason: 'paused'; snapshot?: AllowanceSnapshot };
export interface AllowanceStore {
  /** Current counts, or null when storage is unavailable (callers fail closed). */
  status(identity: VisitorIdentity): Promise<AllowanceSnapshot | null>;
  /** Atomically reserves one visitor and one shared review. Idempotent per reviewId. */
  reserve(identity: VisitorIdentity, reviewId: string): Promise<ReservationResult>;
  /** Refuse new live reviews (before reservation) until `until`. Returns false if storage is unavailable. */
  pause(until: Date): Promise<boolean>;
}

/** One Gemini interpretation of the documentary evidence (src/gemini). */
export type SupportedAiFindingType =
  | 'declined_service_billed' | 'unsupported_billed_service' | 'quantity_documentation_conflict' | 'duplicate_service';
export type ReviewAiFindingType = 'ambiguous_documentation' | 'insufficient_documentation';
export type AiFindingType = SupportedAiFindingType | ReviewAiFindingType;

export interface AiFinding {
  /** Stable within one result, e.g. "service:2:declined_service_billed". */
  id: string;
  type: AiFindingType;
  /** Internal provenance. Never shown to visitors. */
  origin: 'ai';
  /** Assigned by code from the finding type; never taken from model output. */
  ruleIds: RuleId[];
  /** discrepancy = supported by the notes; staff_review = the notes leave it uncertain. */
  disposition: 'discrepancy' | 'staff_review';
  line: LineRef;
  /** The other line of a duplicate charge. */
  secondaryLine: LineRef | null;
  /** Exact excerpt from the visit notes (verified to be present). */
  noteExcerpt: string;
  /** Plain statement built by code from verified fields; no model-written prose. */
  evidence: string;
}

/** What the visit notes document about discount approval. */
export interface DiscountAuthorization {
  status: 'courtesy' | 'senior' | 'none' | 'unclear';
  /** Verified excerpt from the notes, or null. */
  noteExcerpt: string | null;
}

export interface InterpretationInput {
  invoiceNo: string;
  /** Printed invoice facts (the same input the deterministic engine received). */
  invoice: InvoiceInput;
  document: InvoiceDocument;
  /** Available to the composer; the interpreter does not send it to the model. */
  deterministic: DeterministicResult;
}
export interface InterpretationSuccess {
  ok: true;
  findings: AiFinding[];
  discount: DiscountAuthorization;
  /** Model claims dropped because they were unsupported by the invoice or notes. */
  rejected: number;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number } | null;
}
export type InterpretationFailureReason = 'not_configured' | 'invalid_input' | 'provider_error' | 'quota' | 'timeout' | 'invalid_output';
/** From Google's 429 details when present: which quota was refused and the suggested wait. Never shown to visitors. */
export interface QuotaRefusal {
  scope: 'day' | 'minute' | 'unknown';
  retryAfterSeconds: number | null;
}
/** Diagnostic only, for provider errors: Google's HTTP status and its error status word (e.g. "UNAVAILABLE"). Never its message. */
export interface ProviderErrorDetail {
  providerStatus?: number;
  providerCode?: string;
}
export type InterpretationResult = InterpretationSuccess | ({ ok: false; reason: InterpretationFailureReason; quota?: QuotaRefusal } & ProviderErrorDetail);
export interface Interpreter {
  interpret(input: InterpretationInput): Promise<InterpretationResult>;
}

/** Step 5: merges both sources into one Temperance result and records provenance internally. */
export interface ComposedReview {
  outcome: ReviewOutcome;
  findings: PublicFinding[];
  /** Internal only: provenance per finding, for test logs and evaluation. Never serialized to visitors. */
  provenance: { deterministic: number; ai: number; combined: number };
}
export interface ResponseComposer {
  compose(deterministic: DeterministicResult, interpretation: InterpretationSuccess): ComposedReview;
}

export interface LogEvent {
  event: string;
  route: string;
  status: number;
  code?: string;
  invoiceNo?: string;
  provenance?: ComposedReview['provenance'];
  /** Internal failure category (never secrets), e.g. "timeout". */
  reason?: string;
  tokens?: number;
  /** Diagnostic only: Google's HTTP status and error status word for a provider error. */
  providerStatus?: number;
  providerCode?: string;
}

export interface Dependencies {
  identity: IdentityVerifier | null;
  allowance: AllowanceStore | null;
  interpreter: Interpreter | null;
  composer: ResponseComposer | null;
  now(): Date;
  newReviewId(): string;
  log(event: LogEvent): void;
}

# Approved Decisions and Acceptance Checklist

## Milestone Sequence

| Milestone | Description | Status |
|---|---|---|
| 1 | Repository Configuration | Complete |
| 2 | Project Foundation and Documentation | Complete |
| 3 | Data Integrity and Billing Rules | Complete |
| 4 | Application Implementation | Complete (deployed to the Access-protected preview) |
| 5 | Testing and Evaluation | Complete: development evaluation, TAX-01 and the blind evaluation (run once, November 2026) |
| 6 | Deployment and Acceptance | Released to invited reviewers (November 2026). Open items: live access-revocation test and COST-02 measurements |

Milestone 3 addresses the approved billing-rule corrections, dataset variety, clinically supported discrepancies, discount authorization, documentation requirements, senior discounts, validation improvements, and safe dataset generation.

Preserve the approved dataset size, outcome distribution, finding multiplicities, scenario types, and invoice template.

Milestone 3 is a focused correction effort. It must not expand into an open-ended data analytics or clinical modeling project.

## Data design

- 300 invoices; 300 unique cats; 215 owners with 1/2/3 cat distribution 150/45/20; cat-pun customer names.
- 50 no discrepancy; 200 discrepancy identified; 50 staff review required.
- Four levels of confirmed finding multiplicity among 200: 25 one, 100 two, 60 three, 15 four.
- Ten independent visit archetypes, natural varied note language, 14 scenario types; 25 services, 8 products; fictional billing rules.
- Fourteen scenario types: `no_discrepancy`, 10 confirmed discrepancy types and 3 review types. No insurance.
- Data dictionary for every table, private expected evidence and provenance, no published answer key.

## Experience

- Temperance has no avatar and appears as a single integrated assistant; no visitor-visible explanation of which software component detected a finding.
- Hearthy introduction is short; invoice already possessed; no Hearthy follow-on dialogue once terminal interaction starts.
- Kiosk retains retro identity and three previously approved rotating messages (exact source copy to be recovered/verified).
- No free text or stored survey. Persistent allowance counter. Selectable `View Demonstrations` always available, including interruptions/exhaustion.
- Nine short cat demonstrations are a separate post-launch writing/recording deliverable; do not improvise their approved scripts.
- Behind the Desk rewritten by the owner (November 2026) as a portfolio page for invited reviewers: project background, how Temperance works, blind-evaluation results with a synthetic-data caveat, security and privacy, and the technology used. Owner decision: the page may explain in general terms that traditional software checks calculations and Gemini interprets visit notes; results still never label which source produced a finding (AI-05 is unchanged). The pinned "The Story of Paws & Order" flyer in the interior now opens Behind the Desk.
- Owner dialogue revision (November 2026, supersedes the dialogue in the next item): new Hearthy introduction ending with "Temperance is next to the front desk, on the right-hand side."; the terminal is renamed the Paws & Order Billing Assistance Terminal; revised Temperance greeting, menu notice, invoice prompt, attempt notice and result notices (live results name the hospital billing department; demonstrations say billing staff decide); staff-review results name a billing team member; demonstration stories removed.
- Owner-approved visual and text changes (November 2026), detailed in `04-visitor-experience.md`: subtitle-style dialogue panel for Hearthy; Hearthy's handoff line "Temperance can assist you. Very helpful. Loves talking."; TEMPERANCE on the terminal's top band and the drawn kiosk sign; shortened HELP WANTED flyer ("HELP WANTED / Apply Inside") and larger door notice; mid-air desk pages removed; ivory keyboard; office animations (fan, pinboard, falling pages, mug steam, power-strip spark, desk bell) and exterior motion (clouds, tree); Return to Hospital; Reviewed This Visit tracking with a confirmation before another live review.

## Platform

- TypeScript deterministic billing checks, Gemini interpretation, Cloudflare Access/Worker/SQLite DO; 3 live reviews/visitor/Pacific Time day, 50 shared/Pacific Time day, both resetting at 00:00 Pacific Time; free tiers and no charge exposure.
- Public demo hostname: `vet.deborahloring.com`.
- Prepared PDF extraction at build time, secure server-bound datasets, per-finding internal provenance and evidence.

## Definition of done

An owner-approved read-only baseline exists; scripts/fixtures and documentation pass validation; all PDF rendering/extraction checks pass; offline test suite and blind evaluation are reported without contaminated answers; authorization/quota/concurrency and resource tests pass live; accepted visual screens are checked against source assets; owner signs off before any invited reviewer is given access.

**Owner-approved copy (November 2026):** Hearthy's introduction, Temperance's revised dialogue, Behind the Desk and the three rotating kiosk messages (demonstration stories removed).

**Creative approval complete (November 2026):** finding explanations and error-screen text approved as written; the nine story-free demonstrations approved and the Provisional notice removed. Live reviews open for invited reviewers at release (`DESK_OPEN="true"`), with every existing safeguard unchanged.

**Release verification (owner, 9–10 November 2026):**

| Check | Result |
|---|---|
| Release deployment | Deployed by the owner with live reviews open for invited reviewers (`DESK_OPEN="true"`) |
| Access sign-in | An approved email signed in with a one-time PIN in a private window; an email not on the Access policy received no PIN |
| Access revocation with a second email | Not performed live (owner decision). Worker-side revocation is covered by automated tests (removing an email from `ALLOWED_EMAIL` denies a still-valid token) |
| Cloudflare billing | Owner-confirmed free, unchanged |
| Google billing | Gemini project `paws-and-order-vet` shows **Free tier** in AI Studio, with billing not set up |
| Gemini quota (Gemini 3.5 Flash Lite, AI Studio, last day) | Limits 15 RPM, 250K TPM, 500 RPD. Peak use 12 RPM, 8.65K TPM; 153 requests that day (includes the 150-request blind evaluation) |
| Access policy | Individually listed emails only (owner-confirmed, including the invited reviewers already added); the Worker's `ALLOWED_EMAIL` list is kept identical |
| Unauthenticated route checks | Not re-run for this release. Access protection was live verified earlier on the same hostname and configuration; every path requires a verified identity (automated tests) |
| COST-02 (CPU per request, request counts) | Not measured; remains open |

**Still open:** the live access-revocation test and COST-02 measurements. The application is never public: only reviewer emails the owner individually approves are added to Cloudflare Access, and each is removed when that reviewer's access period ends.

## Decisions recorded November 2026

- **Gemini quota:** independent of the application's daily counters; a new Pacific day is never assumed to restore it. A quota refusal (HTTP 429) uses that attempt and pauses live reviews before any further attempt is reserved: until the next Pacific midnight only when Google explicitly reports a per-day quota, otherwise for Google's suggested wait (60 seconds to 1 hour), which is also the response to ambiguous refusals. No automatic retries, no model switching, no paid tier.
- **Reviewed This Visit:** an invoice is marked when a review attempt is consumed, including unsuccessful reviews; a refusal that uses no attempt does not mark it, and an existing mark is preserved. **Start over** keeps the session's reviewed list and never changes daily allowances; the repeat-review confirmation remains.
- **Deferred:** Hearthy walking around the desk, a fan turning in depth, and an evening street-light glow. Type-checking the test files is optional housekeeping, not required for release.
- **Owner-only live review phase:** complete. The visual round deploys with live reviews closed.

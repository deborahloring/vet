# Requirements and Traceability

| ID | Requirement | Verification |
|---|---|---|
| DAT-01 | Exactly 300 fictional invoices, unique cat names, one visit each | Dataset validator |
| DAT-02 | Clients have 1–3 cats: 150 single-cat, 45 two-cat, 20 three-cat households | Dataset validator |
| DAT-03 | Cat-themed parody client names, authentic cat breed labels | Dataset validator and review |
| DAT-04 | Visits dated 2022–2025, weekdays and selected major US holiday closures excluded | Dataset validator |
| DAT-05 | Ten visit archetypes assigned independently of outcome | Dataset validator + distribution audit |
| DAT-06 | 50 clean, 200 discrepancies, 50 staff review | Private answer validator |
| DAT-07 | Confirmed discrepancy finding multiplicities 25/100/60/15 for 1/2/3/4 findings | Private answer validator |
| DAT-08 | 14 scenario categories; varying prose and plausible services; no scenario-specific shortcuts | Stratified leakage audit + blind model evaluation |
| DAT-09 | Service codes, prices, quantity, notes, total, billing rule IDs link consistently | Dataset validator |
| DAT-10 | Ground truth private; no expected outcome/type field in public records or deployed files | Secret/asset scan |
| PDF-01 | Original owner-approved 73-field invoice preserved | Hash + render review |
| PDF-02 | Finished invoice PDFs flattened; searchable text and zero active widgets | Automated extraction + PDF QA |
| AI-01 | TypeScript performs deterministic catalog and arithmetic rules | Unit tests incl. failing examples |
| AI-02 | Temperance uses documented evidence and rules to describe discrepancies | Blind scored evaluation |
| AI-03 | Unknown codes or incomplete/ambiguous documentation produce staff review | Negative tests |
| AI-04 | Staff retains final decision; no automatic corrections or external actions | Response schema + functional tests |
| AI-05 | One seamless visitor-facing assistant, internal attribution in test logs only (Behind the Desk may describe the overall design in general terms) | UI review + provenance tests |
| UX-01 | Short Hearthy introduction, kiosk entry, no avatar for Temperance | Approved storyboard regression |
| UX-02 | Always-visible `View Demonstrations`; selectable encounter list | Functional tests |
| UX-03 | Demonstrations available even with exhausted quota or AI interruption | Exhaustion/failure tests |
| UX-04 | No free-text input or stored survey; canned satisfaction closing message | UI review + storage inspection |
| SEC-01 | All review endpoints authenticated via Cloudflare Access and JWT verification | Live denial tests |
| SEC-02 | Server-side per-visitor 3/day and global 50/day, both resetting at midnight Pacific Time, atomic reservation | DO concurrency and Pacific-midnight boundary tests, including daylight-saving transitions |
| SEC-03 | Unknown identity, unavailable quota store, invalid method/path all fail closed | Integration tests |
| SEC-04 | API keys and private evaluation data never shipped to clients | Build scan |
| COST-01 | Worker/DO stay on Free plan; no charge exposure | Dashboard check and account configuration |
| COST-02 | Measure CPU per Worker invocation and request/RPM/TPM usage before any invited reviewer is given access | Owner-only production-like tests |
| COST-03 | Worker does not parse PDFs at request time | Build inspection + CPU profiling |
| EVAL-01 | Score both AI-only interpretation and fully integrated response outside visitor sessions | Separate offline evaluation commands |
| OPS-01 | Maintain deployment, rollback, incident and rate-limit instructions | Runbook tabletop exercise |

**Verification status (November 2026):** dataset, billing, response-checking, composer, API, authentication, allowance, UI and PDF requirements are locally verified by the automated test suite. Live verified: Access protection (SEC-01; approved email signs in with a PIN, unapproved email receives none) and the owner-only live review phase. Development and blind evaluations (EVAL-01) are complete. COST-01: owner-confirmed free on Cloudflare; the Gemini project is on the Free tier with billing not set up. Released to invited reviewers in November 2026. Open: CPU per request and request measurements (COST-02, not measured) and a live access-revocation test (Worker-side revocation is covered by automated tests). Details in `08-decisions-and-acceptance.md`.

# Paws & Order Cat Hospital

**A fictional cash-pay veterinary invoice review experience** created as a portfolio demonstration of secure AI/API integration, deterministic validation, and evidence-based evaluation. All clients, patients, services, contact information, and invoices are synthetic.

The visitor interacts with one assistant, **Temperance**. Temperance explains invoice documentation, identifies supported discrepancies, requests staff review when evidence is insufficient, and never authorizes a billing change. Conventional TypeScript code checks catalog prices, quantities, calculations, discounts, and the fictional product-tax rule. The experience does not expose that internal division of labor to visitors.

This project has **no pet insurance, care plans, policy numbers, coverage adjudication, or collections workflow**.

## How it works

1. **Cloudflare Access** signs the visitor in: only emails on the Access policy receive a one-time PIN. The Worker then verifies the Access JWT (signature, issuer, audience, expiry) and checks the email against its own allowlist (`ALLOWED_EMAIL`) on every request, including the page and its files. The two layers are kept identical, so the app stays invitation-only even if the Access policy were loosened by mistake.
2. A **SQLite-backed Durable Object** reserves one live review atomically: 3 per visitor and 50 shared per Pacific Time calendar day (reset at 00:00 America/Los_Angeles), and at most 12 review starts in any rolling 60 seconds. Requests refused before reservation never use an attempt.
3. **TypeScript** checks catalog prices, line arithmetic, subtotal, discounts and the fictional 8% product tax in integer cents.
4. **One Gemini request** interprets the visit notes. Code verifies every claim against the invoice and notes, assigns rule references, and drops anything unsupported. No automatic retries.
5. A **composer** merges both into one Temperance result (No Discrepancy Found, Discrepancy Identified, or Staff Review Required) with application-written explanations. Staff make every final decision. Internal provenance is logged, never shown.
6. The **kiosk** (static files behind Access) presents the hospital scenes, the terminal, the visitor's invoice beside the results, and nine in-kiosk demonstrations that never call the model or use a review.

## Repository layout

- `src/billing/` deterministic billing rules; `src/gemini/` prompt, response checker, interpreter; `src/compose/` unified result; `src/auth/` Access verification; `src/allowance/` and `src/desk-state.ts` daily limits; `src/api/` routes and contracts; `src/kiosk/` visitor interface; `src/generated/` build-time invoice data (generated, committed).
- `config/` visitor pool (30 invoices), demonstrations, kiosk copy.
- `data/` synthetic dataset and dictionary; `templates/` the approved invoice master; `examples/` four published invoice PDFs.
- `scripts/` dataset tools (Python), build steps, local preview, Gemini check, and `scripts/eval/` evaluation tools.
- `tests/` automated tests (Node test runner and Python unittest).
- Private answer keys and evaluation results live **outside this repository** (default `../paws-and-order-evaluation-private-m3/`, or `PAWS_PRIVATE_DATA_DIR`). Never commit or deploy them.

## Build, test and preview

Requires Node 22.18+ and Python with `pypdf` and `reportlab` (invoice PDFs are generated at build time).

```
npm run typecheck
npm test                 # Node and Python tests; no network, no private data
npm run build            # visitor pool check, 30 invoice PDFs, data check, kiosk into dist/
npm run preview:local    # http://127.0.0.1:8787 with local stand-ins for sign-in and Gemini
```

Deployment, live Gemini use and evaluation follow the owner-authorized procedure in `docs/07-operations-runbook.md`.

## Status

| Area | Status |
|---|---|
| Synthetic dataset, validators, invoice PDF pipeline | Locally verified |
| Deterministic billing checks, response checker, composer | Locally verified |
| Access verification, daily limits, busy limit, Pacific resets | Locally verified; Access protection live verified on the protected preview |
| Kiosk, animations, accessibility, demonstrations | Locally verified; released (November 2026) on the invitation-only site |
| Gemini interpretation | Live verified: model and version confirmed; 120 live development-evaluation requests at no more than 8 per minute; owner-only live reviews completed on the protected preview |
| Gemini quota protection (pause on HTTP 429, no retries) | Locally verified and deployed; not yet observed live (no quota refusal has occurred) |
| Provider-error diagnostics (Google's HTTP status and status word in the Worker log; added after the blind evaluation) | Locally verified and deployed; not yet observed live |
| Tax integrity (TAX-01) | Locally verified across all 300 invoices, the 30 on-screen visitor invoices and their PDFs |
| Evaluation split | Frozen (30 visitor, 150 blind, 120 development) |
| Development evaluation | Complete; development results only (see `docs/06-test-and-evaluation-plan.md`). The checker was corrected using these cases, so they do not estimate real-world accuracy |
| Blind evaluation (150 invoices) | Complete (run once, November 2026): 90.7% outcome accuracy, 99.6% finding precision, 91.7% recall, no false alarms on clean invoices; 13 reviews failed with Google provider errors. Synthetic cases; see `docs/06-test-and-evaluation-plan.md` |
| Release (November 2026) | Released to individually invited reviewers with live reviews open. Release verification recorded in `docs/08-decisions-and-acceptance.md`; access revocation was not tested live, and CPU measurements (COST-02) remain open |
| Dialogue, rotating kiosk messages, Hearthy introduction, demonstrations | Owner dialogue revision in place (November 2026; demonstration stories removed). All copy owner-approved; the nine demonstrations are approved live recordings |

## Scope of synthetic data

300 distinct cats, one invoice each, across 215 cat-pun households with one to three cats; 2022–2025 weekday visits excluding selected major observed US holidays. 50 clean invoices, 200 confirmed-discrepancy invoices, 50 staff-review invoices. The 200 discrepancy invoices have 25 one-finding cases, 100 two-finding, 60 three-finding, and 15 four-finding. 14 scenario types and 10 visit archetypes. See `data/generation_summary.json` for measured counts.

Pricing, discounts and tax are **invented project rules**, not representations of veterinary billing practices or Texas law.

## Governance

Deborah Loring is the project owner. All technical status labels are **planned**, **locally verified**, or **live verified**. No evaluation results are reported until they are measured.

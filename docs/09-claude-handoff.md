# Claude Code Handoff — Start With Facts

> **Current status (November 2026):** Milestones 3 and 4 are complete and the application runs on the Access-protected preview. The blind evaluation has been run once. Remaining work is final creative approval and release verification. The application is never public; access is granted only to individually approved reviewer emails, each removed when its review period ends. See the status table in `README.md` and the milestone table in `08-decisions-and-acceptance.md`. The milestone instructions below are kept as the historical record.

## Completed Baseline Assessment

The initial read-only repository assessment has been completed and accepted by Deborah. The prompt below is retained for reference and should not be repeated.

> You are working on a **new** portfolio application, Paws & Order Cat Hospital. This is a fictional **cash-pay veterinary invoice review** workflow. It is not an insurance, claims-adjudication, care-plan, policy or collections project. The project baseline and owner-approved decisions live in the new package under `docs/` and `data/`.
>
> **DO NOT edit, generate, move, delete, commit, run migrations, make provider requests, or deploy anything yet.** First provide a factual inventory of the current repository and configuration. Report files/routes/tests that actually exist; list what is implemented, what is locally tested, what is verified live, and what is only planned. Include concrete paths, observed commands and verifiable evidence. Report only tests actually performed against this application. Treat the cash-pay documents as the authoritative requirements.
>
> Read `README.md`, `docs/01-project-charter.md` through `docs/08-decisions-and-acceptance.md`, and the dataset dictionaries, then inspect the repo source. Compare existing approved artwork, rotating messages, storyboarding and kiosk files to the screen inventory in `docs/04-visitor-experience.md`. Quote exact existing copy and locate its source; do **not** invent it. Inspect all code paths for insurance/claims behavior, new data-schema incompatibilities, missing access control, quota enforcement, model call count, CPU-heavy PDF work, build secrets, and private evaluation leakage. Check `.gitignore` and Git staging/history; **never add or commit `data/evaluation_private/`**.
>
> Report: (1) verified repo inventory, (2) accurate current stack/deployment status, (3) document/UI assets available with paths, (4) measured versus unmeasured limits, (5) blockers and security risks, (6) ordered proposed implementation tasks, each with acceptance criteria. Stop for Deborah's approval. Preserve the approved fillable invoice master unchanged. No changes, even if the fixes seem obvious.

## Milestone 3 — Data Integrity and Billing Rules

This milestone is approved for planning. Its scope and constraints are documented in `docs/08-decisions-and-acceptance.md`.

Claude must present one concise implementation plan for approval before changing files. Once that plan is approved, Claude may complete the authorized work without repeatedly requesting approval for minor implementation details.

Installation, commits, pushes, deployments, and live API calls still require separate authorization.

Milestone 4 begins after Milestone 3 is validated and accepted.

## Milestone 4 — Application Implementation

1. Implement deterministic TypeScript checks from the fictional catalog/rules; use exact cents.
2. Add build-time invoice fill/flatten/extraction pipeline with integrity verification; do not parse PDFs in Worker requests.
3. Implement secure Worker + Access identity checks + SQLite DO atomic counter; then Gemini interpretation and evidence merge.
4. Build the approved screen flow using verified source art/text; preserve a single seamless Temperance UI.
5. Run independent and integrated evaluations against privately held answer keys, including four-finding edge cases; document CPU, request and token usage.
6. Verify the provider Free tiers and zero-charge behavior in owner-only live tests before outside access.

## Boundaries

- Do not pass private expected answers to the model or deploy them.
- Ensure build/security checks narrowly allowlist the intentionally fictional `billing@pawsandordercathospital.com` and continue rejecting unexpected emails.
- Do not assume `gemini-3.5-flash-lite` is available without verifying actual API/model identifiers and free tier quotas.
- Do not silently modify the approved PDF, intro copy, demonstration scripts or the dataset schema.
- Do not represent unverified assumptions or results from another application as evidence that this application works.

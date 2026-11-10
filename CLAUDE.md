# Paws & Order Cat Hospital — Claude Instructions

## Project Overview

**Repository:** `vet`  
**Owner and final decision-maker:** Deborah Loring  
**Project:** Paws & Order Cat Hospital  
**Status:** New implementation; establish a verified baseline before coding.

This is a fictional cash-pay veterinary invoice-review application and a professional AI implementation portfolio case study. It is not an insurance, care-plan, claims, collections, or payment-authorization system.

Temperance is the named AI assistant. Hearthy introduces the visitor briefly, then the visitor interacts with the Paws & Order Billing Assistance Terminal. The story and invoice data are fictional; all claims about implemented behavior, testing, and AI use must be real and verifiable.

## Working Relationship and Authority

- Deborah owns the project, approves decisions, and controls commits, pushes, deployments, installations, and external service use.
- Begin with a **read-only inventory and factual baseline** of the new starter package. Identify actual files, scripts, test results, discrepancies, costs, risks, and open decisions. Make no changes until Deborah approves a specific implementation step.
- For significant changes, present the intended scope, files affected, acceptance criteria, and risks first. Do not treat brainstorming or a recommendation as authorization.
- Work in the approved `feature/project-foundation` branch initially. Never commit, push, merge, open a pull request, publish, or deploy without explicit authorization.
- Never install, update, or remove packages or tools. Deborah runs installations herself after receiving the exact command, purpose, and impact. Do not run download-capable `npx` commands implicitly.
- Never run live Gemini calls or incur paid-service usage without explicit authorization. The budget is $0 and paid inference is not approved.
- Preserve unrelated files and approved designs. Ask before overwriting, deleting, or changing requirements.
- State clearly what was inspected, changed, tested, and not tested. Do not invent evidence, benchmarks, endorsements, or completion status.

## Approved Product Boundaries

- A visitor reviews an assigned **fictional invoice**. No uploads, free-text visitor prompts, insurance coverage determinations, or stored feedback.
- TypeScript performs deterministic checks, including arithmetic, line-item prices, quantities, discounts, and fictional tax rules.
- One Gemini invocation through the backend supports interpretation of visit documentation, conflicts, and evidence. Temperance explains a unified result; the visitor should not see which findings came from code versus AI. (Owner decision, November 2026: Behind the Desk may explain the overall design in general terms; results never label a finding's source.)
- Outcomes: **No Discrepancy Found**, **Discrepancy Identified**, or **Staff Review Required**. Results are advisory; staff retain final authority.
- Apply a limit of **3 reviews per authenticated visitor per Pacific Time calendar day**, plus **50 live reviews globally per Pacific Time calendar day**. Counters reset at 00:00 Pacific Time (America/Los_Angeles, following daylight saving); do not describe them as rolling 24-hour limits.
- The demonstration pathway remains available when live-review limits are reached. The nine recorded demonstration stories will be selected later.
- Intended hosting: protected Cloudflare deployment at `vet.deborahloring.com`, subject to separate deployment approval. Only evidence gathered from this application can support its reported results.
- Respect Cloudflare Workers Free and Gemini free-tier limits. Verify current quotas rather than relying on historical figures. Do not imply Free-tier operation is guaranteed without measurement.
- Build accessible, responsive UI (target WCAG 2.2 AA), with meaningful execution-state indicators, reduced-motion support, and no misleading progress animations.

## Synthetic Data and Evaluation

- The approved dataset has 300 uniquely named cats; clients have 1–3 cats each, with varied ownership counts and cat-name-style parody client names.
- Target invoice outcomes are 50 clean, 200 discrepancy, and 50 staff-review cases. Among discrepancy invoices, the approved finding counts are 25 with one, 100 with two, 60 with three, and 15 with four findings.
- Use ten visit archetypes and fourteen scenario types with independent visit-type labels and natural, varied notes. Avoid detectable shortcuts that leak expected outcomes.
- Validate the truth and compatibility of **every** expected finding, not just totals and file formats. Findings on the same line must not contradict each other.
- Store the private expected-answer key **outside the Git repository**. Generation and validation scripts must support a separately configured private output path; never write the answer key to a tracked directory.
- Generated invoice PDFs must be flattened, searchable, and checked for values, financial consistency, note completeness, and visual overflow. Large generated `invoices/` output stays ignored.
- Use separately held evaluation answers for scoring; do not send the expected answers to the live agent or use final evaluation cases for tuning.
- Capture provenance of each finding internally (deterministic or AI) for testing and case-study evidence, while presenting one cohesive customer result.

## Privacy, Security, and Repository Hygiene

- Read the repository's `.gitignore` before adding files. Never stage or publish private evaluation keys, local reference photographs, confidential documents, generated invoice bulk output, or credentials.
- Do not read, display, edit, or disclose `.dev.vars`, `.env*`, certificates, secret stores, or local credential files. Read only tracked, intentionally blank `.example` files when needed.
- `CLAUDE.local.md`, `local/`, `local_docs/`, and `.claude/` are local-only. Do not copy private working context into public docs, issues, PRs, commit messages, or generated content.
- Synthetic data only. Do not use restricted employer information, imply university endorsement, or make unsupported professional claims.
- Keep the README and project docs consistent with the actual state of implementation. Document decisions, risks, tests, defects, and measurable results truthfully.

## Engineering and Handoff

- Prefer a small maintainable TypeScript/Cloudflare Worker backend, with Python for offline dataset generation, validation, and scoring as approved.
- Treat a successful script exit as insufficient evidence of correct answers. Add semantic and cross-file validations and report unresolved cases.
- Run only safe, authorized local checks that do not install dependencies, mutate private data, use paid services, or deploy.
- Follow approved project documents and the current handoff package. When documentation conflicts, flag the conflict for Deborah rather than choosing an outdated specification.
- Provide a clear recommendation and specific next step. Favor accuracy, traceability, and proportionate complexity over unnecessary features.


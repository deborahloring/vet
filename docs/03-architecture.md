# Technical Design and Attribution

## Request flow

1. Cloudflare Access authenticates an allowlisted visitor (one-time PIN to emails on the Access policy). The Worker verifies the signed Access JWT and checks the email against its own `ALLOWED_EMAIL` list on every request, static files included (defense in depth: a loosened Access policy still admits no one outside the list, and removing an email denies a still-valid session), then validates route and method.
2. SQLite-backed Durable Object atomically checks/reserves one of 3 visitor reviews and one of 50 shared reviews per **Pacific Time calendar day**. Both reset at 00:00 Pacific Time (America/Los_Angeles).
3. Worker resolves a *server-allowlisted* invoice ID to build-time extracted text, structured line items, relevant catalog/rules, and verified PDF SHA-256 reference. Avoid runtime PDF parsing.
4. TypeScript performs deterministic price/currency, line multiplication, totals, discount and fictional tax checks. It produces structured findings and citations.
5. At most one planned Gemini interpretation call receives only relevant clinical documentation, available charge evidence, and rules. A bounded one-time retry may be permitted for recoverable errors **only with idempotent reservation handling**.
6. Server normalizes/validates Gemini output, deduplicates overlapping findings, merges both sources under one Temperance response, and logs internal provenance for testing/diagnostics only.
7. The UI renders one visitor-facing invoice analysis with references and the clear statement that staff makes final decisions. No technical implementation labels appear in the UI.

## Provenance in internal evidence

Every finding has `origin: deterministic | ai | combined`, affected code or field, rule ID, observed evidence, recommendation and confidence/uncertainty. Only the test report may break down AI-only and integrated-system accuracy; visitors see one explanation.

## Time, cost and privacy

- **Cloudflare Worker Free:** CPU budget is limited per HTTP invocation (commonly 10 ms on Free; confirm current dashboard/account). Waiting for Gemini network fetch does not itself consume CPU. Avoid heavyweight JWT libraries, PDF parsers, enormous JSON payloads and synchronous loops in the request path.
- **Durable Object Free:** SQLite-backed only; keep writes minimal, use short transactions, avoid remaining active waiting for Gemini. Check operation/duration quotas in account.
- **Gemini:** Verify current model name, free-tier request/token/minute/day quotas and API availability in the *actual project's* Google AI Studio. Do not assume yesterday's allowance still applies. Bound output tokens, input context, model calls and retries.
- **No paid fallback:** On quota/provider failure, show service interruption with `View Demonstrations`. Never automatically upgrade, attach billing or retry without a cap.
- **Preprocessing:** During build, fill/flatten each finished PDF and extract/verify all textual evidence. Deploy only permitted public demo assets, no private evaluation truth.

## Proposed API shapes (validate before implementation)

`GET /api/allowance` → `{remaining, limit, resetAt}` from the server; no Gemini request. `resetAt` is the next midnight Pacific Time, sent as an absolute timestamp, and the kiosk may show it in the visitor's local time zone.

`POST /api/review` accepts only a predefined invoice/session identifier, and returns `{invoiceNo, outcome, findings:[{code, evidence, ruleRef, explanation}], staffDecisionRequired:true, remaining}`. No visitor-entered free text.

`GET /api/demonstrations` serves static metadata; video/demo playback is prerecorded and consumes no Gemini review allowance.

All endpoints require explicit authorization and rate limits consistent with approved access scope. Public HTTP responses must not expose internal provenance or private scoring data.

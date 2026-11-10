# Operations, Cost Control, and Incident Runbook

## Before deploying

- Cloudflare Worker and SQLite-backed Durable Object on the free tier; Cloudflare Access policy and the Worker's `ALLOWED_EMAIL` list configured identically and independently verified. Worker public side doors disabled.
- Gemini project free-tier quota and supported model verified in Google AI Studio. Confirm that **billing is not enabled**. Record actual RPD/RPM/TPM limits; never rely only on model marketing names.
- Secrets in platform configuration; never commit `.dev.vars`, credentials, test JWTs or answer keys.
- Confirm build assets exclude private evaluation files, all 300 raw records unless explicitly allowed, and unexpected emails. The fictional `billing@pawsandordercathospital.com` may be narrowly allowlisted.
- Validate PDF hashes and text extraction, precompute lookup manifests, ensure no runtime PDF parsing.
- Record CPU per request, DO operations/duration, Worker invocation count, and model request/token counts for each route, including full 4-finding cases.

## Quota behavior

- `GET /api/allowance` retrieves server state only; no Gemini request.
- Atomic counter reservation precedes a review, and is idempotent per review attempt.
- 3 reviews per authenticated user **per Pacific Time calendar day**; globally 50 reviews **per Pacific Time calendar day**; both reset at **00:00 Pacific Time** (America/Los_Angeles). A reserve refusal makes **zero** model calls.
- When quota runs out or any dependency is unavailable, present an honest service-interruption or daily-limit screen with `View Demonstrations`.
- Exactly one Gemini request per review, with no automatic retries (owner decision). A request refused before reservation never uses an attempt; a Gemini failure after reservation keeps the attempt consumed.
- Gemini quota is separate from the application counters; a new Pacific day is never assumed to restore it. When Gemini answers 429, the attempt that received it stays used and the Durable Object pauses live reviews: until the next Pacific midnight if Google reports a per-day quota, otherwise for Google's suggested delay (60 seconds to 1 hour). While paused, reviews are refused before reservation (503 `live_reviews_paused`, "No review was used"), no model request is made, and demonstrations stay available. After the pause, the next review is tried normally and pauses again if Gemini still refuses. Visitors never see quota numbers; the Worker logs `live_reviews_paused` with the scope only.
- At most 12 review starts in any rolling 60 seconds (atomic in the Durable Object, below Gemini's 15 requests/minute). Excess starts receive `terminal_busy` with `Retry-After` and use no attempt.

## On incident

1. Disable new live reviews: set `"DESK_OPEN": "false"` in `wrangler.jsonc` and run `npx wrangler deploy`. Only review starts are refused ("Live reviews are closed right now", no attempt used, no model request); sign-in, the hospital, Behind the Desk and the demonstrations stay available. Reopen by setting it back to `"true"` and deploying.
2. Capture time, route, provider error, per-request CPU and token counts. For a Gemini provider error, the Worker's `interpretation_failed` log line includes `providerStatus` (HTTP status) and, when Google supplies it, `providerCode` (for example `UNAVAILABLE`); it never includes Google's error message. Do not log visitor identities or invoice secrets unnecessarily.
3. Check Access, JWT, DO quota, Worker CPU and Google quota separately.
4. Restore only after the failing control has been verified and no billing exposure remains.

## Rollback

Redeploy the last owner-verified Worker/static release; keep the DO schema backward-compatible and do not reset visitor limits to hide failures. Never switch providers, enable a paid tier, or enlarge quotas automatically.

## Live integration and release procedure

Each numbered step needs the owner's explicit authorization. Keep `DESK_OPEN="false"` until step 4.

Rate limits: live evaluation runs at 8 requests per minute by default (never faster than 10), against Gemini's free-tier 15 per minute and 500 per day. Never run an evaluation while live reviews are open: the site may start up to 12 reviews per minute from the same Gemini project. Check the AI Studio rate-limit page before and after each run.

1. **Confirm the model.** In the owner's own terminal session (the key never enters chat or files): `node scripts/check-gemini.ts --metadata`, then `node scripts/check-gemini.ts --sample`. Record the model name, token limits, JSON-format compliance, latency and token counts.
2. **Freeze the evaluation split.** `python scripts/eval/allocate.py --authorized` writes `allocation.json` (30 visitor, 150 blind, 120 development) to the private directory. It refuses to overwrite, so the split is frozen once written.
3. **Development evaluation.** `PAWS_EVAL_LIVE_AUTHORIZED=yes node scripts/eval/run-eval.ts --live --manifest <allocation.json> --split development --recordings <private dir>/recordings --out <results dir>/dev.json --max-requests 120`, then `python scripts/eval/score.py --authorized --split development ...` for both `--view integrated` and `--view ai_only`. Tuning may use development results only; re-score changes from recordings with `--mode replay` instead of new requests.
4. **Owner-only live reviews.** Set `DESK_OPEN="true"` and deploy while Access admits only the owner. Verify per-visitor and shared limits, the busy limit, Pacific reset times, Worker CPU per request and Gemini token use. Capture the nine demonstration recordings from these runs and replace the provisional entries in `config/demonstrations.json` (`"source": "live-recording"`).
5. **Blind evaluation (final, once).** Run the blind split live, then `score.py --authorized --confirm-blind`. Do not change prompts, rules or code after viewing blind results; report them as measured.
6. **Release verification.** Approved demonstrations and dialogue in place; revocation test with a second email; Billing at $0. The application is never opened to the public: the owner adds individually approved reviewer emails to the Access policy and removes each one when that reviewer's access period ends.

**Inviting or removing a reviewer** needs both layers, kept identical:

- **Cloudflare Access policy** (Zero Trust → Access → Applications → the app → Policies): add or remove the email under Include → Emails. When removing, also revoke the reviewer's session.
- **Worker allowlist** (`ALLOWED_EMAIL` secret, comma-separated, owner first): `npx wrangler secret put ALLOWED_EMAIL`, then paste the complete updated list. This takes effect immediately without a code deploy. An email on the Access policy but missing from `ALLOWED_EMAIL` can receive a PIN and sign in, but every request, including the page itself, is refused with an access-denied response, so add new reviewers to both lists before inviting them. Removing an email denies that reviewer at the Worker even while an Access session is still valid. If a later deploy uploads secrets from a file (`--secrets-file`), that file's list replaces the current one, so keep it up to date.

**Progress (November 2026):** steps 1 to 4 are complete. The model is confirmed, the split is frozen, the development evaluation is done (development results in `docs/06-test-and-evaluation-plan.md`), the nine demonstrations were recorded live, the owner-only live review phase is finished, and the blind evaluation has been run once (results in `docs/06-test-and-evaluation-plan.md`). Creative approval is complete, and the release was deployed with live reviews open for invited reviewers (`DESK_OPEN="true"`). Step 6 is recorded in `docs/08-decisions-and-acceptance.md`: the live revocation test and the COST-02 measurements were not performed and remain open.


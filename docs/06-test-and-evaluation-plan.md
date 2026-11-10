# Test and Evaluation Plan

## Evaluation pools

Define development, blind evaluation, and nine prerecorded demonstration assignments **once** in a private, versioned allocation manifest. A test invoice is not moved from the blind pool to development after its results are observed. Seed and dataset hash should be recorded. Before any performance claim, verify the split contains all 14 scenario types and meaningful 1–4 finding coverage.

## Scoring

- **Deterministic module:** exact fee/code arithmetic, tax, discount and total checks; include negative cases, authorized discounts and corrupted amounts.
- **Temperance-only:** pass the same clinical text/evidence but without deterministic findings; score what the language model independently detects, explains, and cites.
- **Integrated system:** score final merged findings, supported evidence, references, review classification and deduplication.
- **Finding-level metrics:** precision/recall and per-scenario detection, plus false positives on clean invoices. A four-finding case only passes fully if **all four** independent findings are identified without unsupported additions.
- **Case-level metrics:** no discrepancy / discrepancy / staff review classification, hallucinated facts, unauthorized decision, model errors, and cost per completed review.
- **Leakage analysis:** cross-tab scenario type against visit archetype, code, clinical-note wording, first line, cat name, and invoice year; inspect identical note prefixes and outcome cues.
- **Provider usage:** number of Gemini requests, input/output tokens, retries, actual observed RPM/TPM, wall time; Worker request count and CPU; DO operations and duration.

## Minimum automated gates

1. Dataset referential integrity, allowed dates, uniqueness, 50/200/50 and 25/100/60/15 counts.
2. 73-field master preserved, finished PDFs flattened, all invoice fields searchable after extraction, no note text clipping; render sample from each outcome and **all 15 four-finding cases**.
3. Zero private answer labels in public/client assets or repository history.
4. Unit tests for TypeScript arithmetic with cents represented as integers/precise decimal, never binary float sums.
5. API contract, fail-closed auth, invalid identifiers, expired identity, server quota, 14 concurrent attempts.
6. UI no text-entry and all demo fallback paths; counters never consume Gemini quota.
7. Owner-only live limit test and Cloudflare/Gemini dashboard evidence **before** inviting others.

## Results to date (November 2026)

### Development evaluation: development results, not blind results

120 development invoices from the frozen split (20 clean, 78 discrepancy, 22 staff review), model `gemini-3.5-flash-lite`, one live request per invoice at no more than 8 per minute; every raw reply is saved outside the repository. Later rows re-score the **same saved replies** after checker corrections; no new model requests were made for them.

| Run | Change | Outcome accuracy | Finding precision | Finding recall | Staff-review cases found | False alarms on clean invoices |
|---|---|---|---|---|---|---|
| 1 | First live run | 94.2% | 92.1% | 96.6% | 20/22 | 4 |
| 2 | Claims rejected when contradicted by their own quote | 97.5% | 98.0% | 97.1% | 20/22 | 0 |
| 3 | Claims reclassified from their quotes (unclear completion; declined vs not performed) | 99.2% | 99.5% | 99.5% | 22/22 | 0 |
| 4 | One-occurrence quotes treated as quantity conflicts; staff-review claims checked against their quotes | 100% (120/120) | 100% | 100% | 22/22 | 0 |

- Billing-rule references were correct on 100% of matched findings in every run. Matched note-based findings quoted the expected evidence 86.8% (run 1) to 87.6% (run 4) of the time; the remainder quote other supporting text.
- Deterministic checks alone: outcome accuracy 75.8%, precision 100%, recall 50.5%. AI interpretation alone (run 4): all 99 note-based findings found, but by design it does not detect arithmetic, price or code errors.
- **These figures are not an estimate of real-world accuracy.** Each correction in runs 2 to 4 was made after studying development errors, and the cases were then re-scored, so the final development figures are expected to be optimistic. Only the blind evaluation (below) measures performance on unseen cases.

Corrections were made only where the model's own quoted evidence and the prompt's category definitions clearly supported them, and only in the response checker; no billing rule or expected answer was changed to raise a score. The final two development errors were investigated individually:

- **PO-2025-0146 (missed quantity conflict):** Nail Trim is billed ×3 and the notes say "No repeat of the nail trim was documented." The model labelled it "not performed"; the checker correctly rejected that label but dropped the line instead of recognizing a one-occurrence quote. Checker gap; corrected.
- **PO-2022-0089 (unneeded staff review):** the model flagged the Nutritional Consultation as unclear while quoting "Only one nutritional consultation was performed." (billed ×1). Model error that the checker did not catch because staff-review claims were not checked against their quotes; corrected.

Both expected answers were consistent with the notes and rules. Each correction changed only its target invoice among the 120.

**Known limitations:** the checker recognizes a fixed set of general English phrasings (for example "only one", "no repeat", "declined", "pending", "unclear"); unfamiliar wording falls back to the model's own label or to rejection of the claim. The model's labels can still vary between runs, and quota refusals are handled by pausing live reviews rather than retrying.

### Blind evaluation (final, run once)

150 blind invoices from the frozen split (25 clean, 101 discrepancy, 24 staff review), run once by the owner on 9 November 2026 with the frozen prompt (`promptSha256` `f3f4bff5…91c0a7`), engine 1.0.0 and model `gemini-3.5-flash-lite`: one live request per invoice at no more than 8 per minute, no retries, no quota refusal. None of these invoices was used for development, and nothing was changed after the results were seen. Scored with `score.py --authorized --confirm-blind`.

| View | Outcome accuracy | Finding precision | Finding recall | Staff-review cases found | False alarms on clean invoices |
|---|---|---|---|---|---|
| Integrated (what visitors see) | 90.7% (136/150) | 99.6% (1 false positive) | 91.7% (232/253) | 23/24 | 0 |
| AI interpretation alone | 72.0% | 99.1% | 44.7% (by design) | 18/24 | 0 |

- **Failed reviews (13 of 150, 8.7%):** every failure was a `provider_error`: Google returned an error other than a quota refusal (or the connection failed). None was a timeout, an invalid reply or a quota refusal. The failures were spread through the run (request positions 38 to 144). A failed review returns no result, so its deterministic findings also count as missed. The runner does not record the HTTP status of provider errors, so the specific Google error is unknown.
- **Completed reviews (137):** 136 received the correct outcome. The one error was a discrepancy invoice classified as needing staff review.
- **Complete cases** (every expected finding and nothing extra): by number of expected findings: none 21/25 (all 4 misses were failed reviews), one 39/40, two 42/48, three 29/31, four 5/6.
- Billing-rule references were correct on 100% of matched findings. The response checker rejected 29 model claims. One unsupported staff-review flag (ambiguous documentation) reached a result.
- The AI-alone view found 113 of 125 note-based findings, and every one of them quoted the expected evidence. The integrated evidence rate (86.3%) is lower because discount and deterministic findings carry their quotation in the evidence text rather than the note-excerpt field the scorer reads; this is a scoring limitation, not missing evidence.
- Usage: 150 requests, 112,235 tokens.
- These are synthetic, deliberately difficult cases with discrepancies over-represented; they are not an estimate of accuracy on real invoices.

**Observation after the blind run:** about 1 live review in 11 may end with a service-interruption screen that uses the attempt.

**Change made after the blind evaluation (owner-approved, diagnostic only):** when Google returns a provider error, the Worker's `interpretation_failed` log now also records Google's HTTP status (`providerStatus`) and its error status word (`providerCode`, for example `UNAVAILABLE`). Google's error message is never logged, and the visitor response is unchanged. Review behavior, the prompt, the response checker, the billing rules and the evaluation runner are unchanged, so the blind results above still describe the application's results. The change is covered by local unit tests only; it has not been observed live. The evaluation runner was not changed and still records only `provider_error`.

### TAX-01: invoice tax integrity

Rule: services are not taxed; products are taxed at 8% (B-03) on undiscounted products, rounded half up to the cent (B-08). Checked locally across all 300 invoices without model requests:

- The catalog marks every service non-taxable and every product taxable; no service is printed as a product or the reverse.
- Every invoice's products total equals its printed product lines, and every total due equals subtotal minus discount plus printed tax.
- 258 invoices carry the correct tax (135 have no products, so $0.00). 42 carry deliberately incorrect tax (10 omit it, 11 also tax services, 21 show other wrong amounts); all 42 are labelled scenarios in the private answer key, and no unlabelled tax error exists.
- The deterministic engine finds all 42 tax errors with no false alarms. The data validator and the in-memory build of all 300 PDFs pass (every value present and fitting on the page).
- The 30 visitor invoices match their source exactly on screen (lines and totals) and in their generated PDFs.
- No invoice falls exactly on a half cent, so rounding is exercised by the engine's unit tests rather than the dataset.
- Tax is checked against the invoice's printed products total. When a product price or line amount is wrong, that error is reported as its own finding, and the tax is not reported a second time.

## Caveat

The 300 synthetic cases intentionally emphasize discrepancies (200/300). Report stratified metrics and finding-level metrics, not overall accuracy alone. These are synthetic test cases, not a representative sample of real veterinary invoices.

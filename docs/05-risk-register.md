# Risk Register

| ID | Risk | Severity | Control | Evidence needed |
|---|---|---|---|---|
| R-01 | Gemini free-tier RPD/RPM/TPM exhausted | High | Daily global cap 50, per-visitor cap 3, one planned model call/review, bounded retry, recorded fallback | Google dashboard and live quota rejection test |
| R-02 | Worker exceeds free 10 ms CPU budget on individual request | Critical | Build-time PDF processing, small payloads, low-dependency deterministic checks; measure CPU separately on each route | CPU percentiles, worst-case four-finding run |
| R-03 | Cloudflare account incurs a charge | Critical | Free plans only, zero paid fallback, owner verifies billing/account thresholds; fail closed | Account screenshots/checklist (private) |
| R-04 | Private truth labels published or embedded | Critical | Answer keys stored outside the repository (scripts refuse in-repo paths and will not overwrite existing keys); `evaluation_private/` and `expected_*.csv` ignored as a backstop; denylist scans incl. Git history and Workers assets | Deploy/archive scan |
| R-05 | Invoices encode outcome shortcuts | High | Randomize archetypes and phrasing, inspect lexical leakage and blind outcome prediction | Stratified leakage report |
| R-06 | Combined findings are duplicates or obscure source accuracy | High | Structured finding IDs and provenance, separate independent AI and integrated evaluations | Merge unit tests and scoring report |
| R-07 | Multi-finding invoice contains contradictory evidence | High | Validate every finding independently against notes and invoice, human-review samples | Manual 25-case sample and all 4-finding cases |
| R-08 | Security bypass exposes costly API | Critical | Access + JWT verification + server invoice allowlist + atomic DO quota | Unauthorized and concurrent tests |
| R-09 | PDF form values inaccessible to model or visually clipped | High | Flatten finished PDFs, verify field appearances and `pdftotext` content | Render and extraction report |
| R-10 | Scripted demo presented as live AI review | Medium | Distinct demo label and prerecorded player, no model request | Browser/network tests |
| R-11 | Insurance terminology appears in the cash-pay invoice experience | High | Keep documents, code contracts, and visitor-facing copy consistent with cash-pay billing; flag `policy`, `coverage`, and `claim` terminology during review | Repo-wide scope audit |
| R-12 | Visitor-facing result promises an automatic refund or decision | High | Staff-authorization requirement for every finding | Schema and copy review |
| R-13 | The Gemini/model configuration from prior tests no longer matches deployed version | High | Pin exact available model and revision only after verified API test | Model metadata and date-stamped live test |

Risk controls are requirements, not assertions of completed implementation.

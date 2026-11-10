# Data Dictionary — Paws & Order Synthetic Data

All data is fictional. Primary and foreign keys are strings. Monetary values use USD decimal text with two fractional digits. The hospital bills **cash for veterinary services/products**, not insurance, claims, care plans or collections. Private answer keys are stored in a **separate directory outside the repository** and are not permitted in model prompts or deployed assets.

## `clients.csv` — 215 owner records

| Field | Type | Meaning |
|---|---|---|
| `client_id` | string PK | Stable `CL-####` owner ID |
| `client_name` | string unique | Cat-themed parody human name |
| `address` | string | Synthetic Whiskerbrook, TX street address, no ZIP |
| `phone` | string | Fictional placeholder contact number |
| `cat_count` | integer 1–3 | Number of related patients; distribution 150/45/20 |

## `patients.csv` — 300 unique cats

| Field | Type | Meaning |
|---|---|---|
| `patient_id` | string PK | `PT-####` |
| `client_id` | string FK | Owner in `clients` |
| `pet_name` | string unique | Unique cat name across all 300, no duplicate suffixes |
| `breed` | string | Cat breed shown on invoice |
| `age_years` | integer | Synthetic age at visit |

## `service_catalog.csv` — 33 fictional fees

| Field | Type | Meaning |
|---|---|---|
| `code` | string PK | Standard item code |
| `section` | enum | `service` or `product` |
| `description` | string | Canonical item name |
| `standard_unit_price` | decimal | Price authoritative for deterministic checks |
| `taxable` | `yes`/`no` | Fictional products-only tax flag |
| `unit` | string | Unit is `each` |

## `billing_rules.csv` — thirteen billing rules

| Field | Type | Meaning |
|---|---|---|
| `rule_id` | string PK | `B-01`…`B-13` |
| `rule_name` | string | Human-readable title |
| `rule_value` | string | Value or formula text |
| `description` | string | Applicable interpretation |

All services untaxed. Products taxed at an invented 8% (B-03). At most one discount applies per invoice, to service charges only, never to the product-tax base: a $10 courtesy discount (B-06) or a senior wellness discount of 10% of the EX-105 standard price, $9.00 (B-07), for a Senior wellness visit for a cat aged 10 or older with EX-105 billed. Either discount requires authorization documented in the visit notes. B-09 covers duplicate charges, B-11 billed services that conflict with the notes, B-12 code validity, and B-13 documentation completeness; a billed service the notes do not mention is not, by itself, a documentation problem. Discount and tax handling is solely a fictional exercise, not Texas tax advice.

## `visits.csv` — 300 invoice headers and clinical evidence

| Field | Type | Meaning |
|---|---|---|
| `invoice_no` | string PK | `PO-YYYY-####` |
| `visit_id` | string unique | `VIS-#####` |
| `patient_id` | string FK | Patient for this invoice |
| `client_id` | string FK | Patient's owner |
| `visit_date` | ISO date | 2022–2025 weekday, excluding selected observed holidays |
| `issue_date` | ISO date | Same date as visit |
| `visit_type` | enum-like string | One of ten clinical archetypes, **not** an outcome cue; `Senior wellness` only for cats aged 10 or older |
| `veterinarian` | string | Fictional clinician |
| `visit_notes` | string | Hospital-facing narrative clinical record; may contain relevant contradictions/uncertainty |
| `discount_type` | `none` / `courtesy` / `senior` | **Internal dataset metadata** naming the discount the notes authorize. It supports generation and evaluation only; the reviewing application must not treat it as authorization. Authorization comes from the visit notes. The displayed discount is in totals. |

## `invoice_items.csv` — invoice charges

| Field | Type | Meaning |
|---|---|---|
| `invoice_no` | string FK | Parent invoice |
| `section` | enum | `service` or `product` |
| `line_number` | integer | 1-based within section; composite key with invoice + section |
| `code` | string | Billed code; may be invalid in intentional review fixture |
| `description` | string | Printed item description; may conflict with code |
| `quantity` | integer | Charged quantity, sometimes conflicting with visit notes |
| `unit_price` | decimal | **Displayed** unit price (not presumed correct) |
| `amount` | decimal | **Displayed** line total (not presumed correct) |

Approved invoice capacity: up to 7 services and 3 products. A repeated code or a quantity above one is not by itself an error; the visit notes establish whether the service was performed that many times (B-09, B-11).

## `invoice_totals.csv` — displayed summary

| Field | Type | Meaning |
|---|---|---|
| `invoice_no` | string PK/FK | Parent invoice |
| `services_total` | decimal | Displayed sum of service lines |
| `products_total` | decimal | Displayed sum of product lines |
| `subtotal` | decimal | Printed subtotal, may include an intentional fault |
| `discount` | decimal | Printed discount, may include an intentional fault |
| `tax` | decimal | Printed fictional product tax, may include intentional fault |
| `total_due` | decimal | Printed subtotal − discount + tax |

## `evaluation_private/expected_reviews.csv` — private case truth

| Field | Type | Meaning |
|---|---|---|
| `invoice_no` | string FK | Evaluation case |
| `expected_outcome` | enum | `no_discrepancy`, `discrepancy_identified`, `staff_review_required` |
| `primary_scenario` | enum | Assigned primary category for stratified evaluation |
| `finding_count` | integer | Expected findings for this invoice: 0 for clean, 1–4 confirmed discrepancies, or exactly 1 staff-review issue |
| `scenario_types` | pipe-delimited string | All intentionally assigned scenario categories |
| `expected_total_due` | decimal or blank | Corrected total **only if determinable**; blank for unresolved code/clinical uncertainty |
| `expected_explanation` | string | Private summary of expected rationale |
| `requires_human_authorization` | `yes` | Always yes |

## `evaluation_private/expected_findings.csv` — private item-level truth

| Field | Type | Meaning |
|---|---|---|
| `invoice_no` | string FK | Parent invoice |
| `finding_number` | integer | 1-based expected finding within case |
| `finding_type` | enum | One of the 13 non-clean categories |
| `affected_code` | string or blank | Line code relevant to the finding, blank for summary-only faults |
| `rule_reference` | string | One or more `B-##` billing rule IDs |
| `evidence` | string | Expected invoice/clinical contradiction or calculation |
| `expected_action` | string | Staff review or proposed correction, never autonomous action |
| `origin` | enum | `deterministic`, `ai`, or `combined` attribution **for test reporting only** |
| `requires_human_authorization` | `yes` | Staff owns correction decision |
| `affected_section` | enum | `service`, `product`, or `summary` |
| `affected_line` | integer string or blank | Exact 1-based invoice line within the affected section |
| `secondary_line` | integer string or blank | Second line of a verified duplicate-service finding |
| `note_evidence` | string or blank | Exact supporting clinical-note excerpt; blank for arithmetic/catalog-only findings |

## `generation_summary.json` — reproducibility and quality metadata

JSON keys: `seed` (fixed PRNG seed), `clients`, `cats`, `invoices`, `line_items`, `findings` (all expected finding rows, 515), `confirmed_discrepancy_findings` (465, from the 25/100/60/15 multiplicity), `staff_review_findings` (50, one per staff-review invoice), `discount_types` (counts), `outcomes` (counts by case classification), `findings_per_discrepant_invoice` (1–4 counts), `primary_scenarios` (14 categories and primary counts), `visit_archetypes` (10 categories), `time_period` (inclusive ISO range). Never use scenario counts or summary as model hints during inference.

## `invoice_manifest.json` — generated invoice integrity

Each JSON record: `invoice_no`, `filename`, `sha256`, `searchable_text_verified` (boolean), `populated_fields_verified` (integer), `note_lines_verified` (integer), `visual_fit_verified` (boolean; every drawn value fits its visible field area), `widgets_remaining` (integer; must be 0). Written to the output folder by `scripts/build_invoices.py`. Generated after filling and flattening the approved PDF master. This manifest contains no private outcomes.

## Finding counts

The 200 discrepancy invoices carry 465 confirmed findings (25×1 + 100×2 + 60×3 + 15×4). The 50 staff-review invoices each carry one review issue. `expected_findings.csv` therefore has 515 rows: 465 confirmed discrepancy findings plus 50 staff-review findings.

## Private/public boundary

Only the two private evaluation tables contain known outcome labels and expected answers. The default location is `../paws-and-order-evaluation-private-m3/` (generated with the current dataset), configurable with `PAWS_PRIVATE_DATA_DIR` or the scripts' `--private-dir` option. The scripts reject a private path inside the repository, and the generator refuses to overwrite existing answer files unless `--overwrite-private` is given. The answer keys must remain physically separated from public Git history and deployment; `.gitignore` alone is not a security boundary. Freeze evaluation assignments and run evaluation independently of visitor sessions.

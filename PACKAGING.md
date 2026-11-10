# Package delivery and privacy

The **public starter package** includes all synthetic hospital-facing CSVs, docs, the approved PDF master, a deterministic generator, validators, an invoice PDF builder and a few flattened invoice examples. It contains **no expected result labels**. It is the project to place in a new public Git repository after review.

The separately supplied **private evaluation key** includes `expected_reviews.csv` and `expected_findings.csv`. Store outside the public repository and production build. Scripts default to `../paws-and-order-evaluation-private-m3/` (a sibling of the repository, holding the answer key generated with the current dataset); `PAWS_PRIVATE_DATA_DIR` may point to another external folder. The generator refuses a private path inside the project. Never place answers in Git history, a Worker asset, or a Gemini prompt.

The invoice generator creates all 300 PDF fixtures locally via `python scripts/build_invoices.py`, including `invoice_manifest.json` and SHA-256 checks. The 300 rendered documents collectively exceed 900 MB before compression because the approved decorative artwork appears in each file. For a clean, practical source repository, retain the generator, master and a small audited sample; generate the full set on demand and keep the bulk output ignored. For demos deploy only selected approved invoices, not the whole corpus.

The project documents intentionally contain no historical before/after comparison. Approved stories and recorded demonstration case assignments are scheduled after the new application works. Exact prior visual/text approvals require the owner's original source artifacts; this package does not invent missing artwork or revolving-message wording.

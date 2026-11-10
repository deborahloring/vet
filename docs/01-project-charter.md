# Project Charter — Paws & Order Cat Hospital

**Sponsor and decision maker:** Deborah Loring. **Status:** scope approved; implementation verification pending. **Date:** November 2026.

## Business purpose

Show how a technical implementation analyst can define a fictional business workflow, build a secured API-backed AI assistant, separate deterministic software checks from language-model interpretation, test the resulting system, and document risks and operations. Visitors experience a short humorous hospital introduction, then an invoice review kiosk.

## In scope

- Entirely fictional **cash-pay** veterinary invoices and clients.
- 300 synthetic invoices, 50 clean, 200 with discrepancies, 50 requiring staff review; 14 scenario types and multiple independently evidenced findings.
- Conventional code validating catalog prices and financial calculations; Temperance interpreting documentation and explaining findings with evidence/rule references.
- Cloudflare Access, Worker, SQLite-backed Durable Object, private Gemini API key, static UI, server-derived usage limits, recorded selectable demonstrations, and visitor-friendly failure handling.
- A visually consistent hospital world featuring Hearthy, decorative carrot/earth-tone motifs, the retro Paws & Order Billing Assistance Terminal, and Temperance without an avatar.
- Test evidence, private ground truth, deployment/runbook guidance and clean public documentation.

## Out of scope

- Insurance claims, insurance coverage, care plans or policies, payment collection, real customer data, processing actual billing adjustments, real patient advice, a generalized data-cleaning or analytics platform.
- Free-text visitor input, storing satisfaction survey answers, pet stories and recording scripts beyond those specifically approved.
- Paid Gemini or Cloudflare tiers without a separate owner decision.

## Success

End-to-end invoice review is correct, secure, resource-bounded, explainable, and responsibly fails closed. Evidence must distinguish independent AI interpretation from deterministic checks *internally*, while visitors receive one clear coherent response. Site, source code, datasets and results must be suitable for a technical job portfolio.

## Critical limits

Each approved visitor can request **3 live reviews per Pacific Time calendar day**, with a shared ceiling of **50 live reviews per Pacific Time calendar day**. Both counters reset at **00:00 Pacific Time** (America/Los_Angeles, following daylight saving). These are product caps, not guarantees that provider quotas suffice. Demonstrations remain available after the visitor limit or during service interruptions. No feedback is collected; the closing feedback screen displays a canned thank-you.

"""Independent dataset validation (standard library only).

Checks the public synthetic data and the private answer key against the approved
distributions, billing rules B-01..B-13, and the visit-note evidence. Every
expected finding is verified individually, and every invoice is checked for
unlabeled faults, contradictory evidence, and outcome shortcuts.

Usage:
  python scripts/validate.py --private-dir ../paws-and-order-evaluation-private-m3
  python scripts/validate.py --public-dir <copy of data/> --private-dir <answer dir>

Exits 0 only when every check passes. Does not use `assert`, so `python -O` is safe.
Reads files only; never writes.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import textwrap
from collections import Counter, defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRIVATE = ROOT.parent / 'paws-and-order-evaluation-private-m3'

# Approved distributions (docs/08-decisions-and-acceptance.md).
OUTCOMES = {'no_discrepancy': 50, 'discrepancy_identified': 200, 'staff_review_required': 50}
MULTIPLICITY = {1: 25, 2: 100, 3: 60, 4: 15}
PRIMARY_COUNTS = {'no_discrepancy': 50, 'unit_price_mismatch': 20, 'line_arithmetic': 15,
                  'subtotal_arithmetic': 10, 'discount_arithmetic': 10, 'tax_arithmetic': 10,
                  'quantity_documentation_conflict': 25, 'duplicate_service': 30,
                  'declined_service_billed': 30, 'code_description_conflict': 20,
                  'unsupported_billed_service': 30, 'unknown_code': 10,
                  'ambiguous_documentation': 20, 'insufficient_documentation': 20}
REVIEW_TYPES = {'unknown_code', 'ambiguous_documentation', 'insufficient_documentation'}
DISCREPANCY_TYPES = set(PRIMARY_COUNTS) - REVIEW_TYPES - {'no_discrepancy'}
EXPECTED_ORIGIN = {'unit_price_mismatch': 'deterministic', 'line_arithmetic': 'deterministic',
                   'subtotal_arithmetic': 'deterministic', 'tax_arithmetic': 'deterministic',
                   'discount_arithmetic': 'combined', 'code_description_conflict': 'combined',
                   'unknown_code': 'combined', 'quantity_documentation_conflict': 'ai',
                   'duplicate_service': 'ai', 'declined_service_billed': 'ai',
                   'unsupported_billed_service': 'ai', 'ambiguous_documentation': 'ai',
                   'insufficient_documentation': 'ai'}
EXPECTED_RULE = {'line_arithmetic': 'B-04', 'subtotal_arithmetic': 'B-05', 'tax_arithmetic': 'B-03/B-08',
                 'quantity_documentation_conflict': 'B-11', 'duplicate_service': 'B-09',
                 'declined_service_billed': 'B-11', 'unsupported_billed_service': 'B-11',
                 'code_description_conflict': 'B-12', 'unknown_code': 'B-12',
                 'ambiguous_documentation': 'B-13', 'insufficient_documentation': 'B-13'}
LINE_TYPES = {'unit_price_mismatch', 'line_arithmetic', 'quantity_documentation_conflict',
              'code_description_conflict', 'duplicate_service', 'declined_service_billed',
              'unsupported_billed_service', 'unknown_code', 'ambiguous_documentation',
              'insufficient_documentation'}
REMOVAL_TYPES = {'declined_service_billed', 'unsupported_billed_service'}
SENIOR_AGE = 10
NOTE_WIDTH, NOTE_LINES = 82, 4

# Note vocabulary families, written independently of the generator's phrase lists.
NEGATIVE = re.compile(r'declined|not given|cancell?ed|removed .* from the treatment plan|'
                      r'not administered|not performed|opted not to', re.I)
COUNT_ONE = re.compile(r'\bonly one\b|\bsingle\b|\brecords one\b|\bonce\b|\bone occurrence\b|'
                       r'\bno repeat\b|\bone package\b', re.I)
MULTIPLE = re.compile(r'\btwice\b|\bsecond\b|\btwo\b', re.I)
UNSETTLED = re.compile(r'unclear|does not confirm|without a completed|awaiting|pending|not been finalized', re.I)
DISCOUNT_WORD = re.compile(r'discount|reduction', re.I)
APPROVAL = re.compile(r'approved|authorized|granted|confirmed|approval', re.I)
DENIAL = re.compile(r'\bnone\b|\bnot\b|\bno discount\b', re.I)


class IncompatibleAnswerKey(Exception):
    """The private answer key does not describe this dataset; per-invoice checks cannot run."""


class Report:
    def __init__(self):
        self.failures = []
        self.passed = []

    def check(self, ok, message):
        if not ok:
            self.failures.append(message)
        return ok

    def section(self, name, before):
        if len(self.failures) == before:
            self.passed.append(name)


def money(value):
    return Decimal(str(value)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def load(path):
    with path.open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def nth_weekday(year, month, weekday, n):
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def last_weekday(year, month, weekday):
    last = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def observed(d):
    return {5: d - timedelta(days=1), 6: d + timedelta(days=1)}.get(d.weekday(), d)


def closures(year):
    """Observed US federal holidays, computed independently of the generator."""
    days = {observed(date(year, m, d)) for m, d in [(1, 1), (6, 19), (7, 4), (11, 11), (12, 25)]}
    days |= {nth_weekday(year, 1, 0, 3), nth_weekday(year, 2, 0, 3), last_weekday(year, 5, 0),
             nth_weekday(year, 9, 0, 1), nth_weekday(year, 10, 0, 2), nth_weekday(year, 11, 3, 4)}
    days.add(observed(date(year + 1, 1, 1)))
    return days


def sentences(notes):
    return [s for s in re.split(r'(?<=\.)\s+', notes.strip()) if s]


def discount_authorizations(notes):
    found = []
    for s in sentences(notes):
        if DISCOUNT_WORD.search(s) and APPROVAL.search(s) and not DENIAL.search(s):
            found.append(('senior' if 'senior' in s.lower() else 'courtesy', s))
    return found


def validate(public, private):
    rep = Report()
    clients = load(public / 'clients.csv')
    patients = load(public / 'patients.csv')
    catalog = load(public / 'service_catalog.csv')
    rules = load(public / 'billing_rules.csv')
    visits = load(public / 'visits.csv')
    items = load(public / 'invoice_items.csv')
    totals = load(public / 'invoice_totals.csv')
    reviews = load(private / 'expected_reviews.csv')
    findings = load(private / 'expected_findings.csv')
    summary = json.loads((public / 'generation_summary.json').read_text(encoding='utf-8'))

    by_catalog = {x['code']: x for x in catalog}
    descriptions = {x['description'].lower(): x['code'] for x in catalog}
    by_patient = {x['patient_id']: x for x in patients}
    by_visit = {x['invoice_no']: x for x in visits}
    by_total = {x['invoice_no']: x for x in totals}
    by_review = {x['invoice_no']: x for x in reviews}
    rule_ids = {x['rule_id'] for x in rules}

    # The answer key must describe exactly this dataset before any per-invoice check runs.
    review_ids = [x.get('invoice_no', '') for x in reviews]
    finding_ids = {x.get('invoice_no', '') for x in findings}
    missing = set(by_visit) - set(by_review)
    extra = set(by_review) - set(by_visit)
    unknown_findings = finding_ids - set(by_visit)
    duplicates = len(review_ids) - len(set(review_ids))
    if missing or extra or unknown_findings or duplicates:
        sample = sorted(missing)[:3] or sorted(extra)[:3] or sorted(unknown_findings)[:3]
        raise IncompatibleAnswerKey(
            f'the private answer key in {private} does not match the public dataset in {public}: '
            f'{len(missing)} dataset invoices have no answer, {len(extra)} answers have no invoice, '
            f'{len(unknown_findings)} findings reference unknown invoices, {duplicates} duplicate answers '
            f'(e.g. {", ".join(sample)}). Use the answer key generated with this dataset (--private-dir).')

    # 1. Reference data and relationships.
    n = len(rep.failures)
    rep.check(len(clients) == 215 and len(patients) == 300, 'expected 215 clients and 300 patients')
    rep.check(Counter(x['section'] for x in catalog) == {'service': 25, 'product': 8}, 'catalog must have 25 services and 8 products')
    rep.check(rule_ids == {f'B-{k:02d}' for k in range(1, 14)}, f'billing rules must be B-01..B-13, found {sorted(rule_ids)}')
    rep.check(len({x['pet_name'].casefold() for x in patients}) == 300, 'pet names must be unique')
    rep.check(len({x['client_name'].casefold() for x in clients}) == 215, 'client names must be unique')
    rep.check(Counter(int(x['cat_count']) for x in clients) == {1: 150, 2: 45, 3: 20}, 'household distribution must be 150/45/20')
    rep.check(Counter(x['client_id'] for x in patients) == {x['client_id']: int(x['cat_count']) for x in clients},
              'patients per client must match cat_count')
    rep.check(len(visits) == len(by_visit) == len(by_total) == len(by_review) == 300, 'need 300 unique invoices in visits, totals and reviews')
    rep.check(set(by_visit) == set(by_total) == set(by_review), 'invoice numbers differ between files')
    rep.check(len({v['patient_id'] for v in visits}) == 300 and len({v['visit_id'] for v in visits}) == 300,
              'each cat must have exactly one visit with a unique visit_id')
    rep.section('reference data, households and relationships', n)

    # 2. Dates and headers.
    n = len(rep.failures)
    blocked = set().union(*(closures(y) for y in range(2022, 2026)))
    for v in visits:
        inv = v['invoice_no']
        d = date.fromisoformat(v['visit_date'])
        rep.check(by_patient.get(v['patient_id'], {}).get('client_id') == v['client_id'], f'{inv}: patient/client mismatch')
        rep.check(date(2022, 1, 1) <= d <= date(2025, 12, 31), f'{inv}: visit date out of range')
        rep.check(d.weekday() < 5, f'{inv}: visit on a weekend')
        rep.check(d not in blocked, f'{inv}: visit on an observed holiday {d}')
        rep.check(v['issue_date'] == v['visit_date'], f'{inv}: issue date differs from visit date')
        rep.check(re.fullmatch(rf'PO-{d.year}-\d{{4}}', inv) is not None, f'{inv}: invoice number format/year')
        age = int(by_patient[v['patient_id']]['age_years'])
        if v['visit_type'] == 'Senior wellness':
            rep.check(age >= SENIOR_AGE, f'{inv}: senior wellness visit for a {age}-year-old cat')
        lines = textwrap.wrap(v['visit_notes'], width=NOTE_WIDTH, break_long_words=False, break_on_hyphens=False)
        rep.check(len(lines) <= NOTE_LINES and len(' '.join(lines)) == len(v['visit_notes']),
                  f'{inv}: notes do not fit {NOTE_LINES} invoice lines')
    rep.check(len({v['visit_type'] for v in visits}) == 10, 'need ten visit archetypes')
    rep.section('dates, holidays, headers, senior ages and note fit', n)

    # 3. Private answer key structure and approved distributions.
    n = len(rep.failures)
    rep.check(Counter(x['expected_outcome'] for x in reviews) == OUTCOMES, 'outcomes must be 50/200/50')
    rep.check(Counter(int(x['finding_count']) for x in reviews if x['expected_outcome'] == 'discrepancy_identified') == MULTIPLICITY,
              'discrepancy multiplicity must be 25/100/60/15')
    rep.check(Counter(x['primary_scenario'] for x in reviews) == PRIMARY_COUNTS, 'primary scenario counts differ from approved')
    confirmed = sum(int(x['finding_count']) for x in reviews if x['expected_outcome'] == 'discrepancy_identified')
    review = sum(int(x['finding_count']) for x in reviews if x['expected_outcome'] == 'staff_review_required')
    rep.check(confirmed == 465, f'confirmed discrepancy findings must total 465, found {confirmed}')
    rep.check(review == 50, f'staff-review findings must total 50, found {review}')
    rep.check(len(findings) == confirmed + review, f'finding rows {len(findings)} != {confirmed}+{review}')
    grouped_findings = defaultdict(list)
    for f in findings:
        grouped_findings[f['invoice_no']].append(f)
        rep.check(f['invoice_no'] in by_visit, f'finding for unknown invoice {f["invoice_no"]}')
        rep.check(f['requires_human_authorization'] == 'yes', f'{f["invoice_no"]}: finding lacks staff authorization')
        rep.check(f['origin'] == EXPECTED_ORIGIN.get(f['finding_type']), f'{f["invoice_no"]}: origin {f["origin"]} for {f["finding_type"]}')
        rep.check(all(r in rule_ids for r in f['rule_reference'].split('/')), f'{f["invoice_no"]}: unknown rule {f["rule_reference"]}')
    for r in reviews:
        inv, outcome = r['invoice_no'], r['expected_outcome']
        rows = sorted(grouped_findings[inv], key=lambda x: int(x['finding_number']))
        kinds = [x['finding_type'] for x in rows]
        rep.check(r['requires_human_authorization'] == 'yes', f'{inv}: review lacks staff authorization')
        rep.check(len(rows) == int(r['finding_count']), f'{inv}: finding_count mismatch')
        rep.check([int(x['finding_number']) for x in rows] == list(range(1, len(rows) + 1)), f'{inv}: finding numbers not sequential')
        rep.check(len(set(kinds)) == len(kinds), f'{inv}: repeated finding type')
        rep.check(r['scenario_types'].split('|') == kinds if kinds else r['scenario_types'] == '', f'{inv}: scenario_types disagree with findings')
        if outcome == 'no_discrepancy':
            rep.check(not kinds and r['primary_scenario'] == 'no_discrepancy', f'{inv}: clean invoice has findings')
        elif outcome == 'staff_review_required':
            rep.check(len(kinds) == 1 and kinds[0] in REVIEW_TYPES, f'{inv}: staff review must have one review finding')
        else:
            rep.check(kinds and set(kinds) <= DISCREPANCY_TYPES and kinds[0] == r['primary_scenario'], f'{inv}: discrepancy findings invalid')
    rep.section('answer-key structure, outcomes 50/200/50, multiplicity 25/100/60/15, 465 + 50 findings', n)

    # 4. Per-invoice billing, discount and evidence checks.
    n = len(rep.failures)
    lines_by_invoice = defaultdict(list)
    for x in items:
        lines_by_invoice[x['invoice_no']].append(x)
        rep.check(x['invoice_no'] in by_visit, f'line for unknown invoice {x["invoice_no"]}')
    leak = defaultdict(Counter)
    deltas = defaultdict(set)
    for v in visits:
        inv = v['invoice_no']
        notes = v['visit_notes']
        arr = lines_by_invoice[inv]
        shown = by_total[inv]
        rows = grouped_findings[inv]
        kinds = {f['finding_type'] for f in rows}
        outcome = by_review[inv]['expected_outcome']
        age = int(by_patient[v['patient_id']]['age_years'])

        services = [x for x in arr if x['section'] == 'service']
        products = [x for x in arr if x['section'] == 'product']
        rep.check(1 <= len(services) <= 7 and len(products) <= 3, f'{inv}: invoice capacity exceeded')
        for group in (services, products):
            rep.check(sorted(int(x['line_number']) for x in group) == list(range(1, len(group) + 1)), f'{inv}: line numbers not contiguous')
        for x in arr:
            rep.check(int(x['quantity']) > 0 and Decimal(x['unit_price']) > 0 and Decimal(x['amount']) > 0, f'{inv}: non-positive line value')
            if x['code'] == 'DEN-402':
                rep.check(v['visit_type'] == 'Dental care', f'{inv}: dental cleaning outside a dental visit')
        s_total = sum((Decimal(x['amount']) for x in services), Decimal(0))
        p_total = sum((Decimal(x['amount']) for x in products), Decimal(0))
        rep.check(s_total == Decimal(shown['services_total']) and p_total == Decimal(shown['products_total']),
                  f'{inv}: section totals do not equal printed line amounts')
        rep.check(Decimal(shown['total_due']) == Decimal(shown['subtotal']) - Decimal(shown['discount']) + Decimal(shown['tax']),
                  f'{inv}: total_due is not subtotal - discount + tax')

        # Locate each line-level finding's target.
        key = {(x['section'], x['line_number']): x for x in arr}
        targeted = defaultdict(set)
        removed, duplicates, qty_fixed = set(), set(), set()
        for f in rows:
            kind = f['finding_type']
            if kind in LINE_TYPES:
                target = key.get((f['affected_section'], f['affected_line']))
                if not rep.check(target is not None, f'{inv}: {kind} has no affected line'):
                    continue
                rep.check(target['code'] == f['affected_code'], f'{inv}: {kind} affected_code mismatch')
                targeted[id(target)].add(kind)
                if kind in REMOVAL_TYPES:
                    removed.add(id(target))
                if kind == 'quantity_documentation_conflict':
                    qty_fixed.add(id(target))
                if kind == 'duplicate_service':
                    other = key.get((f['affected_section'], f['secondary_line']))
                    if rep.check(other is not None and other is not target and other['code'] == target['code'],
                                 f'{inv}: duplicate_service secondary line invalid'):
                        duplicates.add(id(other))
                        targeted[id(other)].add('duplicate_secondary')
            else:
                rep.check(f['affected_section'] == 'summary' and not f['affected_line'], f'{inv}: {kind} must be summary-level')
            if kind == 'unit_price_mismatch':
                expected_rule = 'B-02' if f['affected_section'] == 'product' else 'B-01'
            elif kind == 'discount_arithmetic':
                expected_rule = 'B-07' if v['discount_type'] == 'senior' else 'B-06'
            else:
                expected_rule = EXPECTED_RULE[kind]
            rep.check(f['rule_reference'] == expected_rule, f'{inv}: {kind} cites {f["rule_reference"]}, expected {expected_rule}')
            if f['note_evidence']:
                rep.check(f['note_evidence'] in notes, f'{inv}: {kind} note evidence not found in the notes')

        # Line-level truth: every fault is labeled, and every label is a real fault.
        for x in arr:
            labels = targeted[id(x)]
            entry = by_catalog.get(x['code'])
            qty, unit, amount = int(x['quantity']), Decimal(x['unit_price']), Decimal(x['amount'])
            rep.check((entry is None) == ('unknown_code' in labels), f'{inv}: unknown-code label mismatch on {x["code"]}')
            if entry is not None:
                price_wrong = unit != Decimal(entry['standard_unit_price'])
                rep.check(price_wrong == ('unit_price_mismatch' in labels), f'{inv}: unit-price label mismatch on {x["code"]}')
                if price_wrong:
                    deltas['unit_price_mismatch'].add(unit - Decimal(entry['standard_unit_price']))
                desc_wrong = x['description'] != entry['description']
                rep.check(desc_wrong == ('code_description_conflict' in labels), f'{inv}: description label mismatch on {x["code"]}')
                if desc_wrong:
                    rep.check(x['description'].lower() in descriptions, f'{inv}: conflicting description is not a catalog service')
            arithmetic_wrong = amount != unit * qty
            rep.check(arithmetic_wrong == ('line_arithmetic' in labels), f'{inv}: line-arithmetic label mismatch on {x["code"]}')
            if arithmetic_wrong:
                deltas['line_arithmetic'].add(amount - unit * qty)

        # Summary-level truth.
        subtotal_wrong = Decimal(shown['subtotal']) != s_total + p_total
        rep.check(subtotal_wrong == ('subtotal_arithmetic' in kinds), f'{inv}: subtotal label mismatch')
        if subtotal_wrong:
            deltas['subtotal_arithmetic'].add(Decimal(shown['subtotal']) - s_total - p_total)
        formula_tax = money(p_total * Decimal('0.08'))
        tax_wrong = Decimal(shown['tax']) != formula_tax
        rep.check(tax_wrong == ('tax_arithmetic' in kinds), f'{inv}: tax label mismatch')
        if tax_wrong:
            deltas['tax_arithmetic'].add(Decimal(shown['tax']) - formula_tax)
            rep.check(products, f'{inv}: tax finding without products')

        # Discounts (B-06/B-07): discount_type is dataset metadata; authorization is in the notes.
        auths = discount_authorizations(notes)
        auth_kinds = {k for k, _ in auths}
        dtype = v['discount_type']
        rep.check(dtype in ('none', 'courtesy', 'senior'), f'{inv}: invalid discount_type {dtype}')
        rep.check(auth_kinds == ({dtype} if dtype != 'none' else set()), f'{inv}: discount_type {dtype} disagrees with notes {auth_kinds}')
        if dtype == 'senior':
            billed_exam = [x for x in arr if x['code'] == 'EX-105' and id(x) not in removed]
            rep.check(v['visit_type'] == 'Senior wellness' and age >= SENIOR_AGE and billed_exam,
                      f'{inv}: senior discount without an eligible senior wellness visit and EX-105')
        expected_discount = {'none': Decimal('0'), 'courtesy': Decimal('10.00'),
                             'senior': money(Decimal(by_catalog['EX-105']['standard_unit_price']) * Decimal('0.10'))}.get(dtype, Decimal('0'))
        discount_wrong = Decimal(shown['discount']) != expected_discount
        rep.check(discount_wrong == ('discount_arithmetic' in kinds), f'{inv}: discount label mismatch')
        if discount_wrong:
            rep.check(dtype != 'none', f'{inv}: discount finding without documented authorization')
            deltas['discount_arithmetic'].add(Decimal(shown['discount']))
            evidence = next((f['note_evidence'] for f in rows if f['finding_type'] == 'discount_arithmetic'), '')
            rep.check(evidence in [s for _, s in auths], f'{inv}: discount finding must cite the authorization sentence')

        # Sentence-level evidence: every note statement about a billed service is consistent
        # with the billed lines and the expected findings.
        def related(desc):
            return [x for x in arr if x['description'].lower() == desc
                    or (x['code'] in by_catalog and by_catalog[x['code']]['description'].lower() == desc)]
        multi_documented = set()
        for s in sentences(notes):
            low = s.lower()
            mentioned = [d for d in descriptions if d in low]
            for d in mentioned:
                lines = related(d)
                labels = set().union(*(targeted[id(x)] for x in lines)) if lines else set()
                printed_qty = sum(int(x['quantity']) for x in arr if x['description'].lower() == d)
                if NEGATIVE.search(s) and lines:
                    rep.check(labels & REMOVAL_TYPES, f'{inv}: note says "{d}" was not done but no finding: {s}')
                if UNSETTLED.search(s) and lines:
                    rep.check(labels & {'ambiguous_documentation', 'insufficient_documentation'},
                              f'{inv}: unsettled documentation for billed "{d}" without a review finding: {s}')
                if COUNT_ONE.search(s) and lines and printed_qty > 1:
                    rep.check(labels & {'quantity_documentation_conflict', 'duplicate_service'},
                              f'{inv}: note documents one "{d}" but {printed_qty} billed without a finding')
                if MULTIPLE.search(s):
                    ok = lines and printed_qty == 2 and not (labels & {'quantity_documentation_conflict', 'duplicate_service'})
                    rep.check(ok, f'{inv}: note documents two "{d}" inconsistent with billing: {s}')
                    multi_documented.add(d)
        code_counts = Counter(x['code'] for x in arr)
        for x in arr:
            repeated = int(x['quantity']) > 1 or code_counts[x['code']] > 1
            if repeated and not targeted[id(x)] & {'quantity_documentation_conflict', 'duplicate_service', 'duplicate_secondary'}:
                rep.check(x['description'].lower() in multi_documented, f'{inv}: repeated {x["code"]} lacks documentation of two')
        for f in rows:
            kind, evidence = f['finding_type'], f['note_evidence']
            target = key.get((f['affected_section'], f['affected_line']))
            desc = target['description'].lower() if target else ''
            if kind in REMOVAL_TYPES:
                rep.check(bool(NEGATIVE.search(evidence)) and desc in evidence.lower(), f'{inv}: {kind} evidence does not state the service was not done')
            elif kind in ('quantity_documentation_conflict', 'duplicate_service'):
                rep.check(bool(COUNT_ONE.search(evidence)) and desc in evidence.lower(), f'{inv}: {kind} evidence does not document one')
                if kind == 'quantity_documentation_conflict':
                    rep.check(target is not None and int(target['quantity']) > 1, f'{inv}: quantity finding on a single-quantity line')
            elif kind in ('ambiguous_documentation', 'insufficient_documentation'):
                rep.check(bool(UNSETTLED.search(evidence)) and desc in evidence.lower(), f'{inv}: {kind} evidence is not unsettled documentation')
            elif kind in ('discount_arithmetic',):
                pass
            else:
                rep.check(evidence == '', f'{inv}: {kind} should not need note evidence')

        # Independent expected total due.
        determinable = outcome != 'staff_review_required' and 'code_description_conflict' not in kinds
        expected = by_review[inv]['expected_total_due']
        rep.check(bool(expected) == determinable, f'{inv}: expected_total_due blank/non-blank is wrong')
        if determinable and expected:
            keep = [x for x in arr if id(x) not in removed and id(x) not in duplicates]
            def corrected(section):
                return sum((Decimal(by_catalog[x['code']]['standard_unit_price']) * (1 if id(x) in qty_fixed else int(x['quantity']))
                            for x in keep if x['section'] == section), Decimal(0))
            cs, cp = corrected('service'), corrected('product')
            due = money(cs + cp - expected_discount + money(cp * Decimal('0.08')))
            rep.check(due == Decimal(expected), f'{inv}: expected_total_due {expected} but recomputed {due}')

        # Shortcut audit counters.
        group = 'clean' if outcome == 'no_discrepancy' else 'finding'
        leak[group]['invoices'] += 1
        leak[group]['negative'] += bool(NEGATIVE.search(notes))
        leak[group]['count_one'] += bool(COUNT_ONE.search(notes))
        leak[group]['unsettled'] += bool(UNSETTLED.search(notes))
        leak[group]['quantity_over_1'] += any(int(x['quantity']) > 1 for x in arr)
        leak[group]['repeated_code'] += any(c > 1 for c in code_counts.values())
        leak[group]['sentences'] += len(sentences(notes))
    rep.section('every line, total, discount and finding verified against notes and catalog', n)

    # 5. Outcome-shortcut gates.
    n = len(rep.failures)
    for cue in ('negative', 'count_one', 'unsettled', 'quantity_over_1', 'repeated_code'):
        rep.check(leak['clean'][cue] >= 3, f'shortcut: "{cue}" appears on only {leak["clean"][cue]} clean invoices')
    for kind in ('unit_price_mismatch', 'line_arithmetic', 'subtotal_arithmetic', 'tax_arithmetic', 'discount_arithmetic'):
        rep.check(len(deltas[kind]) >= 3, f'shortcut: {kind} uses only {sorted(deltas[kind])}')
    senior = [v for v in visits if v['discount_type'] == 'senior']
    senior_errors = [v for v in senior if any(f['finding_type'] == 'discount_arithmetic' for f in grouped_findings[v['invoice_no']])]
    rep.check(len(senior) - len(senior_errors) >= 3 and len(senior_errors) >= 1,
              f'B-07 coverage: {len(senior) - len(senior_errors)} correct and {len(senior_errors)} incorrect senior discounts')
    rep.section('outcome-shortcut audit (cue families on clean invoices, varied fault amounts)', n)

    # 6. Summary and public/private separation.
    n = len(rep.failures)
    expect = dict(clients=215, cats=300, invoices=300, line_items=len(items), findings=len(findings),
                  confirmed_discrepancy_findings=confirmed, staff_review_findings=review,
                  outcomes=dict(Counter(x['expected_outcome'] for x in reviews)),
                  findings_per_discrepant_invoice={str(k): v for k, v in Counter(int(x['finding_count']) for x in reviews
                                                                                 if x['expected_outcome'] == 'discrepancy_identified').items()},
                  primary_scenarios=dict(Counter(x['primary_scenario'] for x in reviews)),
                  visit_archetypes=dict(Counter(x['visit_type'] for x in visits)),
                  discount_types=dict(Counter(x['discount_type'] for x in visits)))
    for k, value in expect.items():
        rep.check(summary.get(k) == value, f'generation_summary.json {k} does not match the data')
    private_terms = ('expected_outcome', 'primary_scenario', 'finding_type', 'expected_total_due', 'scenario_types', 'note_evidence')
    for name in ('clients.csv', 'patients.csv', 'visits.csv', 'invoice_items.csv', 'invoice_totals.csv',
                 'service_catalog.csv', 'billing_rules.csv'):
        content = (public / name).read_text(encoding='utf-8')
        rep.check(not any(t in content for t in private_terms), f'{name} contains a private answer-key term')
    rep.section('summary metadata and public/private separation', n)

    return rep, leak, deltas, visits, by_review


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--public-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--private-dir', type=Path,
                        default=Path(os.environ.get('PAWS_PRIVATE_DATA_DIR', str(DEFAULT_PRIVATE))))
    args = parser.parse_args(argv)
    private = args.private_dir.expanduser().resolve()
    if private == ROOT or ROOT in private.parents:
        sys.exit('FAIL: the private evaluation folder must be outside the project repository')
    public = args.public_dir.expanduser().resolve()
    for folder, names in ((private, ('expected_reviews.csv', 'expected_findings.csv')),
                          (public, ('visits.csv', 'invoice_items.csv', 'invoice_totals.csv', 'generation_summary.json'))):
        absent = [name for name in names if not (folder / name).is_file()]
        if absent:
            print(f'FAIL: missing {", ".join(absent)} in {folder}')
            sys.exit(1)
    try:
        rep, leak, deltas, visits, by_review = validate(public, private)
    except IncompatibleAnswerKey as error:
        print(f'FAIL: {error}')
        sys.exit(1)

    print('Shortcut audit (invoices containing each cue):')
    for group in ('clean', 'finding'):
        c = leak[group]
        print(f'  {group:8} n={c["invoices"]:3}  negative={c["negative"]:3}  count_one={c["count_one"]:3}  '
              f'unsettled={c["unsettled"]:3}  qty>1={c["quantity_over_1"]:3}  repeated_code={c["repeated_code"]:3}  '
              f'mean_sentences={c["sentences"] / max(c["invoices"], 1):.2f}')
    print('Fault amounts: ' + '; '.join(f'{k}={sorted(str(x) for x in v)}' for k, v in sorted(deltas.items())))
    table = Counter((v['visit_type'], by_review[v['invoice_no']]['expected_outcome']) for v in visits)
    print('Visit type x outcome (clean / discrepancy / staff review):')
    for vt in sorted({v['visit_type'] for v in visits}):
        print(f'  {vt:24} {table[(vt, "no_discrepancy")]:3} {table[(vt, "discrepancy_identified")]:4} {table[(vt, "staff_review_required")]:3}')
    for name in rep.passed:
        print(f'PASS: {name}')
    if rep.failures:
        print(f'FAIL: {len(rep.failures)} problem(s)')
        for message in rep.failures[:60]:
            print(f'  - {message}')
        if len(rep.failures) > 60:
            print(f'  ... {len(rep.failures) - 60} more')
        sys.exit(1)
    print('RESULT: all checks passed')


if __name__ == '__main__':
    main()

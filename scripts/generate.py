"""Reproducible synthetic cash-pay veterinary billing dataset; standard library only.

Authored inputs (never modified): clients.csv, patients.csv, service_catalog.csv,
billing_rules.csv. Generated public outputs: visits.csv, invoice_items.csv,
invoice_totals.csv, generation_summary.json. Generated private outputs, always
outside the repository: expected_reviews.csv, expected_findings.csv.

No network requests and no real client data. Everything is built and checked in
memory first; nothing is written unless all distribution checks pass.

Usage:
  python scripts/generate.py --private-dir ../paws-and-order-evaluation-private-m3
  python scripts/generate.py --public-dir <scratch dir> --private-dir <scratch dir>

The private directory defaults to PAWS_PRIVATE_DATA_DIR, then to
../paws-and-order-evaluation-private. Existing private answer files are never
overwritten unless --overwrite-private is given.
"""
from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import random
import sys
import textwrap
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
DEFAULT_PRIVATE = ROOT.parent / 'paws-and-order-evaluation-private-m3'
PRIVATE_FILES = ('expected_reviews.csv', 'expected_findings.csv')

SEED = 20261108
NOTE_WIDTH, NOTE_LINES = 82, 4          # must match scripts/build_invoices.py
MAX_SERVICES, MAX_PRODUCTS = 7, 3       # approved invoice capacity
SENIOR_AGE = 10                         # B-07 eligibility
COURTESY_DISCOUNT = Decimal('10.00')    # B-06
SENIOR_RATE = Decimal('0.10')           # B-07, applied to the EX-105 standard price
TAX_RATE = Decimal('0.08')              # B-03
CENT = Decimal('0.01')


def money(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def fmt(value) -> str:
    return f'{money(value):.2f}'


# Each archetype: (exam code, plausible additional services, plausible products).
ARCHETYPES = {
    'Annual wellness': ('EX-101', ['VAC-301', 'VAC-302', 'VAC-303', 'PR-501', 'LAB-204', 'PR-505'], ['MED-605', 'MED-606']),
    'Kitten and new patient': ('EX-102', ['VAC-302', 'VAC-303', 'VAC-301', 'PR-505', 'LAB-204', 'PR-501'], ['MED-606', 'MED-605']),
    'Senior wellness': ('EX-105', ['LAB-201', 'LAB-202', 'LAB-203', 'LAB-205', 'PR-501', 'VAC-301'], ['MED-602']),
    'Dental care': ('DEN-401', ['DEN-402', 'LAB-201', 'LAB-202', 'PR-501'], ['SUP-701', 'MED-601']),
    'Skin and coat': ('EX-108', ['LAB-201', 'PR-501', 'LAB-204', 'PR-503'], ['MED-604', 'MED-605', 'SUP-702']),
    'Ear concern': ('EX-109', ['PR-502', 'LAB-201', 'PR-501', 'PR-503'], ['MED-603', 'MED-601']),
    'Digestive concern': ('EX-103', ['LAB-204', 'LAB-201', 'LAB-202', 'PR-504', 'LAB-203'], ['MED-606', 'MED-601']),
    'Mobility assessment': ('EX-110', ['LAB-201', 'LAB-202', 'PR-504', 'PR-501'], ['MED-602']),
    'Behavioral consultation': ('EX-106', ['EX-107', 'LAB-201', 'LAB-205', 'PR-501'], ['SUP-702']),
    'Follow-up': ('EX-104', ['LAB-203', 'LAB-201', 'PR-504', 'PR-502'], ['MED-601', 'MED-602', 'MED-603']),
}
# Common add-ons used when an archetype's own list is exhausted (never dental cleaning).
GENERAL_SERVICES = ['PR-501', 'PR-503', 'LAB-201', 'LAB-203', 'PR-502', 'VAC-301', 'LAB-204']
# Services that can legitimately be performed twice in one visit.
REPEATABLE = ['PR-504', 'LAB-201', 'PR-502']
UNKNOWN_CODES = ['EX-999', 'PR-998', 'LAB-997', 'DEN-996', 'VAC-995', 'EX-190', 'LAB-290', 'PR-590']
VETERINARIANS = ['Dr. Tabitha Pounce', 'Dr. Felix Whiskerton', 'Dr. Clementine Clawson', 'Dr. Jasper Purrlow']

# Approved scenario distribution (primary counts) — unchanged.
PRIMARY = {'unit_price_mismatch': 20, 'line_arithmetic': 15, 'subtotal_arithmetic': 10,
           'discount_arithmetic': 10, 'tax_arithmetic': 10, 'quantity_documentation_conflict': 25,
           'duplicate_service': 30, 'declined_service_billed': 30, 'code_description_conflict': 20,
           'unsupported_billed_service': 30}
REVIEW = {'unknown_code': 10, 'ambiguous_documentation': 20, 'insufficient_documentation': 20}
MULTIPLICITY = {1: 25, 2: 100, 3: 60, 4: 15}
OUTCOMES = {'no_discrepancy': 50, 'discrepancy_identified': 200, 'staff_review_required': 50}

# Internal test-reporting provenance. Discount findings are "combined": the arithmetic
# is deterministic, but authorization comes only from the documentary evidence.
ORIGINS = {'unit_price_mismatch': 'deterministic', 'line_arithmetic': 'deterministic',
           'subtotal_arithmetic': 'deterministic', 'tax_arithmetic': 'deterministic',
           'discount_arithmetic': 'combined', 'code_description_conflict': 'combined',
           'unknown_code': 'combined', 'quantity_documentation_conflict': 'ai',
           'duplicate_service': 'ai', 'declined_service_billed': 'ai',
           'unsupported_billed_service': 'ai', 'ambiguous_documentation': 'ai',
           'insufficient_documentation': 'ai'}
RULES = {'line_arithmetic': 'B-04', 'subtotal_arithmetic': 'B-05', 'tax_arithmetic': 'B-03/B-08',
         'quantity_documentation_conflict': 'B-11', 'duplicate_service': 'B-09',
         'declined_service_billed': 'B-11', 'unsupported_billed_service': 'B-11',
         'code_description_conflict': 'B-12', 'unknown_code': 'B-12',
         'ambiguous_documentation': 'B-13', 'insufficient_documentation': 'B-13'}
# unit_price_mismatch -> B-01 (service) or B-02 (product); discount_arithmetic -> B-06 or B-07.

# Varied fault magnitudes, so no error type has a single signature amount.
PRICE_DELTAS = [-8, -5, 3, 5, 9, 12, 15]
LINE_DELTAS = [-10, -5, 2, 7, 10, 15]
SUBTOTAL_DELTAS = [-12, -6, 4, 11, 18, 25]
TAX_DELTAS = ['3.00', '1.50', '-1.00', '2.25']
WRONG_DISCOUNT = {'courtesy': ['0.00', '5.00', '15.00', '20.00'], 'senior': ['0.00', '10.00', '4.50', '18.00']}

# Visit-note phrasing. The same phrase families appear on invoices with and without
# findings; whether a sentence is a finding depends on the billed lines.
OPENERS = ['Appointment for {v}; care discussed with client.', '{V} visit completed; clinician provided guidance.',
           'Clinical assessment focused on {v}.', 'Patient evaluated for {v}; findings reviewed.',
           'Visit for {v}; treatment discussed.', 'Seen today for {v}; owner questions answered.',
           'Presented for {v}; plan reviewed with the client.']
COUNT_ONE = ['Only one {d} was performed.', 'Clinician completed a single {d} during this encounter.',
             'The chart records one {d} for this visit.', '{D} was performed once during the appointment.',
             'The record describes one occurrence of {d}.', 'No repeat of the {d} was documented.']
COMPLETED = ['{D} was completed without complications.', 'The {d} went smoothly.',
             '{D} was completed and the results were reviewed.']
PRODUCT_ONE = ['One package of {d} was dispensed.', 'Home-care instructions were given with the {d}.']
MULTI_SERVICE = ['{D} was performed twice during the visit.', 'A second {d} was required and completed.',
                 'The chart records two {d} treatments for this visit.']
MULTI_PRODUCT = ['Two packages of {d} were dispensed for home care.', 'Two units of {d} were dispensed.']
DECLINED = ['The client declined the proposed {d}.', '{D} was discussed and declined before treatment.',
            'Consent was not given for {d}; it was not performed.', 'The owner opted not to proceed with {d}.']
UNSUPPORTED = ['The {d} entry was canceled before care.', 'Clinician removed {d} from the treatment plan.',
               'Treatment log marks {d} as not administered.', '{D} was ordered but not performed.']
AMBIGUOUS = ['{D} was considered; final completion status is unclear.',
             'The chart references {d} in planning but does not confirm the outcome.',
             'There is a verbal handoff about {d} without a completed-treatment entry.']
INSUFFICIENT = ['The record for {d} is awaiting clinician sign-off.', 'The clinical attachment for {d} is pending.',
                'Notes about {d} have not been finalized.']
FUTURE_UNCLEAR = ['Whether {d} will be needed later is unclear.',
                  'The timing of a future {d} is unclear and will be revisited.']
GENERIC_PENDING = ['Scheduling of the next recheck is still pending.', 'The recheck reminder is pending for next month.']
DOSING = ['Give the medication once daily with food.', 'Apply the treatment once daily for ten days.']
COURTESY_AUTH = ['A $10 courtesy discount was authorized at checkout.', 'Front desk approved the ten-dollar courtesy reduction.',
                 'The client was granted the $10 courtesy discount.', 'A $10 courtesy reduction was approved by the front desk.',
                 'The technician confirmed the ten-dollar courtesy discount.', 'Client received approval for a $10 discount.']
SENIOR_AUTH = ['The senior wellness discount was approved for this visit.',
               'Front desk authorized the 10% senior exam discount.',
               'The senior discount on the wellness exam was approved at checkout.']
NO_DISCOUNT = ['Client asked about a courtesy discount; none was approved.', 'No discount was requested or applied.']


class Line:
    """One invoice line. Printed values may be intentionally wrong; correct_* hold the truth."""

    def __init__(self, entry, quantity=1, is_exam=False):
        self.section = entry['section']
        self.code = self.original_code = entry['code']
        self.description = entry['description']
        self.unit_price = money(entry['standard_unit_price'])
        self.quantity = self.correct_qty = quantity
        self.amount = self.unit_price * quantity
        self.billable = True        # False when the charge should be removed
        self.is_exam = is_exam
        self.locked = False         # already used by a finding or a legitimate repeat
        self.confirmable = True     # a confirming note sentence would be truthful and unambiguous


def holidays(year):
    """Selected observed US holiday closures (federal list)."""
    def observed(d):
        return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d

    def weekdays(month, weekday):
        return [date(year, month, k) for k in range(1, calendar.monthrange(year, month)[1] + 1)
                if date(year, month, k).weekday() == weekday]
    fixed = {observed(date(year, m, d)) for m, d in [(1, 1), (6, 19), (7, 4), (11, 11), (12, 25)]}
    floating = {weekdays(1, 0)[2], weekdays(2, 0)[2], weekdays(5, 0)[-1], weekdays(9, 0)[0],
                weekdays(10, 0)[1], weekdays(11, 3)[3], observed(date(year + 1, 1, 1))}
    return fixed | floating


def wrap_note(text):
    return textwrap.wrap(text, width=NOTE_WIDTH, break_long_words=False, break_on_hyphens=False)


def note_fits(sentences):
    text = ' '.join(sentences)
    lines = wrap_note(text)
    return len(lines) <= NOTE_LINES and len(' '.join(lines)) == len(text)


def phrase(R, pool, description):
    return R.choice(pool).format(d=description.lower(), D=description)


class Context:
    def __init__(self):
        self.clients = read(DATA / 'clients.csv')
        self.patients = read(DATA / 'patients.csv')
        self.catalog = read(DATA / 'service_catalog.csv')
        self.lookup = {x['code']: x for x in self.catalog}
        self.services = [x['code'] for x in self.catalog if x['section'] == 'service']
        self.descriptions = {x['description'] for x in self.catalog}
        block = set().union(*(holidays(y) for y in range(2022, 2026)))
        span = (date(2025, 12, 31) - date(2022, 1, 1)).days + 1
        self.dates = [d for d in (date(2022, 1, 1) + timedelta(days=k) for k in range(span))
                      if d.weekday() < 5 and d not in block]


def read(path):
    with path.open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def assign_cases(R):
    """Approved outcome, primary-scenario and multiplicity assignment."""
    primaries = [t for t, n in PRIMARY.items() for _ in range(n)]
    counts = [k for k, n in MULTIPLICITY.items() for _ in range(n)]
    R.shuffle(counts)
    R.shuffle(primaries)
    cases = [('no_discrepancy', 0)] * OUTCOMES['no_discrepancy'] + list(zip(primaries, counts))
    cases += [(t, 1) for t, n in REVIEW.items() for _ in range(n)]
    R.shuffle(cases)
    return cases


def build_attempt(R, ctx, visit_type, age, types):
    """Build lines, notes and findings once. Returns None if capacity or note space runs out."""
    lookup = ctx.lookup
    exam_code, pool, product_pool = ARCHETYPES[visit_type]
    lines = [Line(lookup[exam_code], is_exam=True)]
    for code in R.sample([c for c in pool if c != exam_code], R.randint(1, 2)):
        lines.append(Line(lookup[code]))
    if R.random() < .5:
        lines.append(Line(lookup[R.choice(product_pool)]))

    senior_ok = visit_type == 'Senior wellness' and age >= SENIOR_AGE
    if 'discount_arithmetic' in types:
        discount_type = 'senior' if senior_ok else 'courtesy'
    elif senior_ok and R.random() < .5:
        discount_type = 'senior'
    elif R.random() < .12:
        discount_type = 'courtesy'
    else:
        discount_type = 'none'
    if discount_type == 'senior':
        lines[0].locked = True      # the EX-105 exam is the B-07 basis; keep it intact

    required, mentioned, findings = [], set(), []
    auth_sentence = ''
    if discount_type == 'courtesy':
        auth_sentence = R.choice(COURTESY_AUTH)
    elif discount_type == 'senior':
        auth_sentence = R.choice(SENIOR_AUTH)
    if auth_sentence:
        required.append(auth_sentence)

    def count(section):
        return sum(x.section == section for x in lines)

    def in_use(code):
        return any(x.original_code == code or x.code == code for x in lines)

    def reserve(allow_exam, section='service'):
        available = [x for x in lines if x.section == section and not x.locked and (allow_exam or not x.is_exam)]
        if not available:
            if section != 'service' or count('service') >= MAX_SERVICES:
                return None
            printed = {x.description for x in lines} | mentioned
            options = [c for c in pool + GENERAL_SERVICES
                       if c != exam_code and not in_use(c) and lookup[c]['description'] not in printed]
            if not options:
                return None
            lines.append(Line(lookup[R.choice(sorted(set(options)))]))
            available = [lines[-1]]
        chosen = R.choice(available)
        chosen.locked = True
        return chosen

    summary_faults = {}
    for kind in types:
        target, extra, note = None, None, ''
        if kind == 'unit_price_mismatch':
            products = [x for x in lines if x.section == 'product' and not x.locked]
            if products and R.random() < .3:
                target = R.choice(products)
                target.locked = True
            else:
                target = reserve(allow_exam=True)
            if target is None:
                return None
            target.unit_price += money(R.choice(PRICE_DELTAS))
            target.amount = target.unit_price * target.quantity
        elif kind == 'line_arithmetic':
            target = reserve(allow_exam=True)
            if target is None:
                return None
            target.amount += money(R.choice(LINE_DELTAS))
        elif kind == 'quantity_documentation_conflict':
            target = reserve(allow_exam=False)
            if target is None:
                return None
            target.quantity = R.choice([2, 2, 3])
            target.amount = target.unit_price * target.quantity
            target.confirmable = False
            note = phrase(R, COUNT_ONE, target.description)
        elif kind == 'code_description_conflict':
            target = reserve(allow_exam=discount_type != 'senior')
            if target is None:
                return None
            taken = {x.description for x in lines} | {lookup[x.original_code]['description'] for x in lines} | mentioned
            alternates = [c for c in ctx.services
                          if c not in (target.code, 'DEN-402') and lookup[c]['description'] not in taken]
            target.description = lookup[R.choice(alternates)]['description']
            target.confirmable = False
            mentioned.add(target.description)
        elif kind == 'duplicate_service':
            if count('service') >= MAX_SERVICES:
                return None
            target = reserve(allow_exam=False)
            if target is None or count('service') >= MAX_SERVICES:
                return None
            extra = Line(lookup[target.code])
            extra.locked, extra.billable, extra.confirmable = True, False, False
            lines.append(extra)
            target.confirmable = False
            note = phrase(R, COUNT_ONE, target.description)
        elif kind in ('declined_service_billed', 'unsupported_billed_service'):
            target = reserve(allow_exam=False)
            if target is None:
                return None
            target.billable = target.confirmable = False
            note = phrase(R, DECLINED if kind == 'declined_service_billed' else UNSUPPORTED, target.description)
        elif kind == 'unknown_code':
            target = reserve(allow_exam=discount_type != 'senior')
            if target is None:
                return None
            target.code = R.choice(UNKNOWN_CODES)
            target.confirmable = False
        elif kind in ('ambiguous_documentation', 'insufficient_documentation'):
            target = reserve(allow_exam=False)
            if target is None:
                return None
            target.confirmable = False
            note = phrase(R, AMBIGUOUS if kind == 'ambiguous_documentation' else INSUFFICIENT, target.description)
        elif kind == 'tax_arithmetic':
            if count('product') == 0:
                lines.append(Line(lookup[R.choice(product_pool)]))
            summary_faults[kind] = R.choice(['omitted', 'rate', 'services', 'delta', 'delta'])
        elif kind == 'subtotal_arithmetic':
            summary_faults[kind] = money(R.choice(SUBTOTAL_DELTAS))
        elif kind == 'discount_arithmetic':
            summary_faults[kind] = money(R.choice(WRONG_DISCOUNT[discount_type]))
            note = auth_sentence
        else:
            raise ValueError(kind)
        if note and note not in required:
            required.append(note)
        if target is not None:
            mentioned.add(target.description)
            mentioned.add(lookup[target.original_code]['description'])
        findings.append(dict(kind=kind, target=target, extra=extra, note=note))

    # Legitimate repeats (quantity 2 or a repeated code), documented as such.
    if R.random() < .2:
        code = R.choice(REPEATABLE)
        existing = [x for x in lines if x.original_code == code]
        description = lookup[code]['description']
        if description not in mentioned:
            if existing and not existing[0].locked and not existing[0].is_exam and len(existing) == 1:
                line = existing[0]
                line.quantity = line.correct_qty = 2
                line.amount = line.unit_price * 2
                line.locked, line.confirmable = True, False
                required.append(phrase(R, MULTI_SERVICE, description))
                mentioned.add(description)
            elif not existing:
                as_two_lines = R.random() < .6
                if count('service') + (2 if as_two_lines else 1) <= MAX_SERVICES:
                    new = [Line(lookup[code]) for _ in range(2)] if as_two_lines else [Line(lookup[code], quantity=2)]
                    for line in new:
                        line.locked, line.confirmable = True, False
                    lines.extend(new)
                    required.append(phrase(R, MULTI_SERVICE, description))
                    mentioned.add(description)
    products = [x for x in lines if x.section == 'product' and not x.locked]
    if products and R.random() < .15:
        line = products[0]
        line.quantity = line.correct_qty = 2
        line.amount = line.unit_price * 2
        line.locked, line.confirmable = True, False
        required.append(phrase(R, MULTI_PRODUCT, line.description))
        mentioned.add(line.description)

    if count('service') > MAX_SERVICES or count('product') > MAX_PRODUCTS:
        return None

    # Optional sentences: truthful confirmations and distractors that reuse the same
    # vocabulary as findings without changing the expected answer.
    optional = []
    for line in lines:
        if line.confirmable and line.billable and line.quantity == 1 and line.code in lookup \
                and line.description == lookup[line.code]['description'] \
                and sum(x.description == line.description for x in lines) == 1 and R.random() < .6:
            pool_ = PRODUCT_ONE if line.section == 'product' else COUNT_ONE + COMPLETED
            optional.append((line.description, phrase(R, pool_, line.description)))
    billed = {x.description for x in lines} | {lookup[x.original_code]['description'] for x in lines}
    plausible = sorted(set(pool + GENERAL_SERVICES))
    unbilled = [c for c in plausible if lookup[c]['description'] not in billed | mentioned] or \
               [c for c in ctx.services if lookup[c]['description'] not in billed | mentioned]
    if R.random() < .4:
        d = lookup[R.choice(unbilled)]['description']
        optional.append((d, phrase(R, R.choice([DECLINED, UNSUPPORTED]), d)))
    if R.random() < .3:
        if R.random() < .6:
            d = lookup[R.choice(unbilled)]['description']
            optional.append((d, phrase(R, FUTURE_UNCLEAR, d)))
        else:
            optional.append((None, R.choice(GENERIC_PENDING)))
    if any(x.section == 'product' for x in lines) and R.random() < .3:
        optional.append((None, R.choice(DOSING)))
    if discount_type == 'none' and R.random() < .1:
        optional.append((None, R.choice(NO_DISCOUNT)))

    opener = R.choice(OPENERS).format(v=visit_type.lower(), V=visit_type)
    body = list(required)
    R.shuffle(body)
    if not note_fits([opener] + body):
        return None
    R.shuffle(optional)
    used = set()
    for description, sentence in optional:
        if description is not None and description in used:
            continue
        position = R.randint(0, len(body))
        candidate = body[:position] + [sentence] + body[position:]
        if note_fits([opener] + candidate):      # checked in final order, so wrapping is exact
            body = candidate
            used.add(description)
    notes = ' '.join([opener] + body)

    # Final line order: shuffle within each section so finding lines are not always last.
    R.shuffle(lines)
    return dict(lines=lines, notes=notes, findings=findings, discount_type=discount_type,
                summary_faults=summary_faults)


def compute_totals(R, built, lookup):
    lines, faults, discount_type = built['lines'], built['summary_faults'], built['discount_type']
    services = money(sum((x.amount for x in lines if x.section == 'service'), Decimal(0)))
    products = money(sum((x.amount for x in lines if x.section == 'product'), Decimal(0)))
    subtotal = services + products + faults.get('subtotal_arithmetic', Decimal(0))
    correct_discount = {'none': Decimal('0.00'), 'courtesy': COURTESY_DISCOUNT,
                        'senior': money(Decimal(lookup['EX-105']['standard_unit_price']) * SENIOR_RATE)}[discount_type]
    discount = faults.get('discount_arithmetic', correct_discount)
    formula_tax = money(products * TAX_RATE)
    tax = formula_tax
    if 'tax_arithmetic' in faults:
        variant = faults['tax_arithmetic']
        candidates = {'omitted': Decimal('0.00'), 'rate': money(products * Decimal('0.10')),
                      'services': money((services + products) * TAX_RATE)}
        tax = candidates.get(variant)
        if tax is None or tax == formula_tax:
            tax = formula_tax + money(R.choice(TAX_DELTAS))
            while tax == formula_tax or tax < 0:
                tax = formula_tax + money(R.choice(TAX_DELTAS))
    total_due = money(subtotal - discount + tax)

    correct_s = sum((money(lookup[x.original_code]['standard_unit_price']) * x.correct_qty
                     for x in lines if x.billable and x.section == 'service'), Decimal(0))
    correct_p = sum((money(lookup[x.original_code]['standard_unit_price']) * x.correct_qty
                     for x in lines if x.billable and x.section == 'product'), Decimal(0))
    correct_due = money(correct_s + correct_p - correct_discount + money(correct_p * TAX_RATE))
    return dict(services=services, products=products, subtotal=subtotal, discount=discount,
                correct_discount=correct_discount, tax=tax, formula_tax=formula_tax,
                total_due=total_due, correct_due=correct_due)


def line_number(lines, line):
    index = next(i for i, x in enumerate(lines) if x is line)
    return str(1 + sum(x.section == line.section for x in lines[:index]))


def describe(kind, target, totals, discount_type, lookup):
    if kind == 'unit_price_mismatch':
        standard = fmt(lookup[target.code]['standard_unit_price'])
        return (f'Code {target.code} is billed at ${fmt(target.unit_price)} each; the catalog price is ${standard}.',
                'Restore the catalog unit price after staff confirmation.')
    if kind == 'line_arithmetic':
        return (f'Line amount ${fmt(target.amount)} for {target.code} does not equal '
                f'{target.quantity} x ${fmt(target.unit_price)}.', 'Recalculate this line.')
    if kind == 'quantity_documentation_conflict':
        return (f'Quantity {target.quantity} billed for {target.code}; the notes document one.',
                'Correct the quantity to one after staff confirmation.')
    if kind == 'code_description_conflict':
        return (f'Code {target.code} is printed with the description "{target.description}", '
                'which belongs to a different catalog service.', 'Confirm the intended service before editing.')
    if kind == 'duplicate_service':
        return (f'Two charges for {target.code} while the notes support one service.',
                'Remove the duplicate line after verification.')
    if kind == 'declined_service_billed':
        return (f'Billed {target.code} was declined according to the notes.',
                'Remove the declined charge after staff verification.')
    if kind == 'unsupported_billed_service':
        return (f'Billed {target.code} was not performed according to the notes.',
                'Remove the unsupported charge after staff verification.')
    if kind == 'unknown_code':
        return (f'Code {target.code} is not in the service catalog; staff must confirm the intended service.',
                'Request staff coding review.')
    if kind == 'ambiguous_documentation':
        return (f'Completion of {target.code} cannot be determined from the notes.',
                'Request clarifying clinical documentation.')
    if kind == 'insufficient_documentation':
        return (f'Documentation for {target.code} is not finalized.', 'Request finalized clinical documentation.')
    if kind == 'subtotal_arithmetic':
        expected = totals['services'] + totals['products']
        return (f'Displayed subtotal ${fmt(totals["subtotal"])} does not equal the line sum ${fmt(expected)}.',
                'Recalculate the subtotal.')
    if kind == 'tax_arithmetic':
        return (f'Displayed tax ${fmt(totals["tax"])} does not equal 8% of products ${fmt(totals["formula_tax"])}.',
                'Recalculate product tax.')
    if kind == 'discount_arithmetic':
        label = 'senior wellness' if discount_type == 'senior' else 'courtesy'
        return (f'The documented {label} discount is ${fmt(totals["correct_discount"])}; '
                f'the invoice shows ${fmt(totals["discount"])}.', 'Apply the authorized discount amount.')
    raise ValueError(kind)


def rule_for(kind, target, discount_type):
    if kind == 'unit_price_mismatch':
        return 'B-02' if target.section == 'product' else 'B-01'
    if kind == 'discount_arithmetic':
        return 'B-07' if discount_type == 'senior' else 'B-06'
    return RULES[kind]


def build(ctx):
    R = random.Random(SEED)
    cases = assign_cases(R)
    visits, items, totals_rows, reviews, findings = [], [], [], [], []
    for i, (pet, (primary, nfind)) in enumerate(zip(ctx.patients, cases), 1):
        # Header fields are drawn before, and independently of, the scenario content.
        day = R.choice(ctx.dates)
        invoice = f'PO-{day.year}-{i:04d}'
        age = int(pet['age_years'])
        eligible = [t for t in ARCHETYPES if t != 'Senior wellness' or age >= SENIOR_AGE]
        visit_type = R.choices(eligible, [2 if t == 'Senior wellness' else 1 for t in eligible])[0]
        veterinarian = R.choice(VETERINARIANS)
        types = []
        if nfind:
            types = [primary]
            if primary in PRIMARY:
                others = [t for t in PRIMARY if t != primary]
                R.shuffle(others)
                types += others[:nfind - 1]
        for _ in range(500):
            built = build_attempt(R, ctx, visit_type, age, types)
            if built is not None:
                break
        else:
            raise RuntimeError(f'{invoice}: could not fit findings within invoice capacity')
        lines = built['lines']
        totals = compute_totals(R, built, ctx.lookup)
        outcome = ('no_discrepancy' if primary == 'no_discrepancy' else
                   'staff_review_required' if primary in REVIEW else 'discrepancy_identified')
        for seq, f in enumerate(built['findings'], 1):
            kind, target, extra = f['kind'], f['target'], f['extra']
            evidence, action = describe(kind, target, totals, built['discount_type'], ctx.lookup)
            findings.append(dict(
                invoice_no=invoice, finding_number=seq, finding_type=kind,
                affected_code=target.code if target else '',
                rule_reference=rule_for(kind, target, built['discount_type']),
                evidence=evidence, expected_action=action, origin=ORIGINS[kind],
                requires_human_authorization='yes',
                affected_section=target.section if target else 'summary',
                affected_line=line_number(lines, target) if target else '',
                secondary_line=line_number(lines, extra) if extra else '',
                note_evidence=f['note']))
        for section in ('service', 'product'):
            for n, x in enumerate((x for x in lines if x.section == section), 1):
                items.append(dict(invoice_no=invoice, section=section, line_number=n, code=x.code,
                                  description=x.description, quantity=x.quantity,
                                  unit_price=fmt(x.unit_price), amount=fmt(x.amount)))
        determinable = outcome != 'staff_review_required' and 'code_description_conflict' not in types
        visits.append(dict(invoice_no=invoice, visit_id=f'VIS-{i:05d}', patient_id=pet['patient_id'],
                           client_id=pet['client_id'], visit_date=day.isoformat(), issue_date=day.isoformat(),
                           visit_type=visit_type, veterinarian=veterinarian, visit_notes=built['notes'],
                           discount_type=built['discount_type']))
        totals_rows.append(dict(invoice_no=invoice, services_total=fmt(totals['services']),
                                products_total=fmt(totals['products']), subtotal=fmt(totals['subtotal']),
                                discount=fmt(totals['discount']), tax=fmt(totals['tax']),
                                total_due=fmt(totals['total_due'])))
        reviews.append(dict(invoice_no=invoice, expected_outcome=outcome, primary_scenario=primary,
                            finding_count=len(built['findings']), scenario_types='|'.join(types),
                            expected_total_due=fmt(totals['correct_due']) if determinable else '',
                            expected_explanation='; '.join(x['evidence'] for x in findings if x['invoice_no'] == invoice)
                            or 'All reviewed amounts and documented services agree.',
                            requires_human_authorization='yes'))
    return visits, items, totals_rows, reviews, findings


def self_check(ctx, visits, items, reviews, findings):
    """Fail before writing if any approved distribution is not met."""
    problems = []
    outcomes = Counter(x['expected_outcome'] for x in reviews)
    if outcomes != Counter(OUTCOMES):
        problems.append(f'outcomes {dict(outcomes)}')
    multiplicity = Counter(x['finding_count'] for x in reviews if x['expected_outcome'] == 'discrepancy_identified')
    if multiplicity != Counter(MULTIPLICITY):
        problems.append(f'multiplicity {dict(multiplicity)}')
    primaries = Counter(x['primary_scenario'] for x in reviews)
    if primaries != Counter({'no_discrepancy': 50, **PRIMARY, **REVIEW}):
        problems.append(f'primary scenarios {dict(primaries)}')
    confirmed = sum(int(x['finding_count']) for x in reviews if x['expected_outcome'] == 'discrepancy_identified')
    review = sum(int(x['finding_count']) for x in reviews if x['expected_outcome'] == 'staff_review_required')
    if (confirmed, review, len(findings)) != (465, 50, 515):
        problems.append(f'finding totals confirmed={confirmed} review={review} rows={len(findings)}')
    if len(visits) != 300 or len({x['visit_type'] for x in visits}) != 10:
        problems.append('invoice count or visit archetypes')
    for v in visits:
        if not note_fits([v['visit_notes']]):
            problems.append(f'{v["invoice_no"]}: notes exceed {NOTE_LINES} lines')
    if problems:
        raise RuntimeError('Generation self-check failed; nothing written:\n  ' + '\n  '.join(problems))


def write_csv(path, rows, columns):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--public-dir', type=Path, default=DATA, help='where public CSVs and the summary are written')
    parser.add_argument('--private-dir', type=Path,
                        default=Path(os.environ.get('PAWS_PRIVATE_DATA_DIR', str(DEFAULT_PRIVATE))),
                        help='where the private answer key is written (must be outside the repository)')
    parser.add_argument('--overwrite-private', action='store_true', help='replace existing private answer files')
    args = parser.parse_args(argv)
    private = args.private_dir.expanduser().resolve()
    public = args.public_dir.expanduser().resolve()
    if private == ROOT or ROOT in private.parents:
        sys.exit('Refusing: private answer keys must be stored outside the project repository.')
    existing = [name for name in PRIVATE_FILES if (private / name).exists()]
    if existing and not args.overwrite_private:
        sys.exit(f'Refusing to overwrite existing private files in {private}: {", ".join(existing)}. '
                 'Use a new --private-dir or pass --overwrite-private.')

    ctx = Context()
    visits, items, totals, reviews, findings = build(ctx)
    self_check(ctx, visits, items, reviews, findings)

    write_csv(public / 'visits.csv', visits, list(visits[0]))
    write_csv(public / 'invoice_items.csv', items, list(items[0]))
    write_csv(public / 'invoice_totals.csv', totals, list(totals[0]))
    write_csv(private / 'expected_reviews.csv', reviews, list(reviews[0]))
    write_csv(private / 'expected_findings.csv', findings, list(findings[0]))
    discrepant = [x for x in reviews if x['expected_outcome'] == 'discrepancy_identified']
    summary = dict(
        seed=SEED, clients=len(ctx.clients), cats=len(ctx.patients), invoices=len(visits),
        line_items=len(items), findings=len(findings),
        confirmed_discrepancy_findings=sum(int(x['finding_count']) for x in discrepant),
        staff_review_findings=sum(int(x['finding_count']) for x in reviews
                                  if x['expected_outcome'] == 'staff_review_required'),
        outcomes=dict(sorted(Counter(x['expected_outcome'] for x in reviews).items())),
        findings_per_discrepant_invoice={str(k): v for k, v in sorted(Counter(x['finding_count'] for x in discrepant).items())},
        primary_scenarios=dict(sorted(Counter(x['primary_scenario'] for x in reviews).items())),
        visit_archetypes=dict(sorted(Counter(x['visit_type'] for x in visits).items())),
        discount_types=dict(sorted(Counter(x['discount_type'] for x in visits).items())),
        time_period=['2022-01-01', '2025-12-31'])
    (public / 'generation_summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=2))
    print(f'Public output: {public}\nPrivate output: {private}')


if __name__ == '__main__':
    main()

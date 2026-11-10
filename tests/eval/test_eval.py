"""Evaluation tools tested with SYNTHETIC fixtures only (never the real private answer key)."""
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'eval'))
import allocate  # noqa: E402
import score  # noqa: E402


def review(inv, outcome, primary, count, types=''):
    return {'invoice_no': inv, 'expected_outcome': outcome, 'primary_scenario': primary, 'finding_count': str(count),
            'scenario_types': types, 'expected_total_due': '', 'expected_explanation': '', 'requires_human_authorization': 'yes'}


def finding(inv, n, kind, rule, origin, section, line='', secondary='', note=''):
    return {'invoice_no': inv, 'finding_number': str(n), 'finding_type': kind, 'affected_code': '', 'rule_reference': rule,
            'evidence': '', 'expected_action': '', 'origin': origin, 'requires_human_authorization': 'yes',
            'affected_section': section, 'affected_line': str(line), 'secondary_line': str(secondary), 'note_evidence': note}


def pred(kind, section, line=None, rules=(), excerpt=None, secondary=None, origin='deterministic', disposition='discrepancy'):
    return {'type': kind, 'origin': origin, 'disposition': disposition, 'section': section, 'line': line, 'secondaryLine': secondary,
            'code': None, 'ruleIds': list(rules), 'noteExcerpt': excerpt}


KEY_REVIEWS = [
    review('A', 'no_discrepancy', 'no_discrepancy', 0),
    review('B', 'discrepancy_identified', 'line_arithmetic', 2, 'line_arithmetic|declined_service_billed'),
    review('C', 'discrepancy_identified', 'duplicate_service', 1, 'duplicate_service'),
    review('D', 'staff_review_required', 'insufficient_documentation', 1, 'insufficient_documentation'),
    review('E', 'discrepancy_identified', 'subtotal_arithmetic', 1, 'subtotal_arithmetic'),
    review('F', 'no_discrepancy', 'no_discrepancy', 0),
]
KEY_FINDINGS = [
    finding('B', 1, 'line_arithmetic', 'B-04', 'deterministic', 'service', 1),
    finding('B', 2, 'declined_service_billed', 'B-11', 'ai', 'service', 2, note='The owner declined the nail trim.'),
    finding('C', 1, 'duplicate_service', 'B-09', 'ai', 'service', 3, 5, note='No repeat of the ear cleaning was documented.'),
    finding('D', 1, 'insufficient_documentation', 'B-13', 'ai', 'service', 1, note='The record is awaiting sign-off.'),
    finding('E', 1, 'subtotal_arithmetic', 'B-05', 'deterministic', 'summary'),
]
PREDICTIONS = {'meta': {'mode': 'replay', 'requests': 0, 'totalTokens': 1234}, 'predictions': [
    {'invoiceNo': 'A', 'status': 'ok', 'outcome': 'no_discrepancy', 'findings': [], 'aiOnly': {'outcome': 'no_discrepancy', 'findings': []}, 'rejected': 0},
    {'invoiceNo': 'B', 'status': 'ok', 'outcome': 'discrepancy_identified', 'rejected': 1,
     'findings': [pred('line_arithmetic', 'service', 1, ['B-04']),
                  pred('declined_service_billed', 'service', 2, ['B-11'], 'owner declined the nail trim', origin='ai')],
     'aiOnly': {'outcome': 'discrepancy_identified', 'findings': [pred('declined_service_billed', 'service', 2, ['B-11'], 'x', origin='ai')]}},
    # Duplicate reported on the other line of the pair: still the same finding.
    {'invoiceNo': 'C', 'status': 'ok', 'outcome': 'discrepancy_identified', 'rejected': 0,
     'findings': [pred('duplicate_service', 'service', 5, ['B-09'], 'No repeat of the ear cleaning was documented.', secondary=3, origin='ai')],
     'aiOnly': {'outcome': 'discrepancy_identified', 'findings': []}},
    # Staff review missed: predicted a discrepancy with a wrong rule on an unsupported line.
    {'invoiceNo': 'D', 'status': 'ok', 'outcome': 'discrepancy_identified', 'rejected': 0,
     'findings': [pred('unit_price_mismatch', 'service', 2, ['B-01'])], 'aiOnly': None},
    {'invoiceNo': 'E', 'status': 'failed', 'reason': 'timeout', 'outcome': None, 'findings': [], 'aiOnly': None, 'rejected': 0},
    # False positive on a clean invoice, with the wrong rule.
    {'invoiceNo': 'F', 'status': 'ok', 'outcome': 'discrepancy_identified', 'rejected': 0,
     'findings': [pred('tax_arithmetic', 'summary', None, ['B-03'])], 'aiOnly': {'outcome': 'no_discrepancy', 'findings': []}},
]}
SPLIT = ['A', 'B', 'C', 'D', 'E', 'F']


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.m = score.score(PREDICTIONS, KEY_REVIEWS, KEY_FINDINGS, SPLIT)

    def test_outcome_accuracy_and_confusion(self):
        self.assertEqual(self.m['outcome']['accuracy'], round(3 / 6, 4))  # A, B, C correct
        self.assertEqual(self.m['outcome']['confusion']['staff_review_required'], {'discrepancy_identified': 1})
        self.assertEqual(self.m['outcome']['confusion']['discrepancy_identified'].get('failed'), 1)
        self.assertEqual(self.m['failed'], 1)

    def test_finding_counts_precision_recall(self):
        f = self.m['findings']
        self.assertEqual((f['true_positive'], f['false_positive'], f['false_negative']), (3, 2, 2))
        self.assertEqual(f['precision'], 0.6)
        self.assertEqual(f['recall'], 0.6)

    def test_duplicate_matches_either_line_of_the_pair(self):
        self.assertEqual(self.m['by_type']['duplicate_service']['found'], 1)

    def test_rule_and_evidence_accuracy(self):
        self.assertEqual(self.m['rule_reference_accuracy'], 1.0)
        self.assertEqual(self.m['evidence_support_rate'], 1.0)  # both matched note findings quote the evidence

    def test_staff_review_and_clean_false_positives(self):
        self.assertEqual(self.m['staff_review']['recall'], 0.0)
        self.assertEqual(self.m['clean_invoices'], {'false_positive_findings': 1, 'invoices_with_false_positives': 1})

    def test_complete_cases_by_finding_count(self):
        c = self.m['complete_case_rate_by_finding_count']
        self.assertEqual(c['0'], {'invoices': 2, 'complete': 1, 'rate': 0.5})
        self.assertEqual(c['2'], {'invoices': 1, 'complete': 1, 'rate': 1.0})

    def test_errors_list_missed_and_unsupported(self):
        kinds = Counter(e['error'] for e in self.m['errors'])
        self.assertEqual(kinds, {'missed': 2, 'unsupported': 2})

    def test_ai_only_view_scores_model_findings_alone(self):
        m = score.score(PREDICTIONS, KEY_REVIEWS, KEY_FINDINGS, SPLIT, view='ai_only')
        self.assertEqual(m['failed'], 2)  # D has no AI-only result, E failed
        self.assertEqual(m['findings']['true_positive'], 1)
        self.assertEqual(m['evidence_support_rate'], 0.0)  # excerpt "x" does not support the expected evidence

    def test_report_is_written_without_per_invoice_labels(self):
        md = score.report_markdown({k: v for k, v in self.m.items() if k != 'errors'}, {'split': 'development'})
        self.assertIn('Outcome classification', md)
        self.assertNotIn('expected_explanation', md)

    def test_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = ['--predictions', 'p', '--manifest', 'm', '--split', 'blind', '--out-dir', tmp]
            self.assertEqual(score.main(args), 2)                       # no --authorized
            self.assertEqual(score.main(['--authorized', *args]), 2)    # blind without --confirm-blind
            inside = ['--authorized', '--predictions', 'p', '--manifest', 'm', '--split', 'development', '--out-dir', str(ROOT / 'tmp')]
            self.assertEqual(score.main(inside), 2)                     # results inside the repository


class AllocateTests(unittest.TestCase):
    def fixture(self):
        invoices = [f'I{n:03d}' for n in range(40)]
        scenarios = ['no_discrepancy', 'line_arithmetic', 'duplicate_service', 'insufficient_documentation']
        reviews = {}
        for n, inv in enumerate(invoices):
            primary = scenarios[n % 4]
            outcome = {'no_discrepancy': 'no_discrepancy', 'insufficient_documentation': 'staff_review_required'}.get(primary, 'discrepancy_identified')
            reviews[inv] = review(inv, outcome, primary, 0 if primary == 'no_discrepancy' else 1 + n % 3, primary if primary != 'no_discrepancy' else '')
        return invoices, invoices[:4], reviews

    def test_sizes_disjoint_and_complete(self):
        invoices, visitor, reviews = self.fixture()
        split = allocate.allocate(invoices, visitor, reviews, 20, 16)
        self.assertEqual((len(split['visitor']), len(split['blind']), len(split['development'])), (4, 20, 16))
        all_ids = split['visitor'] + split['blind'] + split['development']
        self.assertEqual(sorted(all_ids), sorted(invoices))
        self.assertFalse(set(split['blind']) & set(split['development']))
        self.assertFalse(set(split['visitor']) & (set(split['blind']) | set(split['development'])))

    def test_stratified_and_deterministic(self):
        invoices, visitor, reviews = self.fixture()
        a = allocate.allocate(invoices, visitor, reviews, 20, 16)
        self.assertEqual(a, allocate.allocate(invoices, visitor, reviews, 20, 16))
        for name in ('blind', 'development'):
            primaries = {reviews[i]['primary_scenario'] for i in a[name]}
            self.assertEqual(len(primaries), 4, name)

    def test_wrong_total_is_refused(self):
        invoices, visitor, reviews = self.fixture()
        with self.assertRaises(ValueError):
            allocate.allocate(invoices, visitor, reviews, 150, 120)

    def test_refuses_without_authorization(self):
        self.assertEqual(allocate.main([]), 2)


if __name__ == '__main__':
    unittest.main()

"""Score evaluation predictions against the private answer key (Milestone 5).

READS THE PRIVATE ANSWER KEY. Run only with the owner's authorization (--authorized). Scoring
the blind set additionally needs --confirm-blind, so blind results are produced deliberately and
never during development. Results (metrics.json, report.md, errors.csv) are written outside the
repository.

Metrics (docs/06-test-and-evaluation-plan.md)
  - outcome classification: accuracy, confusion matrix, per-class precision/recall
  - findings: precision, recall, F1 overall, per finding type and per expected origin
  - billing-rule references: exact rule-set agreement on matched findings
  - evidence: matched note-based findings whose excerpt agrees with the expected note evidence
  - staff-review handling, false positives on clean invoices, whole-case matches by finding count
  - stratified results per primary scenario; failures, rejected model claims, requests and tokens

Usage:
  python scripts/eval/score.py --authorized --predictions P.json --manifest allocation.json \
      --split development --out-dir ../paws-and-order-evaluation-results/dev-01 [--view integrated|ai_only]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PRIVATE = ROOT.parent / 'paws-and-order-evaluation-private-m3'
SCORER_VERSION = '1.0.0'
OUTCOMES = ['no_discrepancy', 'discrepancy_identified', 'staff_review_required']


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def norm(text: str | None) -> str:
    return re.sub(r'\s+', ' ', (text or '').lower()).strip().strip('"\'').rstrip('.')


def ratio(a: int, b: int) -> float | None:
    return round(a / b, 4) if b else None


def lines_of(section: str, line, secondary) -> set:
    return {(section, str(x)) for x in (line, secondary) if x not in (None, '')}


def matches(expected: dict, predicted: dict) -> bool:
    if expected['finding_type'] != predicted['type']:
        return False
    section = expected['affected_section']
    if section == 'summary':
        return predicted['section'] == 'summary'
    if predicted['section'] != section:
        return False
    if expected['finding_type'] == 'duplicate_service':
        # Either line of the duplicated pair identifies the same finding.
        return bool(lines_of(section, expected['affected_line'], expected['secondary_line'])
                    & lines_of(section, predicted.get('line'), predicted.get('secondaryLine')))
    return str(predicted.get('line')) == expected['affected_line']


def score(predictions: dict, key_reviews: list[dict], key_findings: list[dict], split_ids: list[str], view: str = 'integrated') -> dict:
    reviews = {r['invoice_no']: r for r in key_reviews if r['invoice_no'] in set(split_ids)}
    expected_by = defaultdict(list)
    for f in key_findings:
        if f['invoice_no'] in reviews:
            expected_by[f['invoice_no']].append(f)
    preds = {p['invoiceNo']: p for p in predictions['predictions']}

    confusion = {e: Counter() for e in OUTCOMES}
    tp = fp = fn = 0
    by_type = defaultdict(Counter)
    by_origin = defaultdict(Counter)
    rule_ok = rule_n = evidence_ok = evidence_n = 0
    clean_fp_findings = clean_fp_invoices = 0
    full = defaultdict(Counter)
    per_scenario = defaultdict(Counter)
    errors = []
    failed = 0

    for inv in split_ids:
        review = reviews[inv]
        expected = expected_by[inv]
        pred = preds.get(inv)
        ok = pred is not None and pred.get('status') == 'ok'
        if view == 'ai_only' and ok and pred.get('aiOnly') is None:
            ok = False
        if not ok:
            failed += 1
        source = (pred.get('aiOnly') if view == 'ai_only' else pred) if ok else None
        predicted_outcome = source['outcome'] if source else 'failed'
        predicted = list(source['findings']) if source else []
        confusion[review['expected_outcome']][predicted_outcome] += 1
        per_scenario[review['primary_scenario']]['invoices'] += 1
        per_scenario[review['primary_scenario']]['outcome_correct'] += predicted_outcome == review['expected_outcome']

        unmatched = list(predicted)
        invoice_fn = 0
        for e in expected:
            hit = next((p for p in unmatched if matches(e, p)), None)
            by_type[e['finding_type']]['expected'] += 1
            by_origin[e['origin']]['expected'] += 1
            per_scenario[review['primary_scenario']]['expected_findings'] += 1
            if hit is None:
                fn += 1
                invoice_fn += 1
                errors.append({'invoice_no': inv, 'error': 'missed', 'finding_type': e['finding_type'],
                               'section': e['affected_section'], 'line': e['affected_line']})
                continue
            unmatched.remove(hit)
            tp += 1
            by_type[e['finding_type']]['found'] += 1
            by_origin[e['origin']]['found'] += 1
            per_scenario[review['primary_scenario']]['found_findings'] += 1
            rule_n += 1
            rule_ok += set(hit.get('ruleIds') or []) == set(e['rule_reference'].split('/'))
            if e['note_evidence']:
                evidence_n += 1
                a, b = norm(hit.get('noteExcerpt')), norm(e['note_evidence'])
                evidence_ok += bool(a) and (a in b or b in a)
        for p in unmatched:
            fp += 1
            by_type[p['type']]['false_positive'] += 1
            errors.append({'invoice_no': inv, 'error': 'unsupported', 'finding_type': p['type'],
                           'section': p['section'], 'line': '' if p.get('line') is None else str(p['line'])})
        if review['expected_outcome'] == 'no_discrepancy':
            clean_fp_findings += len(unmatched)
            clean_fp_invoices += bool(unmatched)
        count = review['finding_count']
        full[count]['invoices'] += 1
        full[count]['complete'] += ok and invoice_fn == 0 and not unmatched

    total = len(split_ids)
    correct = sum(confusion[e][e] for e in OUTCOMES)
    per_class = {}
    for o in OUTCOMES:
        predicted_o = sum(confusion[e][o] for e in OUTCOMES)
        per_class[o] = {'precision': ratio(confusion[o][o], predicted_o), 'recall': ratio(confusion[o][o], sum(confusion[o].values()))}
    precision, recall = ratio(tp, tp + fp), ratio(tp, tp + fn)
    f1 = round(2 * precision * recall / (precision + recall), 4) if precision and recall else None
    staff_total = sum(confusion['staff_review_required'].values())
    non_staff_flagged = sum(confusion[e]['staff_review_required'] for e in OUTCOMES if e != 'staff_review_required')
    return {
        'view': view,
        'invoices': total,
        'failed': failed,
        'outcome': {
            'accuracy': ratio(correct, total),
            'confusion': {e: dict(confusion[e]) for e in OUTCOMES},
            'per_class': per_class,
        },
        'findings': {'true_positive': tp, 'false_positive': fp, 'false_negative': fn, 'precision': precision, 'recall': recall, 'f1': f1},
        'by_type': {t: {**c, 'recall': ratio(c['found'], c['expected'])} for t, c in sorted(by_type.items())},
        'by_expected_origin': {o: {**c, 'recall': ratio(c['found'], c['expected'])} for o, c in sorted(by_origin.items())},
        'rule_reference_accuracy': ratio(rule_ok, rule_n),
        'evidence_support_rate': ratio(evidence_ok, evidence_n),
        'staff_review': {'recall': per_class['staff_review_required']['recall'], 'expected': staff_total,
                         'unneeded_staff_reviews': non_staff_flagged},
        'clean_invoices': {'false_positive_findings': clean_fp_findings, 'invoices_with_false_positives': clean_fp_invoices},
        'complete_case_rate_by_finding_count': {k: {**c, 'rate': ratio(c['complete'], c['invoices'])} for k, c in sorted(full.items())},
        'per_primary_scenario': {s: {**c, 'outcome_accuracy': ratio(c['outcome_correct'], c['invoices']),
                                     'finding_recall': ratio(c['found_findings'], c['expected_findings'])} for s, c in sorted(per_scenario.items())},
        'model': {'requests': predictions['meta'].get('requests'), 'total_tokens': predictions['meta'].get('totalTokens'),
                  'rejected_claims': sum(p.get('rejected', 0) for p in predictions['predictions'] if p['invoiceNo'] in reviews)},
        'errors': errors,
    }


def report_markdown(metrics: dict, provenance: dict) -> str:
    o, f = metrics['outcome'], metrics['findings']
    lines = [
        f"# Evaluation report: {provenance['split']} split, {metrics['view']} view", '',
        'Synthetic test cases, not a representative sample of real veterinary invoices. Discrepancies are intentionally over-represented.', '',
        '## Provenance', '', *[f'- {k}: `{v}`' for k, v in provenance.items()], '',
        '## Outcome classification', '',
        f"Accuracy {o['accuracy']} over {metrics['invoices']} invoices ({metrics['failed']} failed).", '',
        '| Expected \\ Predicted | ' + ' | '.join(OUTCOMES + ['failed']) + ' |', '|---|' + '---|' * (len(OUTCOMES) + 1),
        *[f'| {e} | ' + ' | '.join(str(o['confusion'][e].get(p, 0)) for p in OUTCOMES + ['failed']) + ' |' for e in OUTCOMES], '',
        '## Findings', '',
        f"Precision {f['precision']}, recall {f['recall']}, F1 {f['f1']} (TP {f['true_positive']}, FP {f['false_positive']}, FN {f['false_negative']}).",
        f"Rule-reference accuracy {metrics['rule_reference_accuracy']}; evidence support rate {metrics['evidence_support_rate']}.", '',
        '| Finding type | Expected | Found | Recall | Unsupported |', '|---|---|---|---|---|',
        *[f"| {t} | {c.get('expected', 0)} | {c.get('found', 0)} | {c.get('recall')} | {c.get('false_positive', 0)} |" for t, c in metrics['by_type'].items()], '',
        '| Expected origin | Expected | Found | Recall |', '|---|---|---|---|',
        *[f"| {t} | {c.get('expected', 0)} | {c.get('found', 0)} | {c.get('recall')} |" for t, c in metrics['by_expected_origin'].items()], '',
        '## Staff review and clean invoices', '',
        f"Staff-review recall {metrics['staff_review']['recall']} ({metrics['staff_review']['expected']} expected); "
        f"unneeded staff reviews {metrics['staff_review']['unneeded_staff_reviews']}.",
        f"Clean invoices with false positives: {metrics['clean_invoices']['invoices_with_false_positives']} "
        f"({metrics['clean_invoices']['false_positive_findings']} findings).", '',
        '## Complete cases by finding count', '', '| Findings | Invoices | Complete | Rate |', '|---|---|---|---|',
        *[f"| {k} | {c['invoices']} | {c['complete']} | {c['rate']} |" for k, c in metrics['complete_case_rate_by_finding_count'].items()], '',
        '## Model usage', '', f"Requests {metrics['model']['requests']}, tokens {metrics['model']['total_tokens']}, "
        f"rejected model claims {metrics['model']['rejected_claims']}.", '',
    ]
    return '\n'.join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--authorized', action='store_true')
    parser.add_argument('--confirm-blind', action='store_true')
    parser.add_argument('--predictions', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--split', required=True, choices=['development', 'blind', 'visitor'])
    parser.add_argument('--view', default='integrated', choices=['integrated', 'ai_only'])
    parser.add_argument('--private-dir', type=Path, default=Path(os.environ.get('PAWS_PRIVATE_DATA_DIR', str(DEFAULT_PRIVATE))))
    parser.add_argument('--out-dir', type=Path, required=True)
    args = parser.parse_args(argv)
    if not args.authorized:
        print('Refusing: scoring reads the private answer key and needs the owner\'s authorization (--authorized).')
        return 2
    if args.split == 'blind' and not args.confirm_blind:
        print('Refusing: blind scoring is a final evaluation step; pass --confirm-blind deliberately.')
        return 2
    for path in (args.private_dir, args.out_dir):
        p = path.expanduser().resolve()
        if p == ROOT or ROOT in p.parents:
            print(f'Refusing: {path} must be outside the repository.')
            return 2
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    split_ids = manifest[args.split]
    predictions = json.loads(args.predictions.read_text(encoding='utf-8'))
    key_reviews = read_csv(args.private_dir / 'expected_reviews.csv')
    key_findings = read_csv(args.private_dir / 'expected_findings.csv')
    metrics = score(predictions, key_reviews, key_findings, split_ids, args.view)
    provenance = {
        'split': args.split, 'scorer_version': SCORER_VERSION, 'predictions_sha256': sha256(args.predictions),
        'manifest_sha256': sha256(args.manifest), 'answer_key_sha256': sha256(args.private_dir / 'expected_findings.csv'),
        **{k: v for k, v in predictions['meta'].items() if k in ('mode', 'model', 'engineVersion', 'datasetSha256', 'promptSha256')},
    }
    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)
    errors = metrics.pop('errors')
    (out / 'metrics.json').write_text(json.dumps({'provenance': provenance, **metrics}, indent=2) + '\n', encoding='utf-8')
    (out / 'report.md').write_text(report_markdown(metrics, provenance), encoding='utf-8')
    with (out / 'errors.csv').open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['invoice_no', 'error', 'finding_type', 'section', 'line'])
        writer.writeheader()
        writer.writerows(errors)
    print(f"Outcome accuracy {metrics['outcome']['accuracy']}; finding precision {metrics['findings']['precision']}, "
          f"recall {metrics['findings']['recall']}. Wrote {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

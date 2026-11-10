"""Freeze the Milestone 5 allocation: visitor pool (already selected) + blind + development.

Approved sizes: 30 visitor + 150 blind + 120 development = 300 invoices. The 270 invoices
outside the visitor pool are stratified by (expected outcome, primary scenario, finding count)
so both evaluation sets cover the scenario types and finding multiplicities.

READS THE PRIVATE ANSWER KEY. Run only with the owner's explicit authorization (--authorized).
Writes allocation.json (and its SHA-256) to the private directory, never the repository, and
refuses to overwrite an existing allocation: once written, the split is frozen. Prints counts
only, never per-invoice labels.

Usage:
  python scripts/eval/allocate.py --authorized --private-dir ../paws-and-order-evaluation-private-m3
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PRIVATE = ROOT.parent / 'paws-and-order-evaluation-private-m3'
SEED = 20261110


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def allocate(invoices: list[str], visitor: list[str], reviews: dict[str, dict[str, str]],
             blind_size: int, development_size: int, seed: int = SEED) -> dict[str, list[str]]:
    if len(set(visitor) - set(invoices)):
        raise ValueError('visitor pool contains unknown invoices')
    remaining = sorted(set(invoices) - set(visitor))
    if len(remaining) != blind_size + development_size:
        raise ValueError(f'{len(remaining)} non-visitor invoices, expected {blind_size} + {development_size}')
    rng = random.Random(seed)
    strata: dict[tuple, list[str]] = defaultdict(list)
    for inv in remaining:
        r = reviews[inv]
        strata[(r['expected_outcome'], r['primary_scenario'], r['finding_count'])].append(inv)
    keys = sorted(strata)
    for key in keys:
        rng.shuffle(strata[key])
    # Largest-remainder apportionment of the blind set across strata.
    share = {k: len(strata[k]) * blind_size / len(remaining) for k in keys}
    quota = {k: int(share[k]) for k in keys}
    order = sorted(keys, key=lambda k: (-(share[k] - quota[k]), rng.random()))
    for k in order[:blind_size - sum(quota.values())]:
        quota[k] += 1
    blind = sorted(inv for k in keys for inv in strata[k][:quota[k]])
    development = sorted(inv for k in keys for inv in strata[k][quota[k]:])
    return {'visitor': sorted(visitor), 'blind': blind, 'development': development}


def coverage(ids: list[str], reviews: dict[str, dict[str, str]]) -> dict[str, object]:
    types = Counter(t for i in ids for t in reviews[i]['scenario_types'].split('|') if t)
    if any(reviews[i]['expected_outcome'] == 'no_discrepancy' for i in ids):
        types['no_discrepancy'] += sum(reviews[i]['expected_outcome'] == 'no_discrepancy' for i in ids)
    return {
        'invoices': len(ids),
        'outcomes': dict(sorted(Counter(reviews[i]['expected_outcome'] for i in ids).items())),
        'finding_counts': dict(sorted(Counter(reviews[i]['finding_count'] for i in ids).items())),
        'scenario_types_present': len(types),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--authorized', action='store_true', help='confirms the owner authorized reading the private answer key')
    parser.add_argument('--private-dir', type=Path, default=Path(os.environ.get('PAWS_PRIVATE_DATA_DIR', str(DEFAULT_PRIVATE))))
    parser.add_argument('--visits', type=Path, default=ROOT / 'data' / 'visits.csv')
    parser.add_argument('--pool', type=Path, default=ROOT / 'config' / 'review-invoices.json')
    parser.add_argument('--blind', type=int, default=150)
    parser.add_argument('--development', type=int, default=120)
    parser.add_argument('--seed', type=int, default=SEED)
    args = parser.parse_args(argv)
    if not args.authorized:
        print('Refusing: this step reads the private answer key and needs the owner\'s authorization (--authorized).')
        return 2
    private = args.private_dir.expanduser().resolve()
    if private == ROOT or ROOT in private.parents:
        print('Refusing: the private directory must be outside the repository.')
        return 2
    out = private / 'allocation.json'
    if out.exists():
        print(f'Refusing: {out} already exists; the allocation is frozen.')
        return 2
    key = private / 'expected_reviews.csv'
    reviews = {r['invoice_no']: r for r in read_csv(key)}
    invoices = [v['invoice_no'] for v in read_csv(args.visits)]
    if set(invoices) != set(reviews):
        print('FAIL: the answer key does not match the public dataset.')
        return 1
    visitor = json.loads(args.pool.read_text(encoding='utf-8'))['invoices']
    split = allocate(invoices, visitor, reviews, args.blind, args.development, args.seed)
    manifest = {
        'version': 1, 'seed': args.seed, 'frozen': True,
        'sources': {'visits_sha256': sha256(args.visits), 'pool_sha256': sha256(args.pool), 'answer_key_sha256': sha256(key)},
        'sizes': {name: len(ids) for name, ids in split.items()},
        'coverage': {name: coverage(ids, reviews) for name, ids in split.items()},
        **split,
    }
    private.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (private / 'allocation.sha256').write_text(sha256(out) + '\n', encoding='utf-8')
    print(json.dumps({'sizes': manifest['sizes'], 'coverage': manifest['coverage']}, indent=2))
    print(f'Wrote frozen allocation to {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

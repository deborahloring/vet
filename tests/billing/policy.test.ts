// The engine's constants must match the approved CSVs exactly.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyRateHalfUp, parseCents, POLICY, RULE } from '../../src/billing/index.ts';
import { DATA, loadCatalog, readCsv } from '../helpers/dataset.ts';

const rules = new Map(readCsv(join(DATA, 'billing_rules.csv')).map((r) => [r['rule_id'], r]));

test('billing_rules.csv defines exactly B-01..B-13 and the engine uses the same IDs', () => {
  const expected = Array.from({ length: 13 }, (_, i) => `B-${String(i + 1).padStart(2, '0')}`);
  assert.deepEqual([...rules.keys()], expected);
  assert.deepEqual(Object.values(RULE).sort(), expected);
});

test('tax, courtesy and senior constants match billing_rules.csv', () => {
  assert.equal(Number(rules.get('B-03')!['rule_value']), POLICY.taxNumerator / POLICY.taxDenominator);
  assert.equal(parseCents(rules.get('B-06')!['rule_value']!, 'B-06'), POLICY.courtesyDiscountCents);
  const senior = rules.get('B-07')!;
  assert.match(senior['rule_value']!, new RegExp(`^${POLICY.seniorNumerator}% of the ${POLICY.seniorExamCode} standard price`));
  assert.match(senior['description']!, new RegExp(`aged ${POLICY.seniorMinimumAgeYears} or older`));
  assert.match(senior['description']!, new RegExp(POLICY.seniorVisitType));
  const exam = loadCatalog().byCode.get(POLICY.seniorExamCode)!;
  const seniorCents = applyRateHalfUp(exam.standardUnitPriceCents, POLICY.seniorNumerator, POLICY.seniorDenominator);
  assert.ok(senior['rule_value']!.includes(`(${(seniorCents / 100).toFixed(2)})`), 'B-07 printed amount matches catalog');
});

test('catalog loads 25 untaxed services and 8 taxable products in cents', () => {
  const catalog = loadCatalog();
  const entries = [...catalog.byCode.values()];
  assert.equal(entries.filter((e) => e.section === 'service' && !e.taxable).length, 25);
  assert.equal(entries.filter((e) => e.section === 'product' && e.taxable).length, 8);
  assert.ok(entries.every((e) => Number.isInteger(e.standardUnitPriceCents) && e.standardUnitPriceCents > 0));
  assert.equal(catalog.byCode.get('EX-105')!.standardUnitPriceCents, 9000);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRateHalfUp, formatCents, InvoiceInputError, parseCents } from '../../src/billing/index.ts';

test('parseCents reads two-decimal amounts exactly', () => {
  assert.equal(parseCents('0.00', 'x'), 0);
  assert.equal(parseCents('75.00', 'x'), 7500);
  assert.equal(parseCents('$1234.56', 'x'), 123456);
  assert.equal(parseCents(' 0.07 ', 'x'), 7);
  // 0.1 + 0.2 style float error is impossible: values stay integers.
  assert.equal(parseCents('0.10', 'x') + parseCents('0.20', 'x'), parseCents('0.30', 'x'));
});

test('parseCents rejects malformed or negative amounts (fail closed)', () => {
  for (const bad of ['', '12', '12.3', '12.345', '-5.00', 'abc', '1,000.00', '1e3', '12.00.00']) {
    assert.throws(() => parseCents(bad, 'field'), InvoiceInputError, bad);
  }
});

test('applyRateHalfUp rounds half up in whole cents', () => {
  assert.equal(applyRateHalfUp(1800, 8, 100), 144);   // 8% of $18.00
  assert.equal(applyRateHalfUp(1856, 8, 100), 148);   // 148.48 -> 148
  assert.equal(applyRateHalfUp(1862, 8, 100), 149);   // 148.96 -> 149
  assert.equal(applyRateHalfUp(5, 10, 100), 1);       // 0.5 -> 1 (half up)
  assert.equal(applyRateHalfUp(9000, 10, 100), 900);  // B-07 senior discount on EX-105
  assert.throws(() => applyRateHalfUp(-1, 8, 100), InvoiceInputError);
});

test('formatCents', () => {
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(123456), '$1234.56');
  assert.equal(formatCents(-500), '-$5.00');
});

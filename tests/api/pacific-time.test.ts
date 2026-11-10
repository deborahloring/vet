// Counters reset at 00:00 America/Los_Angeles, following daylight saving; never rolling 24 hours.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPacificMidnight, pacificDayKey, PACIFIC_TIME_ZONE } from '../../src/api/pacific-time.ts';

const at = (iso: string) => new Date(iso);
const next = (iso: string) => nextPacificMidnight(at(iso)).toISOString();

test('time zone is America/Los_Angeles', () => assert.equal(PACIFIC_TIME_ZONE, 'America/Los_Angeles'));

test('winter (PST, UTC-8) and summer (PDT, UTC-7) resets', () => {
  assert.equal(next('2026-01-15T12:00:00Z'), '2026-01-16T08:00:00.000Z');
  assert.equal(next('2026-07-15T12:00:00Z'), '2026-07-16T07:00:00.000Z');
});

test('spring-forward day (2026-03-08)', () => {
  assert.equal(next('2026-03-07T20:00:00Z'), '2026-03-08T08:00:00.000Z'); // noon PST Mar 7 -> midnight PST
  assert.equal(next('2026-03-08T09:00:00Z'), '2026-03-09T07:00:00.000Z'); // 01:00 PST Mar 8 -> midnight PDT
});

test('fall-back day (2026-11-01)', () => {
  assert.equal(next('2026-10-31T19:00:00Z'), '2026-11-01T07:00:00.000Z'); // noon PDT Oct 31 -> midnight PDT
  assert.equal(next('2026-11-01T10:00:00Z'), '2026-11-02T08:00:00.000Z'); // 02:00 PST Nov 1 -> midnight PST
});

test('reset is the next midnight, strictly later, not 24 hours after use', () => {
  assert.equal(next('2026-01-16T08:00:00Z'), '2026-01-17T08:00:00.000Z'); // exactly midnight -> following midnight
  assert.equal(next('2026-01-16T07:59:00Z'), '2026-01-16T08:00:00.000Z'); // 23:59 PST -> one minute later
});

test('the counter day is the Pacific calendar day, not the UTC day', () => {
  assert.equal(pacificDayKey(at('2026-01-16T03:00:00Z')), '2026-01-15');
  assert.equal(pacificDayKey(at('2026-03-08T07:59:59Z')), '2026-03-07');
  assert.equal(pacificDayKey(at('2026-03-08T08:00:00Z')), '2026-03-08');
  assert.equal(pacificDayKey(at('2026-11-01T06:59:59Z')), '2026-10-31'); // 23:59:59 PDT
  assert.equal(pacificDayKey(at('2026-11-01T07:00:00Z')), '2026-11-01'); // 00:00 PDT, before the 02:00 fall-back
  assert.equal(pacificDayKey(at('2026-11-01T08:30:00Z')), '2026-11-01'); // repeated 01:30 hour still Nov 1
});

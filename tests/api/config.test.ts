import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../../src/api/config.ts';
import type { Env } from '../../src/env.ts';

const valid: Env = { DESK_OPEN: 'false', VISITOR_DAILY_LIMIT: '3', SHARED_DAILY_LIMIT: '50', RECORDING_URL: '' };

test('wrangler.jsonc vars parse: live reviews open for invited reviewers at release, approved limits and model unchanged', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '..', 'wrangler.jsonc'), 'utf8');
  const vars = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).vars as Env;
  assert.deepEqual(parseConfig(vars), { deskOpen: true, visitorDailyLimit: 3, sharedDailyLimit: 50, recordingUrl: null,
    geminiModel: 'gemini-3.5-flash-lite' });
});

test('limits may be lowered but never raised above the approved 3 and 50', () => {
  assert.equal(parseConfig({ ...valid, VISITOR_DAILY_LIMIT: '1' }).visitorDailyLimit, 1);
  for (const bad of [{ VISITOR_DAILY_LIMIT: '4' }, { SHARED_DAILY_LIMIT: '51' }, { VISITOR_DAILY_LIMIT: '0' },
    { VISITOR_DAILY_LIMIT: '2.5' }, { SHARED_DAILY_LIMIT: '' }, { VISITOR_DAILY_LIMIT: undefined }]) {
    assert.throws(() => parseConfig({ ...valid, ...bad }), ConfigError, JSON.stringify(bad));
  }
});

test('DESK_OPEN must be exactly "true" or "false"', () => {
  assert.equal(parseConfig({ ...valid, DESK_OPEN: 'true' }).deskOpen, true);
  for (const bad of ['TRUE', 'yes', '1', '', undefined]) {
    assert.throws(() => parseConfig({ ...valid, DESK_OPEN: bad }), ConfigError, String(bad));
  }
});

test('GEMINI_MODEL must be the approved identifier; anything else fails closed (no silent substitution)', () => {
  assert.equal(parseConfig({ ...valid, GEMINI_MODEL: 'gemini-3.5-flash-lite' }).geminiModel, 'gemini-3.5-flash-lite');
  assert.equal(parseConfig(valid).geminiModel, null);
  for (const bad of ['gemini-3.5-flash', 'gemini-2.5-flash-lite', 'Gemini 3.5 Flash Lite', 'models/gemini-3.5-flash-lite']) {
    assert.throws(() => parseConfig({ ...valid, GEMINI_MODEL: bad }), ConfigError, bad);
  }
});

test('RECORDING_URL must be https or a site path', () => {
  assert.equal(parseConfig({ ...valid, RECORDING_URL: '/demos/' }).recordingUrl, '/demos/');
  assert.throws(() => parseConfig({ ...valid, RECORDING_URL: 'http://example.com' }), ConfigError);
});

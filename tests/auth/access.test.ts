// Cloudflare Access JWT verification with locally signed tokens (no network).

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { errors, SignJWT } from 'jose';
import { AccessIdentityVerifier, accessSettingsFromEnv, certsUrl } from '../../src/auth/access.ts';
import { ACCESS_ENV, accessFixture, AUDIENCE, TEAM_DOMAIN, VISITOR_EMAIL, withToken, type AccessFixture } from '../helpers/durable.ts';

const URL_ = 'https://vet.deborahloring.com/api/allowance';
let fx: AccessFixture;
let verifier: AccessIdentityVerifier;
before(async () => {
  fx = await accessFixture();
  verifier = new AccessIdentityVerifier(accessSettingsFromEnv(ACCESS_ENV), fx.keys);
});
const verify = (token: string | null, v = verifier, headers: Record<string, string> = {}) =>
  v.verify(withToken(URL_, token, { headers }));
const now = () => Math.floor(Date.now() / 1000);

describe('valid, authorized identity', () => {
  test('a correctly signed token for an allowed email is accepted', async () => {
    const result = await verify(await fx.sign());
    assert.equal(result.ok, true);
  });
  test('the identity is an opaque SHA-256 key, never the subject, email or token', async () => {
    const token = await fx.sign();
    const result = await verify(token);
    assert.ok(result.ok);
    assert.match(result.identity.visitorKey, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(result);
    for (const secret of ['access-user-0001', VISITOR_EMAIL, token]) assert.ok(!serialized.includes(secret));
  });
  test('the same Access user gets the same key; different users get different keys', async () => {
    const a1 = await verify(await fx.sign());
    const a2 = await verify(await fx.sign({ iat: now() - 10 }));
    const b = await verify(await fx.sign({ sub: 'access-user-0002' }));
    assert.ok(a1.ok && a2.ok && b.ok);
    assert.equal(a1.identity.visitorKey, a2.identity.visitorKey);
    assert.notEqual(a1.identity.visitorKey, b.identity.visitorKey);
  });
  test('email matching is case-insensitive', async () => {
    assert.equal((await verify(await fx.sign({ email: 'Visitor@Example.COM' }))).ok, true);
  });
});

describe('rejected tokens', () => {
  const cases: [string, () => Promise<string | null>, string][] = [
    ['missing token', async () => null, 'missing'],
    ['garbage token', async () => 'not-a-jwt', 'invalid'],
    ['expired token', () => fx.sign({ iat: now() - 7200, exp: now() - 60 }), 'invalid'],
    ['not yet valid (nbf in the future)', () => fx.sign({ nbf: now() + 600 }), 'invalid'],
    ['forged: signed by another key with the same key id', () => fx.sign({}, { forged: true }), 'invalid'],
    ['wrong issuer', () => fx.sign({ iss: 'https://other-team.cloudflareaccess.com' }), 'invalid'],
    ['wrong audience', () => fx.sign({ aud: 'f'.repeat(64) }), 'invalid'],
    ['missing email claim', () => fx.sign({ email: null }), 'invalid'],
    ['missing subject claim', () => fx.sign({ sub: null }), 'invalid'],
    ['missing expiry claim', () => fx.sign({ exp: null }), 'invalid'],
    ['email not on the allowlist', () => fx.sign({ email: 'stranger@example.com' }), 'forbidden'],
  ];
  for (const [label, make, reason] of cases) {
    test(label, async () => assert.deepEqual(await verify(await make()), { ok: false, reason }));
  }
  test('tampered payload (claims edited after signing)', async () => {
    const [h, , s] = (await fx.sign()).split('.');
    const payload = Buffer.from(JSON.stringify({ iss: TEAM_DOMAIN, aud: AUDIENCE, sub: 'admin', email: VISITOR_EMAIL,
      iat: now(), exp: now() + 3600 })).toString('base64url');
    assert.deepEqual(await verify(`${h}.${payload}.${s}`), { ok: false, reason: 'invalid' });
  });
  test('unsigned "alg: none" token', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none' })}.${enc({ iss: TEAM_DOMAIN, aud: AUDIENCE, sub: 'x', email: VISITOR_EMAIL, iat: now(), exp: now() + 60 })}.`;
    assert.deepEqual(await verify(token), { ok: false, reason: 'invalid' });
  });
  test('HMAC token (algorithm confusion)', async () => {
    const token = await new SignJWT({ email: VISITOR_EMAIL }).setProtectedHeader({ alg: 'HS256' }).setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE).setSubject('x').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('guess'));
    assert.deepEqual(await verify(token), { ok: false, reason: 'invalid' });
  });
  test('an unverified identity header alone is never trusted', async () => {
    const result = await verify(null, verifier, { 'cf-access-authenticated-user-email': VISITOR_EMAIL });
    assert.deepEqual(result, { ok: false, reason: 'missing' });
  });
  test('oversized token is rejected before verification', async () => {
    assert.deepEqual(await verify(`a.${'b'.repeat(9000)}.c`), { ok: false, reason: 'invalid' });
  });
});

describe('access revocation (locally testable part)', () => {
  test('removing an email from ALLOWED_EMAIL denies a still-valid token', async () => {
    const token = await fx.sign();
    assert.equal((await verify(token)).ok, true);
    const revoked = new AccessIdentityVerifier(accessSettingsFromEnv({ ...ACCESS_ENV, ALLOWED_EMAIL: 'owner@example.com' }), fx.keys);
    assert.deepEqual(await verify(token, revoked), { ok: false, reason: 'forbidden' });
  });
  test('several allowed emails may be listed, comma-separated', async () => {
    const two = new AccessIdentityVerifier(accessSettingsFromEnv({ ...ACCESS_ENV, ALLOWED_EMAIL: `owner@example.com, ${VISITOR_EMAIL}` }), fx.keys);
    assert.equal((await verify(await fx.sign(), two)).ok, true);
  });
});

describe('fail closed on configuration or key problems', () => {
  test('missing or malformed Access settings mean not_configured', async () => {
    for (const env of [{}, { ...ACCESS_ENV, ACCESS_TEAM_DOMAIN: 'https://evil.example.com' },
      { ...ACCESS_ENV, ACCESS_TEAM_DOMAIN: 'http://paws-test.cloudflareaccess.com' }, { ...ACCESS_ENV, ACCESS_AUD: 'short' },
      { ...ACCESS_ENV, ALLOWED_EMAIL: '' }, { ...ACCESS_ENV, ALLOWED_EMAIL: 'not-an-email' }]) {
      assert.equal(accessSettingsFromEnv(env), null, JSON.stringify(env));
      const v = new AccessIdentityVerifier(accessSettingsFromEnv(env), fx.keys);
      assert.deepEqual(await verify(await fx.sign(), v), { ok: false, reason: 'not_configured' });
    }
  });
  test('signing keys that cannot be fetched mean unavailable, not invalid', async () => {
    for (const failure of [new errors.JWKSTimeout(), new TypeError('fetch failed')]) {
      const v = new AccessIdentityVerifier(accessSettingsFromEnv(ACCESS_ENV), async () => { throw failure; });
      assert.deepEqual(await verify(await fx.sign(), v), { ok: false, reason: 'unavailable' });
    }
  });
  test('keys come from the team certs endpoint', () => {
    assert.equal(certsUrl(TEAM_DOMAIN).href, `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  });
});

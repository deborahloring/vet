// Cloudflare Access JWT verification with jose.
//
// Only the signed `Cf-Access-Jwt-Assertion` header is trusted. Unsigned headers such as
// `Cf-Access-Authenticated-User-Email` are ignored. Signature (RS256 against the team's
// published keys), issuer, audience, expiry and not-before are all checked, then the
// verified email must be on the owner's allowlist (ALLOWED_EMAIL). Removing an email
// from that list revokes access at the Worker even while an Access session is still valid.
//
// The visitor is represented only by SHA-256(issuer + subject). The JWT, email and raw
// subject are never stored, logged or returned.

import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../env.ts';
import type { IdentityResult, IdentityVerifier } from '../api/ports.ts';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const MAX_TOKEN_LENGTH = 8192;
const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9]{16,128}$/;

export interface AccessSettings {
  teamDomain: string;
  audience: string;
  allowedEmails: ReadonlySet<string>;
}

/** Reads Access settings from secrets; null (fail closed) if any is missing or malformed. */
export function accessSettingsFromEnv(env: Env): AccessSettings | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/$/, '');
  const audience = (env.ACCESS_AUD ?? '').trim();
  const allowedEmails = new Set((env.ALLOWED_EMAIL ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience) || allowedEmails.size === 0) return null;
  if ([...allowedEmails].some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return null;
  return { teamDomain, audience, allowedEmails };
}

export function certsUrl(teamDomain: string): URL {
  return new URL(`${teamDomain}/cdn-cgi/access/certs`);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isKeyFetchFailure(e: unknown): boolean {
  // Network/timeout problems retrieving the signing keys mean "cannot verify now", not "invalid token".
  return e instanceof errors.JWKSTimeout || e instanceof TypeError
    || (e instanceof errors.JOSEError && e.code === 'ERR_JOSE_GENERIC' && /fetch|network|response/i.test(e.message));
}

export class AccessIdentityVerifier implements IdentityVerifier {
  private readonly settings: AccessSettings | null;
  private readonly keys: JWTVerifyGetKey | null;

  constructor(settings: AccessSettings | null, keys: JWTVerifyGetKey | null) {
    this.settings = settings;
    this.keys = keys;
  }

  async verify(request: Request): Promise<IdentityResult> {
    if (!this.settings || !this.keys) return { ok: false, reason: 'not_configured' };
    const token = request.headers.get(ACCESS_JWT_HEADER)?.trim();
    if (!token) return { ok: false, reason: 'missing' };
    if (token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) return { ok: false, reason: 'invalid' };

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.settings.teamDomain,
        audience: this.settings.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
      }));
    } catch (e) {
      return { ok: false, reason: isKeyFetchFailure(e) ? 'unavailable' : 'invalid' };
    }

    const email = typeof payload['email'] === 'string' ? payload['email'].trim().toLowerCase() : '';
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!email || !subject) return { ok: false, reason: 'invalid' };
    if (!this.settings.allowedEmails.has(email)) return { ok: false, reason: 'forbidden' };
    return { ok: true, identity: { visitorKey: await sha256Hex(`${payload.iss}\n${subject}`) } };
  }
}

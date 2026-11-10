// Local stand-ins for Durable Object storage and Access keys. SQL runs on a real SQLite
// engine (node:sqlite) with the same statements the Durable Object uses. Tokens are signed
// with locally generated RSA keys; no network is involved.

import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { DurableStorageLike, SqlValue } from '../../src/allowance/ledger.ts';
import { DeskState } from '../../src/desk-state.ts';
import type { DurableObjectNamespaceLike, Env } from '../../src/env.ts';

export interface MemoryStorage extends DurableStorageLike {
  /** Throw on any statement whose text matches, simulating a storage failure. */
  failWhen: RegExp | null;
  db: DatabaseSync;
}

export function memoryStorage(): MemoryStorage {
  const db = new DatabaseSync(':memory:');
  const storage: MemoryStorage = {
    db,
    failWhen: null,
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        if (storage.failWhen?.test(query)) throw new Error('simulated storage failure');
        const statement = db.prepare(query);
        const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []);
        return { toArray: () => rows as Record<string, SqlValue>[] };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return storage;
}

export const DESK_ENV: Env = { DESK_OPEN: 'true', VISITOR_DAILY_LIMIT: '3', SHARED_DAILY_LIMIT: '50', RECORDING_URL: '' };

/** A namespace whose every id resolves to one DeskState instance, as in production. */
export function deskNamespace(opts: { env?: Env; clock?: () => Date; storage?: MemoryStorage } = {}) {
  const storage = opts.storage ?? memoryStorage();
  let clock = opts.clock ?? (() => new Date('2026-07-15T19:00:00Z'));
  const desk = new DeskState({ storage }, opts.env ?? DESK_ENV, () => clock());
  const seen: string[] = [];
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => { seen.push(name); return name; },
    get: () => ({ fetch: (request) => desk.fetch(request) }),
  };
  return { namespace, storage, desk, seen, setClock: (c: () => Date) => { clock = c; } };
}

export const TEAM_DOMAIN = 'https://paws-test.cloudflareaccess.com';
export const AUDIENCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
export const VISITOR_EMAIL = 'visitor@example.com';
export const ACCESS_ENV: Env = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE, ALLOWED_EMAIL: VISITOR_EMAIL };

export interface AccessFixture {
  keys: JWTVerifyGetKey;
  /** Signs an Access-style token; pass `null` for a claim to omit it. */
  sign(claims?: Partial<Record<'iss' | 'aud' | 'sub' | 'email' | 'exp' | 'iat' | 'nbf', string | number | null>>,
    options?: { forged?: boolean }): Promise<string>;
}

export async function accessFixture(): Promise<AccessFixture> {
  const real = await generateKeyPair('RS256', { extractable: true });
  const attacker = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(real.publicKey)), kid: 'access-key-1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  return {
    keys,
    async sign(claims = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const all: Record<string, string | number | null> = {
        iss: TEAM_DOMAIN, aud: AUDIENCE, sub: 'access-user-0001', email: VISITOR_EMAIL, iat: now, exp: now + 3600, ...claims,
      };
      const payload: JWTPayload = { type: 'app' };
      for (const [k, v] of Object.entries(all)) if (v !== null) payload[k] = v;
      return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'access-key-1' })
        .sign(options.forged ? attacker.privateKey : real.privateKey);
    },
  };
}

export function withToken(url: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('cf-access-jwt-assertion', token);
  return new Request(url, { ...init, headers });
}

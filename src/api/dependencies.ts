// Production wiring.
//   identity  — Cloudflare Access JWT verification (Step 3); not_configured if secrets are missing.
//   allowance — SQLite Durable Object counters (Step 3); null if the DESK binding is missing.
//   interpreter — one Gemini request per review (Step 4); null without GEMINI_API_KEY or an
//   approved GEMINI_MODEL.
//   composer — the unified Temperance response (Step 5).
// Live reviews additionally require DESK_OPEN="true" (wrangler.jsonc ships "false"), so a
// deployment stays closed to reviews until the owner deliberately opens the desk.
// Do not replace a null with a permissive stand-in.

import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { DurableAllowanceStore } from '../allowance/durable-store.ts';
import { AccessIdentityVerifier, accessSettingsFromEnv, certsUrl } from '../auth/access.ts';
import type { Env } from '../env.ts';
import { GeminiInterpreter } from '../gemini/interpreter.ts';
import { isApprovedModel } from '../gemini/model.ts';
import { composer } from '../compose/composer.ts';
import type { Dependencies, LogEvent } from './ports.ts';

// One key set per team domain per isolate, so Access signing keys are cached between requests.
const keySets = new Map<string, JWTVerifyGetKey>();

function accessKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(certsUrl(teamDomain), { timeoutDuration: 3000, cooldownDuration: 30_000 });
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export function productionDependencies(env: Env): Dependencies {
  const settings = accessSettingsFromEnv(env);
  const apiKey = (env.GEMINI_API_KEY ?? '').trim();
  const model = (env.GEMINI_MODEL ?? '').trim();
  return {
    identity: new AccessIdentityVerifier(settings, settings ? accessKeys(settings.teamDomain) : null),
    allowance: env.DESK ? new DurableAllowanceStore(env.DESK) : null,
    interpreter: apiKey && isApprovedModel(model) ? new GeminiInterpreter({ apiKey, model }) : null,
    composer,
    now: () => new Date(),
    newReviewId: () => crypto.randomUUID(),
    // Events carry route, status, code, invoice number and provenance counts only — never identity or tokens.
    log: (event: LogEvent) => console.log(JSON.stringify(event)),
  };
}

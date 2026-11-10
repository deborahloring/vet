// Owner-authorized key loading for offline live tools (model check, development evaluation).
// Order: GEMINI_API_KEY from the environment, or, only when the caller passes
// fromDeployVars, the single GEMINI_API_KEY line of .dev.vars.deploy, read inside this process.
// The key is never printed, logged or written anywhere; use scrubKey() on any text you print.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
let loaded = '';

export function loadGeminiKey(fromDeployVars: boolean): string {
  const fromEnv = (process.env['GEMINI_API_KEY'] ?? '').trim();
  if (fromEnv) return (loaded = fromEnv);
  if (!fromDeployVars) return '';
  const file = join(REPO, '.dev.vars.deploy');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^\s*GEMINI_API_KEY\s*=/.test(l));
  loaded = line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  return loaded;
}

export function scrubKey(text: string): string {
  return loaded ? text.split(loaded).join('[key]') : text;
}

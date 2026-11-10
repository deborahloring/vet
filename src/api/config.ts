// Strict parsing of non-secret Worker settings. Invalid settings fail closed.

import type { Env } from '../env.ts';
import { isApprovedModel, type GeminiModel } from '../gemini/model.ts';

/** Approved ceilings: 3 per visitor and 50 shared per Pacific Time day. Settings may lower, never raise, them. */
export const APPROVED_VISITOR_DAILY_LIMIT = 3;
export const APPROVED_SHARED_DAILY_LIMIT = 50;

export interface WorkerConfig {
  deskOpen: boolean;
  visitorDailyLimit: number;
  sharedDailyLimit: number;
  recordingUrl: string | null;
  /** Null when unset (interpretation unavailable); an unapproved value is a configuration error. */
  geminiModel: GeminiModel | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function limit(value: string | undefined, name: string, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new ConfigError(`${name} must be a whole number`);
  const n = Number(value);
  if (n < 1 || n > max) throw new ConfigError(`${name} must be between 1 and the approved ${max}`);
  return n;
}

export function parseConfig(env: Env): WorkerConfig {
  if (env.DESK_OPEN !== 'true' && env.DESK_OPEN !== 'false') throw new ConfigError('DESK_OPEN must be "true" or "false"');
  const recording = (env.RECORDING_URL ?? '').trim();
  const model = (env.GEMINI_MODEL ?? '').trim();
  if (model && !isApprovedModel(model)) throw new ConfigError(`GEMINI_MODEL "${model}" is not an approved model`);
  if (recording && !/^(https:\/\/|\/)/.test(recording)) throw new ConfigError('RECORDING_URL must be https:// or a site path');
  return {
    deskOpen: env.DESK_OPEN === 'true',
    visitorDailyLimit: limit(env.VISITOR_DAILY_LIMIT, 'VISITOR_DAILY_LIMIT', APPROVED_VISITOR_DAILY_LIMIT),
    sharedDailyLimit: limit(env.SHARED_DAILY_LIMIT, 'SHARED_DAILY_LIMIT', APPROVED_SHARED_DAILY_LIMIT),
    recordingUrl: recording || null,
    geminiModel: model && isApprovedModel(model) ? model : null,
  };
}

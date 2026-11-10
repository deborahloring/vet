// Worker-side AllowanceStore that talks to the single DeskState Durable Object.
// Any failure (network, storage, malformed reply) is reported as unavailable so the
// router fails closed; it never assumes an allowance.

import type { DurableObjectNamespaceLike } from '../env.ts';
import type { AllowanceSnapshot, AllowanceStore, ReservationResult, VisitorIdentity } from '../api/ports.ts';

export const DESK_INSTANCE = 'desk';
const ORIGIN = 'https://desk.internal';

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function parseSnapshot(raw: unknown): AllowanceSnapshot | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || !isCount(s['visitorRemaining']) || !isCount(s['visitorLimit']) || !isCount(s['sharedRemaining'])
    || !isCount(s['sharedLimit']) || typeof s['dayKey'] !== 'string' || typeof s['resetAt'] !== 'string') return null;
  const resetAt = new Date(s['resetAt']);
  if (Number.isNaN(resetAt.getTime())) return null;
  return {
    visitorRemaining: s['visitorRemaining'], visitorLimit: s['visitorLimit'], sharedRemaining: s['sharedRemaining'],
    sharedLimit: s['sharedLimit'], dayKey: s['dayKey'], resetAt,
  };
}

export class DurableAllowanceStore implements AllowanceStore {
  private readonly namespace: DurableObjectNamespaceLike;

  constructor(namespace: DurableObjectNamespaceLike) {
    this.namespace = namespace;
  }

  private async call(action: 'status' | 'reserve' | 'pause', body: object): Promise<Record<string, unknown> | null> {
    try {
      const stub = this.namespace.get(this.namespace.idFromName(DESK_INSTANCE));
      const response = await stub.fetch(new Request(`${ORIGIN}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      if (response.status !== 200) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async status(identity: VisitorIdentity): Promise<AllowanceSnapshot | null> {
    const reply = await this.call('status', { visitorKey: identity.visitorKey });
    return reply && reply['ok'] === true ? parseSnapshot(reply['snapshot']) : null;
  }

  async pause(until: Date): Promise<boolean> {
    const reply = await this.call('pause', { until: until.toISOString() });
    return reply?.['ok'] === true;
  }

  async reserve(identity: VisitorIdentity, reviewId: string): Promise<ReservationResult> {
    const reply = await this.call('reserve', { visitorKey: identity.visitorKey, reviewId });
    if (!reply) return { ok: false, reason: 'unavailable' };
    const snapshot = parseSnapshot(reply['snapshot']);
    if (reply['ok'] === true && snapshot) return { ok: true, snapshot };
    if (reply['ok'] === false && reply['reason'] === 'paused') return snapshot ? { ok: false, reason: 'paused', snapshot } : { ok: false, reason: 'paused' };
    if (reply['ok'] === false && reply['reason'] === 'busy') {
      const wait = reply['retryAfterSeconds'];
      if (typeof wait === 'number' && Number.isInteger(wait) && wait >= 1 && wait <= 60) {
        return snapshot ? { ok: false, reason: 'busy', retryAfterSeconds: wait, snapshot } : { ok: false, reason: 'busy', retryAfterSeconds: wait };
      }
      return { ok: false, reason: 'unavailable' };
    }
    if (reply['ok'] === false && (reply['reason'] === 'visitor_limit' || reply['reason'] === 'shared_limit')) {
      return snapshot ? { ok: false, reason: reply['reason'], snapshot } : { ok: false, reason: reply['reason'] };
    }
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Twelve Data API-key pool with sequential failover.
 *
 * WHY
 * ───
 * The free Basic plan gives 8 credits/minute and 800 credits/day PER KEY.
 * Several keys (one per Twelve Data account) multiply that budget: the pool
 * always serves from the FIRST key that still has credits and only moves to
 * the next one when that key is spent, so keys drain predictably (#1, then
 * #2, …) instead of all at once.
 *
 * Two independent mechanisms keep it honest:
 *
 *  1. PROACTIVE metering — every request is counted against the key's own
 *     minute window and UTC-day counter before it is sent, so a key that we
 *     know is spent is skipped without wasting a round-trip.
 *  2. REACTIVE rotation — Twelve Data is the real authority. When it answers
 *     "out of credits" (HTTP 429, or HTTP 200 with {status:"error",code:429}),
 *     the key is put on cooldown and the SAME request is retried on the next
 *     key. This is what makes the pool correct even on serverless hosts, where
 *     the in-memory counters of (1) are reset on every cold start.
 *
 * Keys are never logged; `label` is a masked suffix for diagnostics.
 */

const MINUTE_MS = 60_000;

/** Failover order: TWELVEDATA_API_KEY, then TWELVEDATA_API_KEYS, then _1.._20. */
export function readApiKeys(env = process.env) {
  const numbered = [];
  for (let i = 1; i <= 20; i++) numbered.push(env[`TWELVEDATA_API_KEY_${i}`]);
  const raw = [env.TWELVEDATA_API_KEY, env.TWELVEDATA_API_KEYS, ...numbered]
    .filter(Boolean)
    .join(',');
  const seen = new Set();
  const keys = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

const mask = (key) => `••••${key.slice(-4)}`;

const utcDayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

function msToUtcMidnight(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ts;
}

/**
 * Classify a Twelve Data answer so the caller knows whether to fail over.
 * Twelve Data reports errors with HTTP 200 + {status:"error", code} just as
 * often as with a real HTTP status, so both are inspected.
 *
 * @returns {'ok'|'exhausted'|'auth'|'error'}
 */
export function classifyResponse(httpStatus, body) {
  const code = body && typeof body === 'object' && body.status === 'error' ? Number(body.code) : null;
  const message = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : '';
  if (httpStatus === 429 || code === 429) return 'exhausted';
  if (httpStatus === 401 || httpStatus === 403 || code === 401 || code === 403) return 'auth';
  // Some plan/credit errors arrive as 400 with an explanatory message.
  if ((httpStatus === 400 || code === 400) && /credit|limit|plan|upgrade/i.test(message)) return 'exhausted';
  if (httpStatus >= 200 && httpStatus < 300 && code === null) return 'ok';
  return 'error';
}

/** How long a key stays parked after Twelve Data refused it. */
export function cooldownFor(message, now) {
  if (/current minute|per minute|minute limit/i.test(message)) return { scope: 'minute', ms: MINUTE_MS };
  if (/day|daily/i.test(message)) return { scope: 'day', ms: Math.max(MINUTE_MS, msToUtcMidnight(now)) };
  return { scope: 'unknown', ms: MINUTE_MS };
}

export class TwelveDataKeyPool {
  /**
   * @param {{ keys: string[], perMinute?: number, perDay?: number|null, now?: () => number }} opts
   */
  constructor(opts) {
    this.perMinute = Math.max(1, opts.perMinute ?? 8);
    this.perDay = opts.perDay && opts.perDay > 0 ? opts.perDay : null;
    this.now = opts.now ?? Date.now;
    this.keys = opts.keys.map((apiKey, i) => ({
      index: i,
      apiKey,
      label: mask(apiKey),
      minute: [], // [{ at, cost }] rolling 60s window
      dayKey: utcDayKey(this.now()),
      dayUsed: 0,
      cooldownUntil: 0,
      dead: false, // rejected credentials — never retried in this process
      deadReason: '',
    }));
  }

  get size() {
    return this.keys.length;
  }

  /**
   * First key that can pay `cost` right now, or null when the whole pool is
   * spent. Does NOT charge the key — call `spend()` once the request is sent.
   * @returns {{ index: number, apiKey: string, label: string } | null}
   */
  acquire(cost = 1) {
    const now = this.now();
    for (const k of this.keys) {
      this.#roll(k, now);
      if (k.dead || k.cooldownUntil > now) continue;
      if (this.perDay !== null && k.dayUsed + cost > this.perDay) continue;
      if (this.#minuteUsed(k) + cost > this.perMinute) continue;
      return { index: k.index, apiKey: k.apiKey, label: k.label };
    }
    return null;
  }

  /** Charge `cost` credits to a key (called just before the upstream request). */
  spend(index, cost = 1) {
    const k = this.keys[index];
    if (!k) return;
    const now = this.now();
    this.#roll(k, now);
    k.minute.push({ at: now, cost });
    k.dayUsed += cost;
  }

  /** Twelve Data refused this key: park it so `acquire()` skips it. */
  penalize(index, outcome, message = '') {
    const k = this.keys[index];
    if (!k) return;
    const now = this.now();
    if (outcome === 'auth') {
      k.dead = true;
      k.deadReason = message || 'API key rejected';
      return;
    }
    const { scope, ms } = cooldownFor(message, now);
    k.cooldownUntil = now + ms;
    // Mirror the provider's verdict into our own counters so a restart of the
    // minute window does not immediately re-pick a key that is out for the day.
    if (scope === 'day' && this.perDay !== null) k.dayUsed = this.perDay;
  }

  /** A key answered normally — clear any cooldown left over from a stale penalty. */
  reportSuccess(index) {
    const k = this.keys[index];
    if (k) k.cooldownUntil = 0;
  }

  /** ms until the earliest key frees up; null when no key can ever recover. */
  retryAfterMs() {
    const now = this.now();
    let soonest = null;
    for (const k of this.keys) {
      if (k.dead) continue;
      this.#roll(k, now);
      let at = k.cooldownUntil;
      if (this.perDay !== null && k.dayUsed >= this.perDay) at = Math.max(at, now + msToUtcMidnight(now));
      if (this.#minuteUsed(k) >= this.perMinute) at = Math.max(at, (k.minute[0]?.at ?? now) + MINUTE_MS);
      const wait = Math.max(0, at - now);
      if (soonest === null || wait < soonest) soonest = wait;
    }
    return soonest;
  }

  /** Pool state for GET /api/td-rest/_status (never includes key material). */
  snapshot() {
    const now = this.now();
    const keys = this.keys.map((k) => {
      this.#roll(k, now);
      const state = k.dead
        ? 'rejected'
        : k.cooldownUntil > now
          ? 'cooldown'
          : this.perDay !== null && k.dayUsed >= this.perDay
            ? 'exhausted'
            : 'ready';
      return {
        index: k.index + 1,
        label: k.label,
        state,
        usedToday: k.dayUsed,
        usedThisMinute: this.#minuteUsed(k),
        cooldownMs: Math.max(0, k.cooldownUntil - now),
        reason: k.deadReason || undefined,
      };
    });
    const usable = keys.filter((k) => k.state === 'ready').length;
    return {
      provider: 'twelvedata',
      keys: this.size,
      available: usable,
      perMinutePerKey: this.perMinute,
      perDayPerKey: this.perDay,
      perMinuteTotal: this.perMinute * this.size,
      perDayTotal: this.perDay === null ? null : this.perDay * this.size,
      usedToday: this.keys.reduce((sum, k) => sum + k.dayUsed, 0),
      retryAfterMs: usable > 0 ? 0 : this.retryAfterMs(),
      pool: keys,
    };
  }

  #minuteUsed(k) {
    return k.minute.reduce((sum, s) => sum + s.cost, 0);
  }

  #roll(k, now) {
    const today = utcDayKey(now);
    if (k.dayKey !== today) {
      k.dayKey = today;
      k.dayUsed = 0;
      if (!k.dead) k.cooldownUntil = 0;
    }
    k.minute = k.minute.filter((s) => s.at > now - MINUTE_MS);
  }
}

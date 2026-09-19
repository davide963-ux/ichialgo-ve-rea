/**
 * Client-side credit meter for Twelve Data.
 *
 * Twelve Data charts 1 credit per symbol per request, with a per-minute limit
 * and (on the free Basic plan) a hard daily cap. Hitting either returns errors,
 * so we meter BEFORE calling and fail fast with a clear message instead.
 *
 * The daily count is persisted in localStorage so a page reload doesn't reset it.
 * Note: separate browsers/tabs each keep their own count – Twelve Data's own
 * 429 response is still mapped to `rate_limit` as the backstop.
 *
 * With several API keys pooled server-side (server/twelveDataKeyPool.mjs) the
 * real budget is `perKeyLimit × keyCount`. The provider learns the pool size
 * from GET /api/td-rest/_status and calls `setLimits()` – the meter itself
 * stays a simple counter and never sees a key.
 */
import { ProviderError } from '../types';

const STORAGE_KEY = 'ichialgo.twelvedata.credits';

export interface CreditBudgetOptions {
  perMinute: number;
  perDay: number | null;
  /** Number of pooled API keys the proxy serves from (for the error message). */
  poolSize?: number;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export class CreditBudget {
  private perMinute: number;
  private perDay: number | null;
  private poolSize: number;
  private readonly now: () => number;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private window: { at: number; cost: number }[] = [];
  private day = { key: '', used: 0 };

  constructor(opts: CreditBudgetOptions) {
    this.perMinute = Math.max(1, opts.perMinute);
    this.perDay = opts.perDay && opts.perDay > 0 ? opts.perDay : null;
    this.poolSize = Math.max(1, opts.poolSize ?? 1);
    this.now = opts.now ?? Date.now;
    this.storage = opts.storage !== undefined ? opts.storage : safeLocalStorage();
    this.load();
  }

  /**
   * Re-point the meter at the pooled budget reported by the proxy.
   * Called once per session, before the first request.
   */
  setLimits(limits: { perMinute: number; perDay: number | null; poolSize?: number }): void {
    this.perMinute = Math.max(1, limits.perMinute);
    this.perDay = limits.perDay && limits.perDay > 0 ? limits.perDay : null;
    if (limits.poolSize) this.poolSize = Math.max(1, limits.poolSize);
  }

  limits(): { perMinute: number; perDay: number | null; poolSize: number } {
    return { perMinute: this.perMinute, perDay: this.perDay, poolSize: this.poolSize };
  }

  usedToday(): number {
    this.rollDay();
    return this.day.used;
  }

  /**
   * Reserve credits, waiting (up to `maxWaitMs`) for the per-minute window to free up.
   * The daily cap never waits – it throws immediately.
   */
  async reserve(cost: number, signal?: AbortSignal, maxWaitMs = 65_000): Promise<void> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      try {
        this.spend(cost);
        return;
      } catch (err) {
        const e = err as ProviderError;
        const isMinute = e.kind === 'rate_limit' && !/daily limit/.test(e.message);
        const wait = e.retryAfterMs ?? 1_000;
        if (!isMinute || this.now() + wait > deadline) throw err;
        await sleep(wait, signal);
      }
    }
  }

  /** Reserve `cost` credits now or throw a `rate_limit` ProviderError with a retry time. */
  spend(cost: number): void {
    const now = this.now();
    this.rollDay();

    if (this.perDay !== null && this.day.used + cost > this.perDay) {
      const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
      const across = this.poolSize > 1 ? ` across ${this.poolSize} API keys` : '';
      throw new ProviderError(
        'rate_limit',
        `Twelve Data daily limit reached (${this.day.used}/${this.perDay} credits${across}). Prices resume after 00:00 UTC.`,
        { retryAfterMs: Math.max(60_000, midnight - now) },
      );
    }

    this.window = this.window.filter((s) => s.at > now - 60_000);
    const used = this.window.reduce((sum, s) => sum + s.cost, 0);
    if (used + cost > this.perMinute) {
      const oldest = this.window[0]?.at ?? now;
      throw new ProviderError(
        'rate_limit',
        `Twelve Data per-minute limit (${this.perMinute} credits) would be exceeded`,
        { retryAfterMs: Math.max(1_000, oldest + 60_000 - now + 250) },
      );
    }

    this.window.push({ at: now, cost });
    this.day.used += cost;
    this.save();
  }

  private rollDay() {
    const key = new Date(this.now()).toISOString().slice(0, 10);
    if (key !== this.day.key) this.day = { key, used: 0 };
  }

  private load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { key?: string; used?: number };
        if (typeof parsed.key === 'string' && typeof parsed.used === 'number') this.day = { key: parsed.key, used: parsed.used };
      }
    } catch {
      /* corrupt or unavailable storage – start fresh */
    }
    this.rollDay();
  }

  private save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.day));
    } catch {
      /* storage unavailable – in-memory metering still works */
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

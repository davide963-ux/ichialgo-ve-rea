/**
 * Twelve Data feed for the scanner, on top of the existing key pool.
 *
 * The pool is reused rather than reimplemented: it already knows the credit
 * model (8/min, 800/day, per key), meters proactively, and fails over on the
 * provider's own 429. Writing a second copy here is how the two drift apart
 * and one of them starts silently burning the budget.
 *
 * ONE CACHE PER RUN
 * ─────────────────
 * The cache lives in the feed instance, which the handler creates per request.
 * That is deliberate: a module-level cache on serverless is per-instance and
 * unpredictable — sometimes warm, sometimes cold, never something you can
 * reason about. Within a run it is exact (the daily bias series and the daily
 * scan share one fetch); across runs nothing is assumed.
 */
import { TwelveDataKeyPool, classifyResponse, readApiKeys } from './twelveDataKeyPool.mjs';
import type { Candle } from '../src/services/marketData/types';
import type { MarketFeed } from './scannerCore';

/** App timeframe → Twelve Data interval. */
const INTERVALS: Record<string, string> = {
  '30M': '30min',
  '1H': '1h',
  '4H': '4h',
  '1D': '1day',
};

export interface FeedConfig {
  rest: string;
  creditsPerMinute: number;
  creditsPerDay: number;
}

export function readFeedConfig(env: Record<string, string | undefined>): FeedConfig {
  return {
    rest: (env.TWELVEDATA_REST_URL || 'https://api.twelvedata.com').replace(/\/+$/, ''),
    creditsPerMinute: Number(env.TWELVEDATA_CREDITS_PER_MINUTE || 8),
    creditsPerDay: Number(env.TWELVEDATA_CREDITS_PER_DAY || 800),
  };
}

export class TwelveDataFeed implements MarketFeed {
  private readonly pool: InstanceType<typeof TwelveDataKeyPool>;
  private readonly cache = new Map<string, Candle[]>();
  private credits = 0;

  constructor(
    private readonly cfg: FeedConfig,
    keys: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.pool = new TwelveDataKeyPool({
      keys: [...keys],
      perMinute: cfg.creditsPerMinute,
      perDay: cfg.creditsPerDay,
    });
  }

  static fromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): TwelveDataFeed {
    return new TwelveDataFeed(readFeedConfig(env), readApiKeys(env), fetchImpl);
  }

  get keyCount(): number {
    return this.pool.size;
  }

  creditsUsed(): number {
    return this.credits;
  }

  /**
   * One request, with failover.
   *
   * Only credit and auth failures rotate the key. A bad symbol or an upstream
   * 500 would fail identically on every key, so retrying would just spend the
   * whole budget to produce the same error.
   */
  private async request(path: string, cost: number): Promise<unknown> {
    const tried: string[] = [];

    for (let attempt = 0; attempt < this.pool.size; attempt++) {
      const lease = this.pool.acquire(cost);
      if (!lease) break;
      this.pool.spend(lease.index, cost);
      this.credits += cost;
      tried.push(lease.label);

      const res = await this.fetchImpl(`${this.cfg.rest}${path}`, {
        headers: { Accept: 'application/json', Authorization: `apikey ${lease.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Twelve Data returned non-JSON (HTTP ${res.status})`);
      }

      const verdict = classifyResponse(res.status, body);
      if (verdict === 'exhausted' || verdict === 'auth') {
        const message = (body as { message?: string } | null)?.message ?? '';
        this.pool.penalize(lease.index, verdict, message);
        continue;
      }
      if (verdict !== 'ok') {
        const message = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
        throw new Error(message);
      }

      this.pool.reportSuccess(lease.index);
      return body;
    }

    throw new Error(
      this.pool.size === 0
        ? 'No Twelve Data API keys configured.'
        : `All ${this.pool.size} Twelve Data keys are out of credits (tried ${tried.join(', ') || 'none'}).`,
    );
  }

  async candles(symbol: string, timeframe: string, outputSize: number): Promise<Candle[]> {
    const interval = INTERVALS[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe ${timeframe}`);

    const key = `${symbol}|${interval}|${outputSize}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const body = (await this.request(
      `/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputSize}&order=ASC`,
      1,
    )) as { values?: Record<string, string>[] };

    const values = body?.values ?? [];
    if (values.length === 0) throw new Error(`No candles for ${symbol} ${timeframe}`);

    const candles = values.map(toCandle).filter((c): c is Candle => c !== null);
    markCompleteness(candles, timeframe);
    this.cache.set(key, candles);
    return candles;
  }

  async price(symbol: string): Promise<number> {
    const body = (await this.request(`/price?symbol=${encodeURIComponent(symbol)}`, 1)) as { price?: string };
    const value = Number(body?.price);
    if (!Number.isFinite(value)) throw new Error(`No price for ${symbol}`);
    return value;
  }
}

function toCandle(v: Record<string, string>): Candle | null {
  const time = Math.floor(Date.parse(`${v.datetime}Z`.replace(/Z+$/, 'Z')) / 1000);
  const open = Number(v.open);
  const high = Number(v.high);
  const low = Number(v.low);
  const close = Number(v.close);
  if (!Number.isFinite(time) || ![open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: null, complete: true };
}

const SECONDS: Record<string, number> = { '30M': 1800, '1H': 3600, '4H': 14400, '1D': 86400 };

/**
 * Mark the newest candle incomplete when its period has not elapsed.
 *
 * Twelve Data returns the forming bar alongside closed ones with nothing to
 * distinguish them. Deriving completeness from the bar's own open time and the
 * timeframe's length is the only reliable way to tell, and getting it wrong
 * means confirming entries on a close that has not happened yet.
 */
export function markCompleteness(candles: Candle[], timeframe: string, nowMs: number = Date.now()): void {
  const seconds = SECONDS[timeframe];
  const last = candles[candles.length - 1];
  if (!seconds || !last) return;
  last.complete = nowMs / 1000 >= last.time + seconds;
}

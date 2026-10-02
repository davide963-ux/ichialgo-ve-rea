/**
 * Serves candles from Yahoo when it will, and from the wrapped provider when
 * it will not.
 *
 * WHY A ROUTER RATHER THAN A PROVIDER SWAP
 * ────────────────────────────────────────
 * Yahoo was dropped in #10 for a real reason: its chart endpoint is
 * unofficial and answers 429 to datacenter IPs, which is what a Vercel
 * function is. Nothing here disputes that. What changed is the ask — candles
 * only, fetched when a chart is opened rather than every 60 seconds forever,
 * and behind a 15-minute server cache.
 *
 * So Yahoo is a saving, never a dependency:
 *
 *   getCandles ──▶ breaker open? ──yes──────────────▶ Twelve Data (1 credit)
 *                       │no
 *                       ▼
 *                   Yahoo ──ok──▶ candles (0 credits)
 *                       │
 *                       └──fails──▶ record ──▶ Twelve Data (1 credit)
 *
 * Quotes, streaming and configuration all pass straight through: the live
 * price stays on Twelve Data, where the change basis, the market-open flag
 * and the credit meter already are.
 *
 * THE BREAKER exists so a persistent refusal costs one wasted round trip per
 * cooldown rather than one per chart. A 429 is treated as the datacenter-IP
 * block and parked for a long time; anything else needs to happen repeatedly
 * before Yahoo is parked at all, because a single bad response is usually
 * just one bad response.
 */
import type { Timeframe } from '../../../config/timeframes';
import { fetchYahooCandles } from './yahooCandles';
import {
  isAbort,
  toProviderError,
  type Candle,
  type CandleRequestOptions,
  type MarketDataProvider,
  type QuoteBatch,
  type QuoteListener,
  type ProviderError,
  type StreamHandle,
} from '../types';

/** A 429 is the datacenter-IP block; it does not clear in a minute. */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
/** Anything else: shorter, and only after it keeps happening. */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const FAILURES_BEFORE_PARKING = 3;

export interface CandleSourceStats {
  /** Series served by Yahoo — each one a Twelve Data credit not spent. */
  fromYahoo: number;
  /** Series that fell back to the wrapped provider. */
  fromFallback: number;
  consecutiveFailures: number;
  /** Epoch ms until which Yahoo is parked, or null when it is in use. */
  parkedUntil: number | null;
  lastError: string | null;
}

export class YahooCandleRouter implements MarketDataProvider {
  readonly id;
  readonly label;
  readonly capabilities;

  /** Present only when the wrapped provider streams, so the service's
   *  `capabilities.streaming && provider.subscribe` check stays honest. */
  readonly subscribe?: (symbols: string[], onQuotes: QuoteListener, onError: (err: ProviderError) => void) => StreamHandle;

  private fromYahoo = 0;
  private fromFallback = 0;
  private failures = 0;
  private parkedUntil = 0;
  private lastError: string | null = null;

  constructor(private readonly delegate: MarketDataProvider) {
    this.id = delegate.id;
    this.label = delegate.label;
    this.capabilities = delegate.capabilities;
    if (delegate.subscribe) this.subscribe = delegate.subscribe.bind(delegate);
  }

  stats(): CandleSourceStats {
    return {
      fromYahoo: this.fromYahoo,
      fromFallback: this.fromFallback,
      consecutiveFailures: this.failures,
      parkedUntil: this.parkedUntil > Date.now() ? this.parkedUntil : null,
      lastError: this.lastError,
    };
  }

  // ── straight through to the wrapped provider ────────────────────────────

  assertConfigured(signal?: AbortSignal): Promise<void> {
    // Nothing to configure on the Yahoo side: no key, no account. A refusal
    // shows up on the first chart and falls back, rather than costing a
    // round trip here that would delay the first price.
    return this.delegate.assertConfigured(signal);
  }

  getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    return this.delegate.getQuotes(symbols, signal);
  }

  /** Duck-typed by MarketDataService to size the poll interval. */
  setSymbolCount(count: number): void {
    (this.delegate as { setSymbolCount?: (n: number) => void }).setSymbolCount?.(count);
  }

  // ── the one method that is actually routed ──────────────────────────────

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    signal?: AbortSignal,
    opts?: CandleRequestOptions,
  ): Promise<Candle[]> {
    if (Date.now() < this.parkedUntil) {
      this.fromFallback++;
      return this.delegate.getCandles(symbol, timeframe, count, signal, opts);
    }

    try {
      const candles = await fetchYahooCandles(symbol, timeframe, count, signal);
      this.failures = 0;
      this.lastError = null;
      this.fromYahoo++;
      return candles;
    } catch (err) {
      // The caller cancelling is not Yahoo failing. Falling back here would
      // start a second request for a chart nobody is looking at any more.
      if (isAbort(err) && signal?.aborted) throw err;
      this.record(err);
      this.fromFallback++;
      return this.delegate.getCandles(symbol, timeframe, count, signal, opts);
    }
  }

  private record(err: unknown): void {
    const e = toProviderError(err);
    this.lastError = e.message;
    this.failures++;
    if (e.kind === 'rate_limit') {
      // Not a blip: this is the block the endpoint is known for.
      this.parkedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    } else if (this.failures >= FAILURES_BEFORE_PARKING) {
      this.parkedUntil = Date.now() + FAILURE_COOLDOWN_MS;
    }
  }
}

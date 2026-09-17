/**
 * Yahoo Finance chart provider (REST polling).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every other forex source needs an account, and brokers are licensed per
 * country — OANDA will not open one in Albania, Finnhub puts forex candles
 * behind a paid plan, and Twelve Data's free tier is 8 credits/minute. This
 * endpoint needs no key, no account and has no geography check, because
 * there is nothing to sign up for.
 *
 *   GET /v8/finance/chart/EURUSD=X?interval=15m&range=5d
 *     → meta:       live price, % change, previous close
 *     → timestamp:  UNIX seconds, one per bar
 *     → indicators.quote[0]: open[] high[] low[] close[] volume[]
 *
 * ONE REQUEST GIVES BOTH the quote and the candles, because `meta` carries
 * the live price. So a 7-pair refresh is 7 requests with no credit maths.
 *
 * THE CATCHES, all handled below:
 *   1. The OHLC arrays contain NULLS — gaps and not-yet-formed bars. Left in,
 *      they would become candles at price 0.
 *   2. `volume` is always 0: forex has no central exchange.
 *   3. There is no bid/ask, so those columns show "—" (same as Twelve Data).
 *   4. Intraday history is capped by interval (7d at 1m, 60d at 5m–30m), so
 *      the range is chosen per timeframe rather than always asking for more.
 *   5. There is NO 4h interval (Yahoo offers 1m/5m/15m/30m/1h/1d), so 4H is
 *      built by resampling 1h bars. That is exact, not an approximation:
 *      four 1h bars tile a 4h bar perfectly.
 *   6. It is an UNOFFICIAL endpoint with no stability guarantee. It is
 *      proxied server-side so a breaking change surfaces in one place.
 */
import { APP_CONFIG } from '../../../config/app';
import type { Timeframe } from '../../../config/timeframes';
import { TIMEFRAME_SECONDS } from '../../../config/timeframes';
import { fetchJson, num } from '../http';
import {
  ProviderError,
  isAbort,
  toProviderError,
  type Candle,
  type MarketDataProvider,
  type QuoteBatch,
} from '../types';

const REST = '/api/yahoo-chart';

/** "EUR/USD" → "EURUSD=X" — Yahoo's currency ticker shape. */
export const toYahooSymbol = (symbol: string) => `${symbol.replace('/', '').toUpperCase()}=X`;

/**
 * Yahoo interval per timeframe. 4H has no native interval, so it is fetched
 * as 1h and resampled — see `resample` below.
 */
const INTERVAL: Record<Timeframe, string> = {
  '1M': '1m',
  '5M': '5m',
  '15M': '15m',
  '30M': '30m',
  '1H': '1h',
  '4H': '1h',
  '1D': '1d',
};

/** Timeframes Yahoo cannot serve directly, and the factor to build them. */
const RESAMPLE: Partial<Record<Timeframe, number>> = { '4H': 4 };

/** Ranges Yahoo accepts, in seconds, smallest first. */
const RANGES: { name: string; seconds: number }[] = [
  { name: '1d', seconds: 86_400 },
  { name: '5d', seconds: 5 * 86_400 },
  { name: '1mo', seconds: 30 * 86_400 },
  { name: '3mo', seconds: 90 * 86_400 },
  { name: '6mo', seconds: 180 * 86_400 },
  { name: '1y', seconds: 365 * 86_400 },
  { name: '2y', seconds: 730 * 86_400 },
  { name: '5y', seconds: 1825 * 86_400 },
  { name: '10y', seconds: 3650 * 86_400 },
];

/**
 * How far back Yahoo serves each interval. Asking for more returns an error
 * rather than being silently truncated, so the request is capped instead.
 */
const MAX_RANGE: Record<Timeframe, string> = {
  '1M': '5d',
  '5M': '1mo',
  '15M': '1mo',
  '30M': '1mo',
  '1H': '2y',
  '4H': '2y', // fetched as 1h
  '1D': '10y',
};

/**
 * Merge every `factor` bars into one, bucketed on absolute time so the bars
 * land on the same boundaries every run (4H → 00:00, 04:00, 08:00 UTC…).
 * A bucket is complete only when every bar in it is.
 */
export function resample(candles: readonly Candle[], bucketSeconds: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const start = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.complete = last.complete && c.complete;
    } else {
      out.push({ time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: null, complete: c.complete });
    }
  }
  return out;
}

/**
 * Smallest range that covers `count` bars, capped at what the interval allows.
 * Forex trades ~5 days in 7, so the calendar span needed is wider than the
 * bar count alone suggests — hence the 1.5 padding.
 */
export function rangeFor(timeframe: Timeframe, count: number): string {
  const needed = count * TIMEFRAME_SECONDS[timeframe] * 1.5;
  const cap = RANGES.findIndex((r) => r.name === MAX_RANGE[timeframe]);
  const capIndex = cap === -1 ? RANGES.length - 1 : cap;
  for (let i = 0; i <= capIndex; i++) {
    if (RANGES[i]!.seconds >= needed) return RANGES[i]!.name;
  }
  return RANGES[capIndex]!.name;
}

interface YahooMeta {
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
  dataGranularity?: string;
}

interface YahooChart {
  chart?: {
    result?:
      | {
          meta?: YahooMeta;
          timestamp?: number[];
          indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** A quote is stale once the market has been quiet for longer than this. */
const MARKET_QUIET_MS = 20 * 60_000;

function unwrap(body: YahooChart, symbol: string) {
  const err = body?.chart?.error;
  if (err) {
    const message = err.description || err.code || 'Yahoo chart error';
    if (err.code === 'Not Found') throw new ProviderError('invalid_symbol', `${symbol}: ${message}`, { symbol });
    throw new ProviderError('provider', message, { symbol });
  }
  const result = body?.chart?.result?.[0];
  if (!result) throw new ProviderError('no_data', `No chart data for ${symbol}`, { symbol });
  return result;
}

export class YahooProvider implements MarketDataProvider {
  readonly id = 'yahoo' as const;
  readonly label = 'Yahoo Finance';
  readonly capabilities = {
    streaming: false,
    bidAsk: false,
    // meta.regularMarketChangePercent is measured against the previous close.
    changeBasis: 'daily-close' as const,
    pollIntervalMs: APP_CONFIG.yahooPollMs,
    candleRefreshMs: Math.max(60_000, APP_CONFIG.yahooPollMs * 2),
  };

  async assertConfigured(): Promise<void> {
    // Nothing to configure: no key, no account. A broken endpoint surfaces on
    // the first quote request rather than costing an extra round-trip here.
  }

  private async chart(symbol: string, interval: string, range: string, signal?: AbortSignal) {
    const qs = new URLSearchParams({ interval, range });
    const body = await fetchJson<YahooChart>(`${REST}/${toYahooSymbol(symbol)}?${qs}`, signal);
    return unwrap(body, symbol);
  }

  /**
   * One chart request per symbol. Sequential rather than parallel: Yahoo has
   * no published rate limit, and a burst of 7 is the kind of thing that gets
   * an unofficial endpoint to start refusing.
   */
  async getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    const batch: QuoteBatch = { quotes: [], failed: [] };
    for (const symbol of symbols) {
      try {
        // A 1-day/1-hour window is the smallest payload that still carries meta.
        const { meta } = await this.chart(symbol, '1h', '1d', signal);
        const price = num(meta?.regularMarketPrice);
        if (price === null) {
          batch.failed.push({ symbol, error: new ProviderError('no_data', `No price for ${symbol}`, { symbol }) });
          continue;
        }
        const receivedAt = Date.now();
        const timestamp = meta?.regularMarketTime ? meta.regularMarketTime * 1000 : receivedAt;
        batch.quotes.push({
          symbol,
          price,
          bid: null,
          ask: null,
          spreadPips: null,
          changePct: num(meta?.regularMarketChangePercent),
          timestamp,
          receivedAt,
          // Forex runs 24/5; a feed that has not moved for 20 minutes means
          // the weekend, not a broken connection.
          marketOpen: receivedAt - timestamp < MARKET_QUIET_MS,
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        const e = toProviderError(err);
        if (e.kind === 'auth' || e.kind === 'rate_limit' || e.kind === 'config') throw e; // systemic
        batch.failed.push({ symbol, error: e });
      }
    }
    return batch;
  }

  async getCandles(symbol: string, timeframe: Timeframe, count: number, signal?: AbortSignal): Promise<Candle[]> {
    // 4H is built from 1h bars, so four times as many are needed.
    const sourceBars = count * (RESAMPLE[timeframe] ?? 1);
    let result;
    try {
      result = await this.chart(symbol, INTERVAL[timeframe], rangeFor(timeframe, sourceBars), signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw toProviderError(err);
    }

    const times = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const candles: Candle[] = [];

    for (let i = 0; i < times.length; i++) {
      const o = num(q.open?.[i]);
      const h = num(q.high?.[i]);
      const l = num(q.low?.[i]);
      const c = num(q.close?.[i]);
      const t = times[i];
      // Yahoo pads the arrays with nulls for gaps and bars that have not
      // formed. Skipping them is the difference between real candles and
      // a chart full of zeros.
      if (o === null || h === null || l === null || c === null || !Number.isFinite(t)) continue;
      candles.push({
        time: Math.floor(t!),
        open: o,
        high: h,
        low: l,
        close: c,
        volume: null, // forex has no exchange volume; Yahoo reports 0
        complete: true,
      });
    }

    // The newest surviving bar is the one still forming.
    const last = candles[candles.length - 1];
    if (last) last.complete = false;

    const factor = RESAMPLE[timeframe];
    const merged = factor ? resample(candles, TIMEFRAME_SECONDS[timeframe]) : candles;
    return merged.slice(-count);
  }
}

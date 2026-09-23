/**
 * Historical candles from Yahoo Finance — no account, no API key, no credits.
 *
 *   GET /api/yahoo-chart?symbol=EURUSD=X&interval=1h&range=1mo
 *     → timestamp:            UNIX seconds, one per bar
 *     → indicators.quote[0]:  open[] high[] low[] close[] volume[]
 *
 * Why only candles, and not quotes too: see server/yahoo.mjs. In short, an
 * unofficial endpoint polled every 60 seconds from a serverless IP is what
 * gets an unofficial endpoint to stop answering; a chart opened now and then
 * is not.
 *
 * THE CATCHES, all handled below:
 *   1. The OHLC arrays contain NULLS — gaps and not-yet-formed bars. Left in,
 *      they would become candles at price 0.
 *   2. `volume` is always 0: forex has no central exchange, so it is dropped
 *      rather than charted as a real figure.
 *   3. Intraday history is capped by interval, so the range is chosen per
 *      timeframe instead of always asking for the maximum.
 *   4. There is NO 4h interval (Yahoo offers 1m/5m/15m/30m/1h/1d), so 4H is
 *      built by resampling 1h bars. That is exact, not an approximation:
 *      four 1h bars tile a 4h bar perfectly.
 *   5. It is an UNOFFICIAL endpoint with no stability guarantee, which is why
 *      nothing depends on it — YahooCandleRouter falls back to Twelve Data.
 */
import type { Timeframe } from '../../../config/timeframes';
import { TIMEFRAME_SECONDS } from '../../../config/timeframes';
import { fetchJson, num } from '../http';
import { ProviderError, isAbort, toProviderError, type Candle } from '../types';

const REST = '/api/yahoo-chart';

/** "EUR/USD" → "EURUSD=X" — Yahoo's currency ticker shape. */
export const toYahooSymbol = (symbol: string) => `${symbol.replace('/', '').toUpperCase()}=X`;

/**
 * Yahoo interval per timeframe. 4H has no native interval, so it is fetched
 * as 1h and resampled — see `resample` below.
 */
const INTERVAL: Record<Timeframe, string> = {
  '30M': '30m',
  '1H': '1h',
  '4H': '1h',
  '1D': '1d',
};

/** Timeframes with no native Yahoo interval, and the bar they are built from. */
const RESAMPLED = new Set<Timeframe>(['4H']);

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
 * 4H is capped by the 1h bars it is built from.
 */
const MAX_RANGE: Record<Timeframe, string> = {
  '30M': '1mo',
  '1H': '2y',
  '4H': '2y', // fetched as 1h
  '1D': '10y',
};

/**
 * Merge bars into `bucketSeconds` buckets, aligned on absolute time so they
 * land on the same boundaries every run (4H → 00:00, 04:00, 08:00 UTC…).
 * A bucket is complete only when every bar in it is.
 *
 * Note this can put a 4H bar on a different boundary than Twelve Data's own
 * 4H series, which is anchored to exchange time. The bars are correct either
 * way; they are just not interchangeable mid-chart, which is why a fallback
 * refetches the whole series rather than splicing.
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
 * Smallest range that covers `count` bars of `timeframe`, capped at what the
 * interval allows.
 *
 * The span is computed from the TARGET timeframe even when the bars are
 * fetched smaller and resampled: 300 4H bars cover the same 50 days whether
 * they arrive as 300 4H bars or 1200 1H ones. Multiplying by the resample
 * factor as well would ask for four times the history nobody wants.
 *
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

interface YahooChart {
  chart?: {
    result?:
      | {
          meta?: { symbol?: string };
          timestamp?: number[];
          indicators?: {
            quote?: {
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
            }[];
          };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** Yahoo reports failures inside the body as well as by status code. */
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

/**
 * Fetch `count` candles. Throws a ProviderError on any failure — the caller
 * decides whether to fall back, because only it knows what that costs.
 */
export async function fetchYahooCandles(
  symbol: string,
  timeframe: Timeframe,
  count: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const qs = new URLSearchParams({
    symbol: toYahooSymbol(symbol),
    interval: INTERVAL[timeframe],
    range: rangeFor(timeframe, count),
  });

  let result;
  try {
    result = unwrap(await fetchJson<YahooChart>(`${REST}?${qs}`, signal), symbol);
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
    // formed. Skipping them is the difference between real candles and a
    // chart full of zeros.
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

  if (candles.length === 0) throw new ProviderError('no_data', `No ${timeframe} candles for ${symbol}`, { symbol });

  // The newest surviving bar is the one still forming.
  candles[candles.length - 1]!.complete = false;

  const merged = RESAMPLED.has(timeframe) ? resample(candles, TIMEFRAME_SECONDS[timeframe]) : candles;
  return merged.slice(-count);
}

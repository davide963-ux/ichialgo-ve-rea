/**
 * Twelve Data's `time_series` shape: the query, and the parse. Nothing else.
 *
 * WHY THIS IS NOT IN TwelveDataProvider.ts
 * ────────────────────────────────────────
 * The server-side scanner needs these two functions, and it gets them through
 * the esbuild bundle (see src/services/strategy/serverEntry.ts). The provider
 * class imports APP_CONFIG, which reads `import.meta.env` — a Vite-only
 * construct that is `undefined` under plain Node. Exporting these from there
 * pulled the whole browser config into the bundle and the scanner died on
 * import with "Cannot read properties of undefined (reading
 * VITE_TWELVEDATA_POLL_MS)".
 *
 * So the pure part lives here, with no config, no transport and no DOM, and
 * both sides import it: the provider for the browser, the bundle for the
 * scanner. One definition of what a Twelve Data bar is.
 */
import type { Timeframe } from '../../../config/timeframes';
import { parseUtcDateTime } from '../../../lib/time';
import { num } from '../http';
import { ProviderError, type Candle } from '../types';

/** Our timeframe names to Twelve Data's interval names. */
const INTERVAL: Record<Timeframe, string> = {
  '30M': '30min',
  '1H': '1h',
  '4H': '4h',
  '1D': '1day',
};

interface TdError {
  status: 'error';
  code?: number;
  message?: string;
}

interface TdSeries {
  values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
}

export const isTdError = (v: unknown): v is TdError =>
  !!v && typeof v === 'object' && (v as { status?: unknown }).status === 'error';

export function mapTdError(e: TdError, symbol?: string): ProviderError {
  const message = e.message ?? 'Twelve Data error';
  switch (e.code) {
    case 401:
    case 403:
      return new ProviderError(
        'auth',
        'Twelve Data rejected the API key. Check TWELVEDATA_API_KEY in .env, then restart the dev server.',
      );
    case 429:
      // The proxy's own pool-exhausted message names the key count — keep it.
      return new ProviderError('rate_limit', message || 'Twelve Data credit limit reached', { retryAfterMs: 60_000 });
    case 400:
    case 404:
      return new ProviderError('invalid_symbol', symbol ? `${symbol}: ${message}` : message, { symbol });
    default:
      return new ProviderError('provider', message, { symbol });
  }
}

/**
 * The query string for one candle request.
 *
 * Separate from the fetch because the scanner talks to Twelve Data directly
 * with its own API key rather than through this app's proxy, and both must
 * ask for the same interval, size and ordering.
 */
export function tdSeriesQuery(symbol: string, timeframe: Timeframe, count: number): URLSearchParams {
  return new URLSearchParams({
    symbol,
    interval: INTERVAL[timeframe],
    outputsize: String(Math.min(Math.max(count, 1), 5000)),
    order: 'asc',
    timezone: 'UTC',
  });
}

/**
 * Turn a `time_series` body into candles.
 *
 * Twelve Data reports failures INSIDE the body with HTTP 200, so the error
 * check is part of parsing rather than something a caller might forget.
 * Without it, "invalid API key" and "credit limit reached" would both read as
 * "no candles today" — and on the server that means a silent failover to
 * nothing instead of to the next key.
 */
export function parseTdSeries(body: unknown, symbol?: string): Candle[] {
  if (isTdError(body)) throw mapTdError(body, symbol);

  const values = (body as TdSeries).values ?? [];
  const candles: Candle[] = [];
  values.forEach((v, i) => {
    const o = num(v.open),
      h = num(v.high),
      l = num(v.low),
      c = num(v.close);
    const t = parseUtcDateTime(v.datetime);
    if (o === null || h === null || l === null || c === null || !Number.isFinite(t)) return;
    candles.push({
      time: Math.floor(t / 1000),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: num(v.volume),
      complete: i < values.length - 1, // newest bar is still forming
    });
  });
  return candles;
}

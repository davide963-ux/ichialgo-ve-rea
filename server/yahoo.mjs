/**
 * Yahoo Finance chart endpoint: free historical candles, zero Twelve Data
 * credits.
 *
 * WHY IT IS BACK
 * ──────────────
 * Yahoo was removed in #10 because it could not be the app's ONLY source:
 * the endpoint is unofficial and is known to answer 429 to datacenter IPs,
 * which is what a Vercel function is. That verdict still stands for quotes —
 * 7 pairs polled every 60 seconds, forever, from a serverless IP is exactly
 * the traffic shape that gets an unofficial endpoint to start refusing.
 *
 * Candles are a completely different request profile. A chart is opened, and
 * the bars behind it barely change: one request per pair per timeframe, and
 * now behind the 15-minute response cache as well. That is a handful of
 * requests an hour, not hundreds.
 *
 * So Yahoo serves candles when it will, and Twelve Data serves them when it
 * will not — see YahooCandleRouter on the client. When Yahoo answers, the
 * chart costs nothing; when it refuses, nothing is lost but one round trip.
 *
 *   GET /api/yahoo-chart?symbol=EURUSD=X&interval=1h&range=1mo
 *     → meta:                 symbol metadata
 *     → timestamp:            UNIX seconds, one per bar
 *     → indicators.quote[0]:  open[] high[] low[] close[] volume[]
 *
 * THE SYMBOL TRAVELS AS A QUERY PARAMETER, not a path segment: Yahoo tickers
 * contain '=' ("EURUSD=X"), and a static route is one less thing for a host's
 * router to normalise on the way through. That also makes the route a BARE
 * /api/yahoo-chart, which on Vercel needs a static api/yahoo-chart.js and not
 * a [...path] catch-all — getting that wrong is what made this route 404 in
 * production once already (see server/api.routes.test.mjs).
 */

/** Yahoo rejects a default client user-agent, so the proxy sends a browser one. */
export const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export const YAHOO_REST_DEFAULT = 'https://query1.finance.yahoo.com';

/** Yahoo tickers for currencies are exactly six letters plus "=X". */
const YAHOO_SYMBOL = /^[A-Z]{6}=X$/;

/**
 * Only the intervals this app asks for. Yahoo offers more; forwarding an
 * interval nothing requests would just be an extra way to be wrong.
 * 4H has no native Yahoo interval and is resampled from 1h on the client.
 */
const YAHOO_INTERVAL = new Set(['30m', '1h', '1d']);

/** Ranges rangeFor() can produce, and nothing else. */
const YAHOO_RANGE = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y']);

/**
 * Rebuild the upstream path from validated parts.
 *
 * Returns null when anything is off, which the middleware turns into a 403 —
 * so an arbitrary symbol, interval or range can never be pasted into a URL
 * this server then fetches.
 */
export function yahooUpstreamPath(query) {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const symbol = (params.get('symbol') || '').toUpperCase();
  const interval = params.get('interval') || '1d';
  const range = params.get('range') || '1mo';
  if (!YAHOO_SYMBOL.test(symbol) || !YAHOO_INTERVAL.has(interval) || !YAHOO_RANGE.has(range)) return null;
  return `/v8/finance/chart/${symbol}?${new URLSearchParams({ interval, range })}`;
}

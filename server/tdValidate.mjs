/**
 * What the proxy is willing to ask Twelve Data for.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The proxy holds the API keys, so anyone who finds its URL can spend your
 * credits. Before this, `/api/td-rest/quote?symbol=` forwarded ANY symbol
 * upstream: a request for a hundred equities was a hundred credits off your
 * daily budget, paid by you, for someone else's data. The endpoint allowlist
 * stopped arbitrary ENDPOINTS being reached; it said nothing about arguments.
 *
 * WHY A SHAPE CHECK RATHER THAN A PAIR LIST
 * ─────────────────────────────────────────
 * Hard-coding the seven configured pairs here would mean the proxy silently
 * rejects any pair someone adds to `src/config/pairs.ts` — a failure that
 * looks like a data outage and is nobody's obvious fault.
 *
 * So the rule is structural instead: a symbol must be two known ISO-4217
 * currency codes separated by a slash. That admits every forex pair the app
 * could reasonably be configured for, and refuses equities, crypto and
 * anything else that would be somebody using this as a free API key. The
 * batch cap then bounds what a single accepted request can cost.
 */

/** Currencies with a liquid spot FX market. Not exhaustive by design. */
const CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR',
  'MXN', 'SGD', 'HKD', 'CNH', 'CNY', 'INR', 'KRW', 'THB',
]);

/** Intervals the app actually requests. See config/timeframes.ts. */
const INTERVALS = new Set(['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week', '1month']);

/**
 * Most symbols one request may price.
 *
 * Twelve Data charges one credit PER SYMBOL on /quote, so an unbounded batch
 * is an unbounded bill. Twelve is comfortably above the seven pairs the app
 * polls and far below anything worth abusing.
 */
export const MAX_SYMBOLS = 12;

/** Hard ceiling on candles per request, whatever the caller asked for. */
export const MAX_OUTPUTSIZE = 5000;

const isPair = (s) => {
  const parts = s.split('/');
  return parts.length === 2 && parts.every((c) => CURRENCIES.has(c));
};

/**
 * Check and normalise a Twelve Data request path.
 *
 * Returns `{ ok: true, path }` with the cleaned path, or `{ ok: false, error }`
 * describing the refusal. The path is rebuilt from validated parameters rather
 * than patched, so nothing unexamined survives into the upstream request.
 */
export function validateTdRequest(rawPath) {
  const [endpoint, queryString = ''] = rawPath.split('?');
  const params = new URLSearchParams(queryString);

  // `_status` is answered locally and never reaches Twelve Data.
  if (endpoint.startsWith('/_status')) return { ok: true, path: rawPath };

  const symbolRaw = (params.get('symbol') || '').trim();
  if (!symbolRaw) return { ok: false, error: 'A symbol is required.' };

  const symbols = symbolRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return { ok: false, error: 'A symbol is required.' };
  if (symbols.length > MAX_SYMBOLS) {
    return { ok: false, error: `At most ${MAX_SYMBOLS} symbols per request; asked for ${symbols.length}.` };
  }

  const bad = symbols.filter((s) => !isPair(s));
  if (bad.length > 0) {
    return { ok: false, error: `Not a supported currency pair: ${bad.slice(0, 3).join(', ')}` };
  }

  const out = new URLSearchParams();
  out.set('symbol', symbols.join(','));

  const interval = params.get('interval');
  if (interval !== null) {
    if (!INTERVALS.has(interval)) return { ok: false, error: `Unsupported interval: ${interval}` };
    out.set('interval', interval);
  } else if (endpoint.startsWith('/time_series')) {
    return { ok: false, error: 'time_series requires an interval.' };
  }

  const outputsize = params.get('outputsize');
  if (outputsize !== null) {
    const n = Number.parseInt(outputsize, 10);
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: 'outputsize must be a positive integer.' };
    out.set('outputsize', String(Math.min(n, MAX_OUTPUTSIZE)));
  }

  // Passed through because they change the response and cost nothing.
  for (const key of ['timezone', 'order', 'dp']) {
    const v = params.get(key);
    if (v) out.set(key, v);
  }

  return { ok: true, path: `${endpoint}?${out.toString()}` };
}

/**
 * Ichialgo market-data proxy (read-only).
 *
 * Used by BOTH the Vite dev/preview server (vite.config.ts) and the production
 * server (server/index.mjs), so every environment behaves the same.
 *
 * WHY:
 *  1. Provider credentials never reach the browser. They are read from .env
 *     (no VITE_ prefix) and injected here, server-side.
 *  2. An OANDA token can PLACE ORDERS. So this proxy forwards ONLY an explicit
 *     allowlist of GET endpoints. Anything else is rejected with 403/405, which
 *     also blocks a malicious website from POSTing orders to your localhost.
 *
 *   browser path                                 upstream
 *   GET /api/oanda-rest/account/summary       →  {rest}/v3/accounts/{id}/summary
 *   GET /api/oanda-rest/account/pricing       →  {rest}/v3/accounts/{id}/pricing
 *   GET /api/oanda-rest/instruments/X_Y/candles → {rest}/v3/instruments/X_Y/candles
 *   GET /api/oanda-stream/account/pricing/stream → {stream}/v3/accounts/{id}/pricing/stream
 *   GET /api/td-rest/quote | time_series      →  https://api.twelvedata.com/…
 *   GET /api/td-rest/_status                  →  local key-pool report (no upstream call)
 *   GET /api/yahoo-chart?symbol=EURUSD=X      →  https://query1.finance.yahoo.com/v8/finance/chart/…
 *
 * Twelve Data requests are NOT proxied blindly: they go through a key pool
 * (server/twelveDataKeyPool.mjs) that fails over to the next API key when one
 * runs out of credits. That needs the response BODY (Twelve Data reports
 * "out of credits" with HTTP 200 + {status:"error",code:429}), which a stream
 * proxy cannot inspect — hence the explicit fetch below.
 */
import { createProxyMiddleware } from 'http-proxy-middleware';
import { TwelveDataKeyPool, classifyResponse, readApiKeys } from './twelveDataKeyPool.mjs';

const OANDA = {
  practice: { rest: 'https://api-fxpractice.oanda.com', stream: 'https://stream-fxpractice.oanda.com' },
  live: { rest: 'https://api-fxtrade.oanda.com', stream: 'https://stream-fxtrade.oanda.com' },
};

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function stripClientHeaders(proxyReq) {
  // Never forward browser credentials/identity upstream.
  for (const h of ['cookie', 'authorization', 'origin', 'referer']) proxyReq.removeHeader(h);
}

const YAHOO_REST_DEFAULT = 'https://query1.finance.yahoo.com';

/**
 * Yahoo's chart endpoint needs no key, which is the whole reason it is here:
 * it is the only forex OHLC source that works without a broker account, and
 * brokers are licensed per country. It DOES reject requests with a default
 * client user-agent, so the proxy sends a browser one.
 *
 * This is an unofficial endpoint with no stability guarantee. It is proxied
 * like everything else so the browser never talks to a third party directly,
 * and so a change upstream shows up in one place.
 *
 * The symbol travels as a QUERY PARAMETER, not a path segment. Yahoo tickers
 * contain '=' ("EURUSD=X"), and a static route is one less thing for a host's
 * router or a catch-all to normalise on the way through.
 */
const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const TD_MISSING =
  'Set TWELVEDATA_API_KEY (or TWELVEDATA_API_KEYS with several comma-separated keys) in .env, then restart the server.';

/**
 * Credits a Twelve Data request will cost: 1 per symbol on /quote, 1 on
 * /time_series. Used to skip a key that cannot pay for the whole batch.
 */
function estimateCredits(path) {
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const symbol = new URLSearchParams(query).get('symbol') || '';
  if (!path.startsWith('/quote')) return 1;
  const n = symbol.split(',').filter((s) => s.trim()).length;
  return Math.max(1, n);
}

/** Yahoo tickers are exactly six letters plus "=X" — e.g. EURUSD=X. */
const YAHOO_SYMBOL = /^[A-Z]{6}=X$/;
const YAHOO_INTERVAL = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d']);
const YAHOO_RANGE = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

/**
 * Rebuild the upstream path from validated parts. Returns null when anything
 * is off, which the middleware turns into a 403 — so an arbitrary symbol or
 * interval can never be pasted into a URL we then fetch.
 */
export function yahooUpstreamPath(query) {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const symbol = (params.get('symbol') || '').toUpperCase();
  const interval = params.get('interval') || '1d';
  const range = params.get('range') || '1mo';
  if (!YAHOO_SYMBOL.test(symbol) || !YAHOO_INTERVAL.has(interval) || !YAHOO_RANGE.has(range)) return null;
  return `/v8/finance/chart/${symbol}?${new URLSearchParams({ interval, range })}`;
}

/** Diagnostics for the browser/devtools. Never exposes key material. */
function setPoolHeaders(res, pool, usedIndex) {
  if (res.headersSent) return;
  const snap = pool.snapshot();
  res.setHeader('X-TD-Keys-Total', String(snap.keys));
  res.setHeader('X-TD-Keys-Available', String(snap.available));
  res.setHeader('X-TD-Credits-Used-Today', String(snap.usedToday));
  if (usedIndex !== undefined) res.setHeader('X-TD-Key-Used', String(usedIndex + 1));
}

function onUpstreamError(err, _req, res) {
  if (res && typeof res.setHeader === 'function') {
    sendJson(res, 502, { errorMessage: `Provider unreachable (${err.code || err.message})` });
  }
}

export function readConfig(env) {
  const envName = (env.OANDA_ENV || 'practice').trim().toLowerCase() === 'live' ? 'live' : 'practice';
  return {
    oanda: {
      token: (env.OANDA_API_TOKEN || '').trim(),
      accountId: (env.OANDA_ACCOUNT_ID || '').trim(),
      env: envName,
      // Overrides exist for local testing against a mock server only.
      rest: (env.OANDA_REST_URL || OANDA[envName].rest).trim(),
      stream: (env.OANDA_STREAM_URL || OANDA[envName].stream).trim(),
    },
    yahoo: {
      // Override exists for local testing against a mock server only.
      rest: (env.YAHOO_REST_URL || YAHOO_REST_DEFAULT).trim(),
    },
    twelvedata: {
      /** Failover order. One key per Twelve Data account — see .env.example. */
      keys: readApiKeys(env),
      /**
       * Free Basic plan limits, PER KEY. 0 = no daily cap (paid plans).
       * The VITE_-prefixed spelling is the one the browser meter already uses,
       * so a single .env entry configures both sides.
       */
      creditsPerMinute: Math.max(1, Number(env.TWELVEDATA_CREDITS_PER_MINUTE ?? env.VITE_TWELVEDATA_CREDITS_PER_MINUTE ?? 8) || 8),
      creditsPerDay: Math.max(0, Number(env.TWELVEDATA_CREDITS_PER_DAY ?? env.VITE_TWELVEDATA_CREDITS_PER_DAY ?? 800) || 0),
      rest: (env.TWELVEDATA_REST_URL || 'https://api.twelvedata.com').trim(),
    },
  };
}

export function createMarketDataApi(env = process.env) {
  const cfg = readConfig(env);
  const account = encodeURIComponent(cfg.oanda.accountId);

  const oandaHeaders = (proxyReq) => {
    stripClientHeaders(proxyReq);
    proxyReq.setHeader('Authorization', `Bearer ${cfg.oanda.token}`);
    proxyReq.setHeader('Accept-Datetime-Format', 'RFC3339');
  };

  const oandaRest = createProxyMiddleware({
    target: cfg.oanda.rest,
    changeOrigin: true,
    proxyTimeout: 15_000,
    on: { proxyReq: oandaHeaders, error: onUpstreamError },
  });

  const oandaStream = createProxyMiddleware({
    target: cfg.oanda.stream,
    changeOrigin: true,
    // Long-lived chunked response: no proxy timeout, no buffering.
    on: {
      proxyReq: oandaHeaders,
      proxyRes: (_proxyRes, _req, res) => {
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-store');
      },
      error: onUpstreamError,
    },
  });

  const tdPool = new TwelveDataKeyPool({
    keys: cfg.twelvedata.keys,
    perMinute: cfg.twelvedata.creditsPerMinute,
    perDay: cfg.twelvedata.creditsPerDay,
  });

  /**
   * Twelve Data with key failover.
   *
   *   request ──▶ acquire() ──┬── key #1 has credits ──▶ fetch ──┬── ok ──────▶ forward body
   *                           │                                  ├── 429/credits ─┐
   *                           │                                  └── 401/403 ─────┤ park key,
   *                           ├── #1 spent ─▶ key #2 ─▶ fetch ─▶ …                │ next key
   *                           └── every key spent ─▶ 429 {message: "all N keys…"} ◀┘
   *
   * Non-credit errors (bad symbol, upstream 500) are forwarded untouched — they
   * would fail the same way on every key, so rotating would only burn credits.
   */
  async function tdRest(req, res) {
    const path = req.url || '/';
    const cost = estimateCredits(path);
    const tried = [];

    for (let attempt = 0; attempt < tdPool.size; attempt++) {
      const lease = tdPool.acquire(cost);
      if (!lease) break;
      tdPool.spend(lease.index, cost);
      tried.push(lease.label);

      let upstream;
      let text;
      try {
        upstream = await fetch(`${cfg.twelvedata.rest}${path}`, {
          headers: { Accept: 'application/json', Authorization: `apikey ${lease.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        text = await upstream.text();
      } catch (err) {
        // Network/timeout: not a credit problem, so do not rotate keys.
        return sendJson(res, 502, { errorMessage: `Provider unreachable (${err.code || err.message})` });
      }

      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON upstream body — forwarded as-is below */
      }
      const verdict = classifyResponse(upstream.status, body);
      const message = body && typeof body.message === 'string' ? body.message : '';

      if (verdict === 'exhausted' || verdict === 'auth') {
        tdPool.penalize(lease.index, verdict, message);
        continue; // …next key
      }

      tdPool.reportSuccess(lease.index);
      if (res.headersSent) return;
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      setPoolHeaders(res, tdPool, lease.index);
      return res.end(text);
    }

    const snapshot = tdPool.snapshot();
    const retryAfterMs = snapshot.retryAfterMs ?? 60_000;
    setPoolHeaders(res, tdPool);
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return sendJson(res, 429, {
      status: 'error',
      code: 429,
      // Shown verbatim in the app's status banner.
      message:
        tdPool.size === 1
          ? 'Twelve Data credit limit reached on the only configured API key. Add TWELVEDATA_API_KEYS with more keys to extend the budget.'
          : `All ${tdPool.size} Twelve Data API keys are out of credits (${snapshot.usedToday} credits used today).`,
      errorMessage: `Twelve Data key pool exhausted after trying: ${tried.join(', ') || 'no usable key'}.`,
    });
  }

  /** Yahoo chart: no credentials, just a user-agent and a pass-through. */
  async function yahooChart(req, res) {
    const path = req.url || '/';
    let upstream;
    let text;
    try {
      upstream = await fetch(`${cfg.yahoo.rest}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': YAHOO_UA },
        signal: AbortSignal.timeout(15_000),
      });
      text = await upstream.text();
    } catch (err) {
      return sendJson(res, 502, { errorMessage: `Provider unreachable (${err.code || err.message})` });
    }
    if (res.headersSent) return;
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(text);
  }

  function tdStatus(_req, res) {
    return sendJson(res, 200, tdPool.snapshot());
  }

  const routes = [
    {
      re: /^\/api\/oanda-rest\/account\/(summary|pricing)(\?.*)?$/,
      ready: () => cfg.oanda.token && cfg.oanda.accountId,
      missing: 'Set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in .env, then restart the server.',
      to: (m) => `/v3/accounts/${account}/${m[1]}${m[2] ?? ''}`,
      proxy: oandaRest,
    },
    {
      re: /^\/api\/oanda-rest\/instruments\/([A-Z]{3}_[A-Z]{3})\/candles(\?.*)?$/,
      ready: () => cfg.oanda.token,
      missing: 'Set OANDA_API_TOKEN in .env, then restart the server.',
      to: (m) => `/v3/instruments/${m[1]}/candles${m[2] ?? ''}`,
      proxy: oandaRest,
    },
    {
      re: /^\/api\/oanda-stream\/account\/pricing\/stream(\?.*)?$/,
      ready: () => cfg.oanda.token && cfg.oanda.accountId,
      missing: 'Set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in .env, then restart the server.',
      to: (m) => `/v3/accounts/${account}/pricing/stream${m[1] ?? ''}`,
      proxy: oandaStream,
    },
    {
      re: /^\/api\/td-rest\/(quote|time_series)(\?.*)?$/,
      ready: () => tdPool.size > 0,
      missing: TD_MISSING,
      to: (m) => `/${m[1]}${m[2] ?? ''}`,
      proxy: tdRest,
    },
    {
      // Static path, symbol in the query. `to` rebuilds the upstream URL from
      // validated parts only, so nothing the caller sends is pasted into it.
      re: /^\/api\/yahoo-chart(\?.*)?$/,
      ready: () => true,
      missing: '',
      to: (m) => yahooUpstreamPath(m[1] ?? ''),
      proxy: yahooChart,
    },
    {
      // Key-pool report for the client-side credit meter. Costs no credits:
      // it never touches Twelve Data.
      re: /^\/api\/td-rest\/_status(\?.*)?$/,
      ready: () => tdPool.size > 0,
      missing: TD_MISSING,
      to: (m) => `/_status${m[1] ?? ''}`,
      proxy: tdStatus,
    },
  ];

  /** Connect/Express middleware. Mount at the root. */
  function middleware(req, res, next) {
    const url = req.url || '';
    if (!url.startsWith('/api/')) return next();

    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', errorMessage: 'The market-data proxy is read-only (GET only).' });
    }
    for (const route of routes) {
      const m = url.match(route.re);
      if (!m) continue;
      if (!route.ready()) {
        return sendJson(res, 503, { error: 'NOT_CONFIGURED', errorMessage: route.missing });
      }
      const target = route.to(m);
      if (target === null) {
        return sendJson(res, 403, { error: 'FORBIDDEN_PATH', errorMessage: `Rejected request to ${url.split('?')[0]}` });
      }
      req.url = target;
      // Handlers may be async (Twelve Data key failover); never let a rejection
      // hang the request.
      return Promise.resolve(route.proxy(req, res, next)).catch((err) => {
        sendJson(res, 502, { errorMessage: `Market-data proxy error (${err?.message || err})` });
      });
    }
    return sendJson(res, 403, { error: 'FORBIDDEN_PATH', errorMessage: `Not on the read-only allowlist: ${url.split('?')[0]}` });
  }

  return { middleware, config: cfg };
}

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
 */
import { createProxyMiddleware } from 'http-proxy-middleware';

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
    twelvedata: {
      apiKey: (env.TWELVEDATA_API_KEY || '').trim(),
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

  const tdRest = createProxyMiddleware({
    target: cfg.twelvedata.rest,
    changeOrigin: true,
    proxyTimeout: 15_000,
    on: {
      proxyReq: (proxyReq) => {
        stripClientHeaders(proxyReq);
        proxyReq.setHeader('Authorization', `apikey ${cfg.twelvedata.apiKey}`);
      },
      error: onUpstreamError,
    },
  });

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
      ready: () => cfg.twelvedata.apiKey,
      missing: 'Set TWELVEDATA_API_KEY in .env, then restart the server.',
      to: (m) => `/${m[1]}${m[2] ?? ''}`,
      proxy: tdRest,
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
      req.url = route.to(m);
      return route.proxy(req, res, next);
    }
    return sendJson(res, 403, { error: 'FORBIDDEN_PATH', errorMessage: `Not on the read-only allowlist: ${url.split('?')[0]}` });
  }

  return { middleware, config: cfg };
}

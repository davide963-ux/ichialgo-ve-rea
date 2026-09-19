/**
 * Ichialgo market-data proxy (read-only).
 *
 * Used by BOTH the Vite dev/preview server (vite.config.ts) and the production
 * server (server/index.mjs), so every environment behaves the same.
 *
 * WHY:
 *  1. The API keys never reach the browser. They are read from .env (no VITE_
 *     prefix) and injected here, server-side.
 *  2. The proxy forwards ONLY an explicit allowlist of GET endpoints. Anything
 *     else is rejected with 403/405.
 *
 *   browser path                          upstream
 *   GET /api/td-rest/quote             →  https://api.twelvedata.com/quote
 *   GET /api/td-rest/time_series       →  https://api.twelvedata.com/time_series
 *   GET /api/td-rest/_status           →  local key-pool report (no upstream call)
 *
 * Twelve Data requests are NOT proxied blindly: they go through a key pool
 * (server/twelveDataKeyPool.mjs) that fails over to the next API key when one
 * runs out of credits. That needs the response BODY (Twelve Data reports
 * "out of credits" with HTTP 200 + {status:"error",code:429}), which a stream
 * proxy cannot inspect — hence the explicit fetch below.
 */
import { TwelveDataKeyPool, classifyResponse, readApiKeys } from './twelveDataKeyPool.mjs';

const TD_MISSING =
  'Set TWELVEDATA_API_KEY (or TWELVEDATA_API_KEYS with several comma-separated keys) in .env, then restart the server.';

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

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

/** Diagnostics for the browser/devtools. Never exposes key material. */
function setPoolHeaders(res, pool, usedIndex) {
  if (res.headersSent) return;
  const snap = pool.snapshot();
  res.setHeader('X-TD-Keys-Total', String(snap.keys));
  res.setHeader('X-TD-Keys-Available', String(snap.available));
  res.setHeader('X-TD-Credits-Used-Today', String(snap.usedToday));
  if (usedIndex !== undefined) res.setHeader('X-TD-Key-Used', String(usedIndex + 1));
}

export function readConfig(env) {
  return {
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
      // Override exists for local testing against a mock server only.
      rest: (env.TWELVEDATA_REST_URL || 'https://api.twelvedata.com').trim(),
    },
  };
}

export function createMarketDataApi(env = process.env) {
  const cfg = readConfig(env);

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

  function tdStatus(_req, res) {
    return sendJson(res, 200, tdPool.snapshot());
  }

  const routes = [
    {
      re: /^\/api\/td-rest\/(quote|time_series)(\?.*)?$/,
      ready: () => tdPool.size > 0,
      missing: TD_MISSING,
      to: (m) => `/${m[1]}${m[2] ?? ''}`,
      proxy: tdRest,
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
      // Handlers are async (Twelve Data key failover); never let a rejection
      // hang the request.
      return Promise.resolve(route.proxy(req, res, next)).catch((err) => {
        sendJson(res, 502, { errorMessage: `Market-data proxy error (${err?.message || err})` });
      });
    }
    return sendJson(res, 403, { error: 'FORBIDDEN_PATH', errorMessage: `Not on the read-only allowlist: ${url.split('?')[0]}` });
  }

  return { middleware, config: cfg };
}

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
 * Two things sit in front of every upstream call, and both exist because the
 * proxy holds the API keys and therefore spends real money:
 *
 *   validateTdRequest  refuses symbols that are not currency pairs, caps the
 *                      batch size and clamps outputsize, so the proxy cannot
 *                      be used as somebody else's free API key.
 *   responseCache      serves repeats from memory, so N tabs asking for the
 *                      same quote cost one credit rather than N.
 *
 * Twelve Data requests are NOT proxied blindly: they go through a key pool
 * (server/twelveDataKeyPool.mjs) that fails over to the next API key when one
 * runs out of credits. That needs the response BODY (Twelve Data reports
 * "out of credits" with HTTP 200 + {status:"error",code:429}), which a stream
 * proxy cannot inspect — hence the explicit fetch below.
 */
import { TwelveDataKeyPool, classifyResponse, readApiKeys } from './twelveDataKeyPool.mjs';
import { createResponseCache } from './responseCache.mjs';
import { validateTdRequest } from './tdValidate.mjs';

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
      /**
       * How long a successful response may be reused. Set either to 0 to
       * disable caching for that shape — useful when debugging a data issue,
       * expensive to leave off.
       */
      quoteCacheMs: Math.max(0, Number(env.TWELVEDATA_QUOTE_CACHE_MS ?? 60_000) || 0),
      seriesCacheMs: Math.max(0, Number(env.TWELVEDATA_SERIES_CACHE_MS ?? 900_000) || 0),
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

  const tdCache = createResponseCache({
    quoteTtlMs: cfg.twelvedata.quoteCacheMs,
    seriesTtlMs: cfg.twelvedata.seriesCacheMs,
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
    const rawPath = req.url || '/';

    // ── Guard ──────────────────────────────────────────────────────────────
    // Before a single credit is committed: is this a request we are willing
    // to pay for? Rejections are 400, not 403 — the caller asked for
    // something unsupported, they were not denied access to something real.
    const check = validateTdRequest(rawPath);
    if (!check.ok) {
      return sendJson(res, 400, { status: 'error', code: 400, message: check.error, errorMessage: check.error });
    }
    const path = check.path;
    const cost = estimateCredits(path);

    // ── Cache ──────────────────────────────────────────────────────────────
    // `serve` returns a cached payload, joins a request already upstream, or
    // runs the key-pool loop below exactly once.
    const tried = [];
    const { payload, cached } = await tdCache.serve(path, async () => {
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
          return {
            cacheable: false,
            payload: { kind: 'error', status: 502, body: { errorMessage: `Provider unreachable (${err.code || err.message})` } },
          };
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
        return {
          // Only a genuinely good response is worth reusing. Caching an error
          // would turn one bad minute into a whole TTL of bad minutes, and an
          // error is precisely what a caller should be free to retry.
          cacheable: upstream.ok && verdict === 'ok',
          payload: {
            kind: 'upstream',
            status: upstream.status,
            contentType: upstream.headers.get('content-type') || 'application/json; charset=utf-8',
            text,
            keyIndex: lease.index,
          },
        };
      }

      const snapshot = tdPool.snapshot();
      return {
        cacheable: false,
        payload: {
          kind: 'exhausted',
          retryAfterMs: snapshot.retryAfterMs ?? 60_000,
          body: {
            status: 'error',
            code: 429,
            // Shown verbatim in the app's status banner.
            message:
              tdPool.size === 1
                ? 'Twelve Data credit limit reached on the only configured API key. Add TWELVEDATA_API_KEYS with more keys to extend the budget.'
                : `All ${tdPool.size} Twelve Data API keys are out of credits (${snapshot.usedToday} credits used today).`,
            errorMessage: `Twelve Data key pool exhausted after trying: ${tried.join(', ') || 'no usable key'}.`,
          },
        },
      };
    });

    if (res.headersSent) return;

    if (payload.kind === 'error') return sendJson(res, payload.status, payload.body);

    if (payload.kind === 'exhausted') {
      setPoolHeaders(res, tdPool);
      res.setHeader('Retry-After', String(Math.ceil(payload.retryAfterMs / 1000)));
      return sendJson(res, 429, payload.body);
    }

    res.statusCode = payload.status;
    res.setHeader('Content-Type', payload.contentType);
    res.setHeader('Cache-Control', 'no-store');
    // Visible in devtools, so a credit question can be answered by looking
    // rather than guessing: HIT means this response cost nothing.
    res.setHeader('X-TD-Cache', cached ? 'HIT' : 'MISS');
    setPoolHeaders(res, tdPool, payload.keyIndex);
    return res.end(payload.text);
  }

  function tdStatus(_req, res) {
    // Cache stats ride along with the key pool: "how many credits am I
    // spending" and "how many requests never cost one" are the same question.
    return sendJson(res, 200, { ...tdPool.snapshot(), cache: tdCache.stats() });
  }

  // Every route is a GET. Signals are written by the scanner, server-side, so
  // this proxy reads and never writes.
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

    const method = req.method || 'GET';
    if (method !== 'GET') {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', errorMessage: 'Only GET is accepted.' });
    }
    for (const route of routes) {
      if ((route.method ?? 'GET') !== method) continue;
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
    // A path that exists but not for this method is a 405, not a 403.
    if (routes.some((r) => r.re.test(url))) {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', errorMessage: `${method} is not accepted on ${url.split('?')[0]}` });
    }
    return sendJson(res, 403, { error: 'FORBIDDEN_PATH', errorMessage: `Not on the allowlist: ${url.split('?')[0]}` });
  }

  return { middleware, config: cfg };
}

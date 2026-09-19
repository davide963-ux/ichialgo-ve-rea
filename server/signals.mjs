/**
 * Signal history: write and read, backed by Supabase Postgres.
 *
 *   browser ──POST /api/signals (Bearer INGEST_TOKEN)──▶ this ──▶ Supabase RPC
 *           ──GET  /api/signals?…──────────────────────▶ this ──▶ PostgREST
 *
 * One route, both verbs. Whether storage is switched on rides along in the GET
 * response rather than a /api/signals/_status sub-path, because the bare
 * /api/signals needs a STATIC Vercel function and a static function cannot
 * also serve sub-paths.
 *
 * WHY IT GOES THROUGH THE SERVER
 * ──────────────────────────────
 * The `signals` table has RLS on with NO policies, so anon and publishable
 * keys can neither read nor write it. Only the service role can, and that key
 * lives here — never in the bundle. The browser has no Supabase credentials
 * at all.
 *
 * WHY WRITES NEED A TOKEN
 * ───────────────────────
 * The app has no login, so an unprotected write endpoint is writable by
 * anyone who finds the URL — and the whole point of this table is a history
 * worth trusting later. INGEST_TOKEN is a shared secret: set it server-side,
 * paste it into the app once. Reads are open; they are only market signals.
 *
 * Merging (live → candle upgrades, never downgrades) happens in SQL, in
 * public.upsert_signals — see the migration. Doing it here would race between
 * two open browsers.
 */

const MAX_BATCH = 200;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export function readSignalsConfig(env) {
  return {
    url: (env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (env.SUPABASE_SERVICE_KEY || '').trim(),
    ingestToken: (env.INGEST_TOKEN || '').trim(),
  };
}

const TIMEFRAMES = new Set(['30M', '1H', '4H', '1D']);
const SOURCES = new Set(['candle', 'live']);
const OUTCOMES = new Set(['bounce', 'cross', 'inside', 'pending']);
const APPROACHES = new Set(['above', 'below']);
const TRENDS = new Set(['up', 'down', 'flat']);
const BIASES = new Set(['long', 'short', 'neutral']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 64) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/**
 * Map one signal from the app's shape to the table's, rejecting anything that
 * does not fit. Returns null for a bad row rather than throwing, so one
 * malformed entry cannot lose a whole batch — and nothing unvalidated is ever
 * handed to Postgres.
 */
export function toRow(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const id = str(signal.id, 200);
  const symbol = str(signal.symbol, 24);
  const strategy = str(signal.strategy, 64);
  const timeframe = str(signal.timeframe, 8);
  const barTime = num(signal.barTime);
  const detectedAt = num(signal.detectedAt);
  if (!id || !symbol || !strategy || !timeframe || barTime === null || detectedAt === null) return null;
  if (!TIMEFRAMES.has(timeframe) || !SOURCES.has(signal.source)) return null;
  if (!OUTCOMES.has(signal.outcome) || !APPROACHES.has(signal.approach)) return null;
  if (!TRENDS.has(signal.trend) || !BIASES.has(signal.bias)) return null;

  const price = num(signal.price);
  const ema = num(signal.ema);
  if (price === null || ema === null) return null;

  const ichimoku = signal.ichimoku && typeof signal.ichimoku === 'object' ? signal.ichimoku : null;

  return {
    id,
    strategy,
    symbol,
    timeframe,
    // The app speaks UNIX seconds for bars and milliseconds for wall-clock.
    bar_time: new Date(barTime * 1000).toISOString(),
    detected_at: new Date(detectedAt).toISOString(),
    source: signal.source,
    price,
    ema,
    atr: num(signal.atr) ?? 0,
    tolerance_pips: num(signal.tolerancePips) ?? 0,
    distance_pips: num(signal.distancePips) ?? 0,
    approach: signal.approach,
    outcome: signal.outcome,
    trend: signal.trend,
    bias: signal.bias,
    counter_trend: signal.counterTrend === true,
    ichimoku,
    ichimoku_score: ichimoku && num(ichimoku.score) !== null ? ichimoku.score : null,
    plan: signal.plan && typeof signal.plan === 'object' ? signal.plan : null,
  };
}

/** Table row → the shape the UI already renders (TouchSignal). */
export function fromRow(row) {
  return {
    id: row.id,
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    barTime: Math.floor(new Date(row.bar_time).getTime() / 1000),
    detectedAt: new Date(row.detected_at).getTime(),
    source: row.source,
    price: row.price,
    ema: row.ema,
    atr: row.atr,
    tolerancePips: row.tolerance_pips,
    distancePips: row.distance_pips,
    approach: row.approach,
    outcome: row.outcome,
    trend: row.trend,
    bias: row.bias,
    counterTrend: row.counter_trend,
    ichimoku: row.ichimoku ?? null,
    plan: row.plan ?? null,
  };
}

/** Build the PostgREST query for the history view from URL params. */
export function historyQuery(search) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out = new URLSearchParams();
  out.set('select', '*');
  out.set('order', 'bar_time.desc');

  const limit = Number(params.get('limit'));
  out.set('limit', String(Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT));

  const symbol = params.get('symbol');
  if (symbol && /^[A-Z]{3}\/[A-Z]{3}$/.test(symbol)) out.set('symbol', `eq.${symbol}`);

  const timeframe = params.get('timeframe');
  if (timeframe && TIMEFRAMES.has(timeframe)) out.set('timeframe', `eq.${timeframe}`);

  const outcome = params.get('outcome');
  if (outcome && OUTCOMES.has(outcome)) out.set('outcome', `eq.${outcome}`);

  const since = Number(params.get('since'));
  if (Number.isFinite(since) && since > 0) out.set('bar_time', `gte.${new Date(since).toISOString()}`);

  return out;
}

export function createSignalsApi(env = process.env) {
  const cfg = readSignalsConfig(env);
  const configured = Boolean(cfg.url && cfg.serviceKey);

  const headers = {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    'Content-Type': 'application/json',
  };

  const sendJson = (res, status, body) => {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  /** Read the whole request body, with a hard cap. */
  const readBody = (req, limit = 1_000_000) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('Payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  /**
   * Constant-time-ish token compare. Not a timing-attack fortress, but it
   * avoids the trivial early-exit of `===` on a shared secret.
   */
  const tokenOk = (req) => {
    const given = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!cfg.ingestToken || given.length !== cfg.ingestToken.length) return false;
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ cfg.ingestToken.charCodeAt(i);
    return diff === 0;
  };

  async function ingest(req, res) {
    if (!configured) {
      return sendJson(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to store signals.' });
    }
    if (!cfg.ingestToken) {
      return sendJson(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'Set INGEST_TOKEN before the app can write signals.' });
    }
    if (!tokenOk(req)) {
      return sendJson(res, 401, { error: 'UNAUTHORIZED', errorMessage: 'Wrong or missing ingest token.' });
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'BAD_REQUEST', errorMessage: 'Body must be JSON.' });
    }
    const incoming = Array.isArray(payload) ? payload : payload?.signals;
    if (!Array.isArray(incoming)) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', errorMessage: 'Expected { signals: [...] }.' });
    }
    if (incoming.length > MAX_BATCH) {
      return sendJson(res, 413, { error: 'TOO_MANY', errorMessage: `At most ${MAX_BATCH} signals per request.` });
    }

    const rows = incoming.map(toRow).filter(Boolean);
    const rejected = incoming.length - rows.length;
    if (rows.length === 0) return sendJson(res, 200, { stored: 0, rejected });

    let upstream;
    let text;
    try {
      upstream = await fetch(`${cfg.url}/rest/v1/rpc/upsert_signals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ payload: rows }),
        signal: AbortSignal.timeout(15_000),
      });
      text = await upstream.text();
    } catch (err) {
      return sendJson(res, 502, { errorMessage: `Database unreachable (${err.code || err.message})` });
    }
    if (!upstream.ok) {
      return sendJson(res, 502, { errorMessage: `Database rejected the write: ${text.slice(0, 300)}` });
    }
    return sendJson(res, 200, { stored: rows.length, rejected });
  }

  async function history(req, res) {
    if (!configured) {
      return sendJson(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to read stored signals.' });
    }
    const url = req.url || '';
    const query = historyQuery(url.includes('?') ? url.slice(url.indexOf('?')) : '');

    let upstream;
    let text;
    try {
      upstream = await fetch(`${cfg.url}/rest/v1/signals?${query}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      text = await upstream.text();
    } catch (err) {
      return sendJson(res, 502, { errorMessage: `Database unreachable (${err.code || err.message})` });
    }
    if (!upstream.ok) {
      return sendJson(res, 502, { errorMessage: `Database read failed: ${text.slice(0, 300)}` });
    }
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      return sendJson(res, 502, { errorMessage: 'Database returned a non-JSON response.' });
    }
    return sendJson(res, 200, {
      signals: Array.isArray(rows) ? rows.map(fromRow) : [],
      configured,
      // Never reveal the token itself, only whether one is required.
      requiresToken: Boolean(cfg.ingestToken),
    });
  }

  return { ingest, history, config: cfg };
}

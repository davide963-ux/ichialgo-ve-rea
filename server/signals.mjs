/**
 * Read-only signal history.
 *
 *   browser ──GET /api/signals──▶ this ──▶ Supabase (service key)
 *
 * WRITES USED TO LIVE HERE AND NO LONGER DO. Signals are produced by the
 * server-side scanner now, not by whichever browser happened to be open, so
 * there is nothing for the page to push. That removed the ingest token with
 * it: the browser only reads.
 *
 * The service key stays server-side. The table has RLS on with no policies, so
 * an anon key is refused even if it leaks.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export function readSignalsConfig(env) {
  return {
    url: (env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (env.SUPABASE_SERVICE_KEY || '').trim(),
  };
}

const TIMEFRAMES = new Set(['30M', '1H', '4H', '1D']);
const RESULTS = new Set(['pending', 'tp', 'sl', 'expired', 'invalidated']);
const DIRECTIONS = new Set(['long', 'short']);

/** Table row → the shape the UI renders. */
export function fromRow(row) {
  return {
    id: row.id,
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    barTime: Math.floor(new Date(row.bar_time).getTime() / 1000),
    detectedAt: new Date(row.detected_at).getTime(),
    direction: row.direction,
    signal: row.signal,
    confidence: row.confidence,
    marketCondition: row.market_condition,
    setupStatus: row.setup_status,
    price: row.price,
    entry: row.entry,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    stopPips: row.stop_pips,
    result: row.result,
    closedPrice: row.closed_price,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
    rMultiple: row.r_multiple,
    analysis: row.analysis ?? null,
    reasons: row.reasons ?? [],
    warnings: row.warnings ?? [],
  };
}

/**
 * Build the PostgREST query from URL params.
 *
 * Every filter is whitelisted and the limit is capped. The query string
 * reaches PostgREST, so anything not checked here would be a way to construct
 * an arbitrary database request from the browser.
 */
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

  const result = params.get('result');
  if (result && RESULTS.has(result)) out.set('result', `eq.${result}`);

  const direction = params.get('direction');
  if (direction && DIRECTIONS.has(direction)) out.set('direction', `eq.${direction}`);

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
    });
  }

  return { history, config: cfg };
}

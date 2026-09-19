/**
 * The signals endpoints through the real middleware, with Supabase stubbed.
 * The write path is the only thing in this app that can be POSTed to, so its
 * auth and validation get the most attention here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketDataApi } from './api.mjs';
import { fromRow, historyQuery, toRow } from './signals.mjs';

const ENV = {
  SUPABASE_URL: 'https://db.example.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  INGEST_TOKEN: 'correct-horse',
};

function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: '', headersSent: false,
    setHeader: (k, v) => void (res.headers[k.toLowerCase()] = String(v)),
    end: (chunk) => { res.body = chunk ?? ''; res.headersSent = true; res.done.resolve(res); },
  };
  res.done = Promise.withResolvers();
  return res;
}

/** A request whose body is delivered like a real stream. */
function call(api, url, { method = 'GET', body, token } = {}) {
  const res = fakeRes();
  const handlers = {};
  const req = {
    url, method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    on(event, cb) { handlers[event] = cb; return req; },
    destroy() {},
  };
  api.middleware(req, res, () => res.end(''));
  if (body !== undefined) {
    queueMicrotask(() => {
      handlers.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      handlers.end?.();
    });
  }
  return res.done.promise;
}

const signal = (over = {}) => ({
  id: 'ema50-touch|EUR/USD|1H|1700000000',
  strategy: 'ema50-touch',
  symbol: 'EUR/USD',
  timeframe: '1H',
  barTime: 1_700_000_000,
  detectedAt: 1_700_000_500_000,
  source: 'candle',
  price: 1.085,
  ema: 1.0849,
  atr: 0.0012,
  tolerancePips: 2.1,
  distancePips: 0.4,
  approach: 'above',
  outcome: 'bounce',
  trend: 'up',
  bias: 'long',
  counterTrend: false,
  ichimoku: { score: 4, agrees: true },
  plan: { direction: 'LONG', entry: 1.0849 },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('toRow', () => {
  it('maps the app shape to the table, converting both time units', () => {
    const row = toRow(signal());
    expect(row.bar_time).toBe('2023-11-14T22:13:20.000Z'); // seconds → ISO
    expect(row.detected_at).toBe('2023-11-14T22:21:40.000Z'); // millis → ISO
    expect(row.counter_trend).toBe(false);
    expect(row.ichimoku_score).toBe(4); // lifted out of the jsonb for indexing
  });

  it('rejects anything that does not fit, rather than trusting the caller', () => {
    expect(toRow(null)).toBeNull();
    expect(toRow({})).toBeNull();
    expect(toRow(signal({ timeframe: '5M' }))).toBeNull(); // no longer offered
    expect(toRow(signal({ source: 'guess' }))).toBeNull();
    expect(toRow(signal({ outcome: 'maybe' }))).toBeNull();
    expect(toRow(signal({ approach: 'sideways' }))).toBeNull();
    expect(toRow(signal({ trend: 'up-ish' }))).toBeNull();
    expect(toRow(signal({ bias: 'bullish' }))).toBeNull();
    expect(toRow(signal({ price: 'cheap' }))).toBeNull();
    expect(toRow(signal({ barTime: Number.NaN }))).toBeNull();
    expect(toRow(signal({ id: 'x'.repeat(500) }))).toBeNull();
  });

  it('defaults the optional numbers instead of writing null into NOT NULL columns', () => {
    const row = toRow(signal({ atr: undefined, tolerancePips: undefined, distancePips: undefined }));
    expect(row).toMatchObject({ atr: 0, tolerance_pips: 0, distance_pips: 0 });
  });

  it('accepts a signal with no Ichimoku context yet', () => {
    const row = toRow(signal({ ichimoku: null }));
    expect(row.ichimoku).toBeNull();
    expect(row.ichimoku_score).toBeNull();
  });

  it('round-trips through fromRow', () => {
    const original = signal();
    const back = fromRow(toRow(original));
    expect(back).toMatchObject({
      id: original.id, symbol: original.symbol, timeframe: original.timeframe,
      barTime: original.barTime, detectedAt: original.detectedAt,
      outcome: original.outcome, counterTrend: false,
    });
  });
});

describe('historyQuery', () => {
  it('always sorts newest first and caps the page size', () => {
    const q = historyQuery('?limit=99999');
    expect(q.get('order')).toBe('bar_time.desc');
    expect(q.get('limit')).toBe('1000');
  });

  it('defaults a missing or silly limit', () => {
    expect(historyQuery('').get('limit')).toBe('200');
    expect(historyQuery('?limit=-5').get('limit')).toBe('200');
  });

  it('passes through only filters it recognises', () => {
    const q = historyQuery('?symbol=EUR/USD&timeframe=4H&outcome=bounce');
    expect(q.get('symbol')).toBe('eq.EUR/USD');
    expect(q.get('timeframe')).toBe('eq.4H');
    expect(q.get('outcome')).toBe('eq.bounce');
  });

  it('drops filters that do not match the expected shape', () => {
    // A PostgREST operator smuggled through a filter would change the query.
    const q = historyQuery('?symbol=EUR/USD);drop&timeframe=5M&outcome=whatever');
    expect(q.get('symbol')).toBeNull();
    expect(q.get('timeframe')).toBeNull();
    expect(q.get('outcome')).toBeNull();
  });
});

describe('POST /api/signals', () => {
  it('refuses without the token', async () => {
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'POST', body: { signals: [signal()] } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses with the wrong token, and does not touch the database', async () => {
    const used = [];
    vi.stubGlobal('fetch', async (u) => { used.push(String(u)); return new Response('1', { status: 200 }); });
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'POST', token: 'wrong', body: { signals: [signal()] } });
    expect(res.statusCode).toBe(401);
    expect(used).toEqual([]);
  });

  it('stores a valid batch through the merge function', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (u, init) => {
      calls.push({ url: String(u), body: JSON.parse(init.body), auth: init.headers.Authorization });
      return new Response('1', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'POST', token: 'correct-horse', body: { signals: [signal()] } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ stored: 1, rejected: 0 });
    // Merge rules live in SQL, so the write goes through the RPC, not the table.
    expect(calls[0].url).toBe('https://db.example.co/rest/v1/rpc/upsert_signals');
    expect(calls[0].auth).toBe('Bearer service-key');
    expect(calls[0].body.payload[0].id).toBe(signal().id);
  });

  it('drops bad rows and reports the count, keeping the good ones', async () => {
    vi.stubGlobal('fetch', async () => new Response('1', { status: 200 }));
    const res = await call(createMarketDataApi(ENV), '/api/signals', {
      method: 'POST', token: 'correct-horse',
      body: { signals: [signal(), { junk: true }, signal({ id: 'other', outcome: 'nope' })] },
    });
    expect(JSON.parse(res.body)).toEqual({ stored: 1, rejected: 2 });
  });

  it('never calls the database when every row is junk', async () => {
    const used = [];
    vi.stubGlobal('fetch', async (u) => { used.push(String(u)); return new Response('1', { status: 200 }); });
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'POST', token: 'correct-horse', body: { signals: [{}, null] } });
    expect(JSON.parse(res.body)).toEqual({ stored: 0, rejected: 2 });
    expect(used).toEqual([]);
  });

  it('rejects an oversized batch', async () => {
    const res = await call(createMarketDataApi(ENV), '/api/signals', {
      method: 'POST', token: 'correct-horse',
      body: { signals: Array.from({ length: 201 }, (_, i) => signal({ id: `s${i}` })) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('rejects a body that is not JSON, or not a signal array', async () => {
    const api = createMarketDataApi(ENV);
    expect((await call(api, '/api/signals', { method: 'POST', token: 'correct-horse', body: 'not json' })).statusCode).toBe(400);
    expect((await call(api, '/api/signals', { method: 'POST', token: 'correct-horse', body: { signals: 'nope' } })).statusCode).toBe(400);
  });

  it('says so plainly when storage is not configured at all', async () => {
    const res = await call(createMarketDataApi({}), '/api/signals', { method: 'POST', token: 'x', body: { signals: [signal()] } });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('NOT_CONFIGURED');
  });

  it('reports a database failure instead of claiming success', async () => {
    vi.stubGlobal('fetch', async () => new Response('permission denied', { status: 403 }));
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'POST', token: 'correct-horse', body: { signals: [signal()] } });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).errorMessage).toMatch(/rejected the write/);
  });
});

describe('GET /api/signals', () => {
  it('returns stored signals in the shape the UI already renders', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify([toRow(signal())]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await call(createMarketDataApi(ENV), '/api/signals?symbol=EUR/USD&limit=10');

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.requiresToken).toBe(true);
    expect(body.signals[0]).toMatchObject({ id: signal().id, barTime: 1_700_000_000, outcome: 'bounce' });
  });

  it('needs no token to read', async () => {
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200 }));
    expect((await call(createMarketDataApi(ENV), '/api/signals')).statusCode).toBe(200);
  });

  it('reports 503 when storage is off, so the UI can say so', async () => {
    const res = await call(createMarketDataApi({}), '/api/signals');
    expect(res.statusCode).toBe(503);
  });
});

describe('method handling', () => {
  it('still rejects verbs nobody serves', async () => {
    const res = await call(createMarketDataApi(ENV), '/api/signals', { method: 'DELETE' });
    expect(res.statusCode).toBe(405);
  });

  it('will not let a POST reach the read-only market-data routes', async () => {
    const res = await call(createMarketDataApi(ENV), '/api/td-rest/quote?symbol=EUR/USD', { method: 'POST', body: {} });
    expect(res.statusCode).toBe(405);
  });
});

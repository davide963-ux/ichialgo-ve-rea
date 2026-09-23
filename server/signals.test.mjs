/**
 * The signal history endpoint is READ-ONLY. Writes live in the scanner now, so
 * the tests that mattered most here are the ones about what a browser-supplied
 * query string is allowed to reach: the URL goes to PostgREST, so an
 * unvalidated filter would be a way to build an arbitrary database request
 * from the client.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSignalsApi, fromRow, historyQuery, readSignalsConfig } from './signals.mjs';

const ENV = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'service-key' };

const row = (over = {}) => ({
  id: 'ichimoku-ema50-confluence|EUR/USD|1H|1700000000',
  strategy: 'ichimoku-ema50-confluence',
  symbol: 'EUR/USD',
  timeframe: '1H',
  bar_time: '2026-09-20T10:00:00Z',
  detected_at: '2026-09-20T10:01:00Z',
  direction: 'long',
  signal: 'LONG',
  confidence: 72,
  market_condition: 'TRENDING_BULLISH',
  setup_status: 'CONFIRMED',
  price: 1.1,
  atr: 0.001,
  entry: 1.1,
  stop_loss: 1.098,
  take_profit: 1.103,
  stop_pips: 20,
  result: 'tp',
  closed_price: 1.105,
  closed_at: '2026-09-20T14:00:00Z',
  r_multiple: 2.5,
  analysis: { ok: true },
  reasons: ['a'],
  warnings: [],
  ...over,
});

/** Minimal res double. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
}

describe('readSignalsConfig', () => {
  it('trims and strips a trailing slash', () => {
    const cfg = readSignalsConfig({ SUPABASE_URL: ' https://x.co/// ', SUPABASE_SERVICE_KEY: ' k ' });
    expect(cfg).toEqual({ url: 'https://x.co', serviceKey: 'k' });
  });

  it('has no ingest token any more — the browser never writes', () => {
    expect(readSignalsConfig(ENV)).not.toHaveProperty('ingestToken');
  });
});

describe('fromRow', () => {
  it('converts both time units the UI expects', () => {
    const s = fromRow(row());
    expect(s.barTime).toBe(Math.floor(Date.parse('2026-09-20T10:00:00Z') / 1000));
    expect(s.detectedAt).toBe(Date.parse('2026-09-20T10:01:00Z'));
    expect(s.closedAt).toBe(Date.parse('2026-09-20T14:00:00Z'));
  });

  it('carries the trade result through', () => {
    const s = fromRow(row());
    expect(s).toMatchObject({ result: 'tp', rMultiple: 2.5, closedPrice: 1.105 });
  });

  it('leaves an open trade without a close', () => {
    const s = fromRow(row({ result: 'pending', closed_at: null, closed_price: null, r_multiple: null }));
    expect(s.closedAt).toBeNull();
    expect(s.rMultiple).toBeNull();
  });

  it('defaults the arrays rather than handing the UI undefined', () => {
    const s = fromRow(row({ reasons: null, warnings: null, analysis: null }));
    expect(s.reasons).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.analysis).toBeNull();
  });
});

describe('historyQuery — only whitelisted filters reach PostgREST', () => {
  it('always orders newest first and selects everything', () => {
    const q = historyQuery('');
    expect(q.get('order')).toBe('bar_time.desc');
    expect(q.get('select')).toBe('*');
  });

  it('passes through the filters it recognises', () => {
    const q = historyQuery('?symbol=EUR/USD&timeframe=4H&result=sl&direction=short');
    expect(q.get('symbol')).toBe('eq.EUR/USD');
    expect(q.get('timeframe')).toBe('eq.4H');
    expect(q.get('result')).toBe('eq.sl');
    expect(q.get('direction')).toBe('eq.short');
  });

  it('drops a filter whose value is not a known one', () => {
    const q = historyQuery('?timeframe=5S&result=profit&direction=sideways');
    expect(q.get('timeframe')).toBeNull();
    expect(q.get('result')).toBeNull();
    expect(q.get('direction')).toBeNull();
  });

  it('drops a symbol that is not a currency pair', () => {
    expect(historyQuery('?symbol=*').get('symbol')).toBeNull();
    expect(historyQuery("?symbol=EUR/USD';drop table signals--").get('symbol')).toBeNull();
  });

  it('ignores any parameter it does not know about', () => {
    const q = historyQuery('?or=(id.eq.1)&apikey=stolen&select=secret');
    expect(q.get('or')).toBeNull();
    expect(q.get('apikey')).toBeNull();
    expect(q.get('select')).toBe('*');
  });

  it('caps the limit', () => {
    expect(Number(historyQuery('?limit=999999').get('limit'))).toBe(1000);
    expect(Number(historyQuery('?limit=-5').get('limit'))).toBe(200);
    expect(Number(historyQuery('?limit=abc').get('limit'))).toBe(200);
  });

  it('accepts a since cutoff as a timestamp', () => {
    const since = Date.parse('2026-09-01T00:00:00Z');
    expect(historyQuery(`?since=${since}`).get('bar_time')).toBe('gte.2026-09-01T00:00:00.000Z');
  });
});

describe('history endpoint', () => {
  it('answers 503 when the database is not configured, without erroring', async () => {
    const api = createSignalsApi({});
    const res = makeRes();
    await api.history({ url: '/signals' }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });

  it('reads through to Supabase with the service key and maps the rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify([row()]) });
    vi.stubGlobal('fetch', fetchMock);

    const api = createSignalsApi(ENV);
    const res = makeRes();
    await api.history({ url: '/signals?symbol=EUR/USD' }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.signals).toHaveLength(1);
    expect(res.body.signals[0].rMultiple).toBe(2.5);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://db.example.com/rest/v1/signals?');
    expect(url).toContain('symbol=eq.EUR%2FUSD');
    expect(init.headers.Authorization).toBe('Bearer service-key');
    vi.unstubAllGlobals();
  });

  it('reports a database failure as a 502 rather than a blank page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => 'boom' }));
    const api = createSignalsApi(ENV);
    const res = makeRes();
    await api.history({ url: '/signals' }, res);
    expect(res.statusCode).toBe(502);
    vi.unstubAllGlobals();
  });

  it('exposes no write path at all', () => {
    expect(createSignalsApi(ENV)).not.toHaveProperty('ingest');
  });
});

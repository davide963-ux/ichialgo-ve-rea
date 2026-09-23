/**
 * End-to-end test of GET /api/td-rest/* through the real middleware, with
 * Twelve Data itself stubbed. Proves the failover the UI depends on:
 * a key that answers "out of credits" is retried on the next key, and the
 * caller sees a normal 200 payload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketDataApi } from './api.mjs';

/**
 * Caching is OFF for these tests.
 *
 * They are about the key pool — rotation, penalties, what reaches upstream —
 * and a cache hit means nothing reaches upstream at all. Leaving it on would
 * make them pass or fail on request ORDER rather than on pool behaviour. The
 * cache has its own tests in responseCache.test.mjs.
 */
const ENV = {
  TWELVEDATA_API_KEYS: 'aaaa1111,bbbb2222,cccc3333',
  TWELVEDATA_QUOTE_CACHE_MS: '0',
  TWELVEDATA_SERIES_CACHE_MS: '0',
};

/** Minimal ServerResponse stand-in. */
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    setHeader: (k, v) => void (res.headers[k.toLowerCase()] = String(v)),
    end: (chunk) => {
      res.body = chunk ?? '';
      res.headersSent = true;
      res.done.resolve(res);
    },
  };
  res.done = Promise.withResolvers();
  return res;
}

function call(api, url) {
  const res = fakeRes();
  api.middleware({ url, method: 'GET', headers: {} }, res, () => res.end(''));
  return res.done.promise;
}

const OUT_OF_CREDITS = {
  status: 'error',
  code: 429,
  message: 'You have run out of API credits for the current minute.',
};

/** Records which apikey each call used, answering per key. */
function stubUpstream(answerFor) {
  const used = [];
  vi.stubGlobal('fetch', async (url, init) => {
    const key = String(init.headers.Authorization).replace('apikey ', '');
    used.push(key);
    const { status = 200, body } = answerFor(key, String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return used;
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/td-rest/quote with a key pool', () => {
  it('serves from the first key while it has credits', async () => {
    const used = stubUpstream(() => ({ body: { symbol: 'EUR/USD', close: '1.0850' } }));
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=EUR/USD');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).close).toBe('1.0850');
    expect(used).toEqual(['aaaa1111']);
    expect(res.headers['x-td-key-used']).toBe('1');
  });

  it('retries the same request on key #2 when key #1 is out of credits', async () => {
    const used = stubUpstream((key) =>
      key === 'aaaa1111' ? { body: OUT_OF_CREDITS } : { body: { symbol: 'EUR/USD', close: '1.0850' } },
    );
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=EUR/USD');

    expect(used).toEqual(['aaaa1111', 'bbbb2222']);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).close).toBe('1.0850'); // the client never sees the 429
    expect(res.headers['x-td-key-used']).toBe('2');
  });

  it('skips a spent key on the NEXT request instead of retrying it', async () => {
    const used = stubUpstream((key) =>
      key === 'aaaa1111' ? { body: OUT_OF_CREDITS } : { body: { symbol: 'EUR/USD', close: '1.0850' } },
    );
    const api = createMarketDataApi(ENV);
    await call(api, '/api/td-rest/quote?symbol=EUR/USD');
    used.length = 0;
    await call(api, '/api/td-rest/quote?symbol=EUR/USD');

    expect(used).toEqual(['bbbb2222']); // key #1 is parked — no wasted round-trip
  });

  it('reports 429 with a pooled message only when every key is spent', async () => {
    stubUpstream(() => ({ body: OUT_OF_CREDITS }));
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=EUR/USD');

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).message).toMatch(/All 3 Twelve Data API keys are out of credits/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-td-keys-available']).toBe('0');
  });

  it('skips a rejected key and keeps serving from the rest', async () => {
    const used = stubUpstream((key) =>
      key === 'aaaa1111'
        ? { body: { status: 'error', code: 401, message: 'invalid apikey' } }
        : { body: { symbol: 'EUR/USD', close: '1.0850' } },
    );
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=EUR/USD');

    expect(res.statusCode).toBe(200);
    expect(used).toEqual(['aaaa1111', 'bbbb2222']);
  });

  it('forwards a symbol error untouched instead of burning the pool', async () => {
    // A well-formed pair the provider happens not to carry. It gets past the
    // request guard, so the pool behaviour is what is under test: one attempt,
    // not one per key, because the next key would fail identically.
    const used = stubUpstream(() => ({
      status: 404,
      body: { status: 'error', code: 404, message: '**symbol** not found' },
    }));
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=EUR/NOK');

    expect(used).toEqual(['aaaa1111']); // tried once, not three times
    expect(res.statusCode).toBe(404);
  });

  it('refuses a symbol that is not a currency pair without spending anything', async () => {
    // The proxy holds the keys, so an unsupported symbol must cost zero —
    // not one credit and an upstream round trip.
    const used = stubUpstream(() => ({ body: {} }));
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/quote?symbol=AAPL');

    expect(used).toEqual([]);
    expect(res.statusCode).toBe(400);
  });

  it('charges one credit per symbol so a 7-pair batch fits one key', async () => {
    stubUpstream(() => ({ body: {} }));
    const api = createMarketDataApi(ENV);
    await call(api, '/api/td-rest/quote?symbol=EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,USD/CHF,NZD/USD');
    const status = JSON.parse((await call(api, '/api/td-rest/_status')).body);

    expect(status.usedToday).toBe(7);
    expect(status.pool[0].usedThisMinute).toBe(7);
  });

  it('answers /_status without calling Twelve Data', async () => {
    const used = stubUpstream(() => ({ body: {} }));
    const api = createMarketDataApi(ENV);
    const res = await call(api, '/api/td-rest/_status');

    expect(used).toEqual([]);
    expect(JSON.parse(res.body)).toMatchObject({ keys: 3, perMinuteTotal: 24, perDayTotal: 2400 });
  });

  it('still says NOT_CONFIGURED when no key is set', async () => {
    const api = createMarketDataApi({});
    const res = await call(api, '/api/td-rest/_status');

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('NOT_CONFIGURED');
  });
});

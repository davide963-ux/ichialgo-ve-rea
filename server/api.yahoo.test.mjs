/**
 * The Yahoo route through the real middleware, with the upstream stubbed.
 * Guards the allowlist: this must not become a general-purpose open proxy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketDataApi } from './api.mjs';

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

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/yahoo-chart/*', () => {
  it('forwards to the chart endpoint with a browser user-agent', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push({ url: String(url), ua: init.headers['User-Agent'] });
      return new Response(JSON.stringify({ chart: { result: [{ meta: {} }], error: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const api = createMarketDataApi({});
    const res = await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=15m&range=5d');

    expect(res.statusCode).toBe(200);
    expect(seen[0].url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=15m&range=5d');
    // Yahoo refuses a default client user-agent.
    expect(seen[0].ua).toMatch(/Mozilla/);
  });

  it('needs no credentials at all', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    // Empty env: no keys, no tokens.
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=GBPUSD%3DX&interval=1h&range=1d');
    expect(res.statusCode).not.toBe(503);
  });

  it('refuses anything that is not a currency ticker', async () => {
    const used = [];
    vi.stubGlobal('fetch', async (url) => {
      used.push(String(url));
      return new Response('{}', { status: 200 });
    });
    const api = createMarketDataApi({});

    for (const bad of [
      '/api/yahoo-chart?symbol=AAPL&interval=1d&range=1mo',        // a stock, not a pair
      '/api/yahoo-chart?symbol=../../etc/passwd',                   // traversal
      '/api/yahoo-chart?symbol=EURUSD%3DX/../v7/finance/quote',     // endpoint escape
      '/api/yahoo-chart',                                           // no symbol at all
      '/api/yahoo-chart?symbol=EURUSD%3DX&interval=3s&range=5d',    // interval not on the list
      '/api/yahoo-chart?symbol=EURUSD%3DX&interval=15m&range=99y',  // range not on the list
      '/api/yahoo-chart/EURUSD=X?interval=15m',                     // the old path form
    ]) {
      const res = await call(api, bad);
      expect(res.statusCode, bad).toBe(403);
    }
    expect(used).toEqual([]); // nothing reached the network
  });

  it('rebuilds the upstream URL from validated parts only', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url) => {
      seen.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // Extra parameters the caller invents are dropped, not forwarded.
    await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=usdjpy%3Dx&interval=1h&range=1d&events=div&crumb=x');
    expect(seen[0]).toBe('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1h&range=1d');
  });

  it('passes an upstream error through rather than masking it', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=XXXYYY%3DX&interval=15m&range=5d');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).chart.error.code).toBe('Not Found');
  });

  it('reports a dead upstream as 502 instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=EURUSD%3DX&interval=15m&range=5d');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).errorMessage).toMatch(/unreachable/);
  });

  it('is still read-only', async () => {
    const res = fakeRes();
    createMarketDataApi({}).middleware({ url: '/api/yahoo-chart?symbol=EURUSD%3DX', method: 'POST', headers: {} }, res, () => {});
    await res.done.promise;
    expect(res.statusCode).toBe(405);
  });
});

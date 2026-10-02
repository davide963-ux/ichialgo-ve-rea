/**
 * The Yahoo route through the real middleware, with the upstream stubbed.
 *
 * Two things are under test and both matter more than they look:
 *
 *  1. The allowlist. This route needs no credentials, so if it forwarded an
 *     arbitrary path it would be an open proxy anyone could point anywhere.
 *  2. That it costs no Twelve Data credits — the entire reason it exists.
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

function call(api, url, method = 'GET') {
  const res = fakeRes();
  api.middleware({ url, method, headers: {} }, res, () => res.end(''));
  return res.done.promise;
}

const CHART = { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}] } }], error: null } };

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/yahoo-chart', () => {
  it('forwards to the chart endpoint with a browser user-agent', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push({ url: String(url), ua: init.headers['User-Agent'] });
      return new Response(JSON.stringify(CHART), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');

    expect(res.statusCode).toBe(200);
    expect(seen[0].url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=1mo');
    // Yahoo refuses a default client user-agent.
    expect(seen[0].ua).toMatch(/Mozilla/);
  });

  it('needs no credentials at all', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    // Empty env: no keys, no tokens. This is the point of the route.
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=GBPUSD%3DX&interval=1h&range=1d');
    expect(res.statusCode).not.toBe(503);
  });

  it('spends no Twelve Data credits', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(CHART), { status: 200, headers: { 'content-type': 'application/json' } }));
    const api = createMarketDataApi({ TWELVEDATA_API_KEYS: 'aaaa1111' });

    await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');
    const status = JSON.parse((await call(api, '/api/td-rest/_status')).body);

    expect(status.usedToday).toBe(0); // the whole reason this route is here
  });

  it('refuses anything that is not a currency ticker', async () => {
    const used = [];
    vi.stubGlobal('fetch', async (url) => {
      used.push(String(url));
      return new Response('{}', { status: 200 });
    });
    const api = createMarketDataApi({});

    for (const bad of [
      '/api/yahoo-chart?symbol=AAPL&interval=1d&range=1mo',       // a stock, not a pair
      '/api/yahoo-chart?symbol=../../etc/passwd',                  // traversal
      '/api/yahoo-chart?symbol=EURUSD%3DX/../v7/finance/quote',    // endpoint escape
      '/api/yahoo-chart',                                          // no symbol at all
      '/api/yahoo-chart?symbol=EURUSD%3DX&interval=3s&range=5d',   // interval not on the list
      '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=99y',  // range not on the list
      '/api/yahoo-chart/EURUSD=X?interval=1h',                     // the old path form
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

  it('serves a repeat from cache instead of asking Yahoo again', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(JSON.stringify(CHART), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = createMarketDataApi({});
    const first = await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');
    const second = await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');

    expect(calls).toBe(1);
    expect(first.headers['x-yahoo-cache']).toBe('MISS');
    expect(second.headers['x-yahoo-cache']).toBe('HIT');
    expect(second.body).toBe(first.body);
  });

  it('does not cache a 429, because the block outlives the TTL', async () => {
    // A 429 here is the datacenter-IP refusal this endpoint is known for.
    // Caching it would keep answering 429 after Yahoo had relented.
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('Too Many Requests', { status: 429 });
    });
    const api = createMarketDataApi({});
    await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');
    const res = await call(api, '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');

    expect(calls).toBe(2);
    expect(res.statusCode).toBe(429);
  });

  it('passes an upstream error through rather than masking it', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=XXXYYY%3DX&interval=1h&range=1mo');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).chart.error.code).toBe('Not Found');
  });

  it('reports a dead upstream as 502 instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=EURUSD%3DX&interval=1h&range=1mo');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).errorMessage).toMatch(/unreachable/);
  });

  it('is still read-only', async () => {
    const res = await call(createMarketDataApi({}), '/api/yahoo-chart?symbol=EURUSD%3DX', 'POST');
    expect(res.statusCode).toBe(405);
  });
});

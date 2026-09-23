/**
 * The router's whole job is that Yahoo is a SAVING and never a DEPENDENCY.
 *
 * So the tests below are mostly about failure: what happens when Yahoo says
 * no, how long the app keeps asking after it does, and that the chart is
 * drawn either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YahooCandleRouter } from './YahooCandleRouter';
import type { Candle, MarketDataProvider, QuoteBatch } from '../types';

const candle = (time: number, close: number): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: null,
  complete: true,
});

/** Stands in for TwelveDataProvider, counting what it is asked for. */
function fakeDelegate() {
  const calls = { candles: 0, quotes: 0, assertConfigured: 0, symbolCount: 0 };
  const provider: MarketDataProvider & { calls: typeof calls; setSymbolCount(n: number): void } = {
    id: 'twelvedata',
    label: 'Twelve Data',
    capabilities: {
      streaming: false,
      bidAsk: false,
      changeBasis: 'daily-close',
      pollIntervalMs: 60_000,
      candleRefreshMs: 120_000,
    },
    calls,
    async assertConfigured() {
      calls.assertConfigured++;
    },
    async getQuotes(): Promise<QuoteBatch> {
      calls.quotes++;
      return { quotes: [], failed: [] };
    },
    async getCandles() {
      calls.candles++;
      return [candle(0, 9.99)]; // recognisably "from the fallback"
    },
    setSymbolCount(n: number) {
      calls.symbolCount = n;
    },
  };
  return provider;
}

/** Yahoo's answer, as the chart endpoint would send it. */
function yahooReturns(closes: number[]) {
  vi.stubGlobal('fetch', async () => {
    const body = {
      chart: {
        error: null,
        result: [
          {
            meta: {},
            timestamp: closes.map((_, i) => i * 3600),
            indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes }] },
          },
        ],
      },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function yahooFails(status: number, body: unknown = { errorMessage: 'nope' }) {
  const hits = { n: 0 };
  vi.stubGlobal('fetch', async () => {
    hits.n++;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return hits;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('YahooCandleRouter', () => {
  it('serves candles from Yahoo, spending no Twelve Data credit', async () => {
    yahooReturns([1.1, 1.2, 1.3]);
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    const out = await router.getCandles('EUR/USD', '1H', 3);

    expect(out.map((c) => c.close)).toEqual([1.1, 1.2, 1.3]);
    expect(delegate.calls.candles).toBe(0); // the point of the whole exercise
    expect(router.stats().fromYahoo).toBe(1);
  });

  it('falls back to the wrapped provider when Yahoo refuses', async () => {
    yahooFails(503);
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    const out = await router.getCandles('EUR/USD', '1H', 3);

    expect(out[0]!.close).toBe(9.99); // came from the fallback
    expect(delegate.calls.candles).toBe(1);
    expect(router.stats().fromFallback).toBe(1);
  });

  /**
   * A 429 here is the datacenter-IP block Yahoo is known for, and it does not
   * clear in a minute. Without the breaker every chart would pay a doomed
   * round trip before falling back.
   */
  it('stops asking Yahoo after a rate limit, and goes straight to the fallback', async () => {
    const hits = yahooFails(429);
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    await router.getCandles('EUR/USD', '1H', 3);
    await router.getCandles('GBP/USD', '1H', 3);
    await router.getCandles('USD/JPY', '1H', 3);

    expect(hits.n).toBe(1); // asked once, then parked
    expect(delegate.calls.candles).toBe(3);
    expect(router.stats().parkedUntil).toBeGreaterThan(Date.now());
  });

  it('tolerates a one-off failure rather than parking on it', async () => {
    const hits = yahooFails(500);
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    await router.getCandles('EUR/USD', '1H', 3);
    await router.getCandles('EUR/USD', '1H', 3);

    expect(hits.n).toBe(2); // still trying — one bad response is just one
    expect(router.stats().parkedUntil).toBeNull();
  });

  it('parks Yahoo once ordinary failures keep repeating', async () => {
    const hits = yahooFails(500);
    const router = new YahooCandleRouter(fakeDelegate());

    for (let i = 0; i < 5; i++) await router.getCandles('EUR/USD', '1H', 3);

    expect(hits.n).toBe(3); // three strikes, then parked
    expect(router.stats().parkedUntil).toBeGreaterThan(Date.now());
  });

  it('goes back to Yahoo once the cooldown has passed', async () => {
    vi.useFakeTimers();
    const hits = yahooFails(429);
    const router = new YahooCandleRouter(fakeDelegate());

    await router.getCandles('EUR/USD', '1H', 3);
    vi.advanceTimersByTime(31 * 60_000); // past the rate-limit cooldown
    await router.getCandles('EUR/USD', '1H', 3);

    expect(hits.n).toBe(2);
  });

  it('forgets the failures once Yahoo answers again', async () => {
    yahooFails(500);
    const router = new YahooCandleRouter(fakeDelegate());
    await router.getCandles('EUR/USD', '1H', 3);
    await router.getCandles('EUR/USD', '1H', 3);
    expect(router.stats().consecutiveFailures).toBe(2);

    yahooReturns([1.1]);
    await router.getCandles('EUR/USD', '1H', 3);

    // Otherwise two failures an hour apart would eventually park a healthy
    // endpoint.
    expect(router.stats().consecutiveFailures).toBe(0);
    expect(router.stats().lastError).toBeNull();
  });

  it('does not start a fallback request for a chart the caller abandoned', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', async () => {
      ctrl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    await expect(router.getCandles('EUR/USD', '1H', 3, ctrl.signal)).rejects.toThrow();
    expect(delegate.calls.candles).toBe(0);
  });

  it('leaves quotes, config and symbol count entirely to the wrapped provider', async () => {
    const delegate = fakeDelegate();
    const router = new YahooCandleRouter(delegate);

    await router.assertConfigured();
    await router.getQuotes(['EUR/USD']);
    router.setSymbolCount(7);

    expect(delegate.calls).toMatchObject({ assertConfigured: 1, quotes: 1, symbolCount: 7 });
    expect(router.id).toBe('twelvedata');
    expect(router.label).toBe('Twelve Data');
    expect(router.capabilities).toBe(delegate.capabilities);
  });

  it('exposes no subscribe() when the wrapped provider has none', () => {
    // MarketDataService checks `capabilities.streaming && provider.subscribe`;
    // a forwarding stub would make that read true for a provider that cannot.
    expect(new YahooCandleRouter(fakeDelegate()).subscribe).toBeUndefined();
  });
});

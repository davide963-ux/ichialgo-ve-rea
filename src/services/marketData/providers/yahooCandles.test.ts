/**
 * Shapes and fixtures here come from a real response of
 * GET /v8/finance/chart/EURUSD=X — including the trailing nulls and zero
 * volume that response actually contains.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEFRAME_SECONDS } from '../../../config/timeframes';
import { fetchYahooCandles, rangeFor, resample, toYahooSymbol } from './yahooCandles';
import type { Candle } from '../types';

describe('toYahooSymbol', () => {
  it('maps a pair to Yahoo currency ticker form', () => {
    expect(toYahooSymbol('EUR/USD')).toBe('EURUSD=X');
    expect(toYahooSymbol('USD/JPY')).toBe('USDJPY=X');
    expect(toYahooSymbol('nzd/usd')).toBe('NZDUSD=X');
  });
});

describe('rangeFor', () => {
  it('asks for the smallest window that covers the bars requested', () => {
    expect(rangeFor('30M', 20)).toBe('1d');
    expect(rangeFor('1H', 300)).toBe('1mo'); // 300 × 1h ≈ 19 days with the pad
  });

  /**
   * A resampled timeframe covers the same CALENDAR span however it is
   * fetched: 300 4H bars are 50 days whether they arrive as 300 4H bars or
   * 1200 1H ones. An earlier version multiplied by the resample factor as
   * well and asked for a year of hourly data to draw 50 days of chart.
   */
  it('does not inflate the window for a timeframe that is resampled', () => {
    expect(rangeFor('4H', 300)).toBe('3mo');
  });

  it('never exceeds what Yahoo serves for that interval', () => {
    expect(rangeFor('30M', 100_000)).toBe('1mo'); // intraday history is capped
    expect(rangeFor('1H', 100_000)).toBe('2y');
  });

  it('allows deep history where the interval does', () => {
    expect(rangeFor('1D', 2_000)).toBe('10y');
  });

  it('pads for the weekend, since forex trades ~5 days in 7', () => {
    // 120 hourly bars would fit in 5 calendar days without the pad
    expect(rangeFor('1H', 120)).toBe('1mo');
  });
});

describe('resample', () => {
  const hourly = (closes: number[], startHourUtc = 0): Candle[] =>
    closes.map((close, i) => ({
      // 1970-01-01, so bucket boundaries are obvious: 0, 14400, 28800…
      time: (startHourUtc + i) * 3600,
      open: close - 0.001,
      high: close + 0.002,
      low: close - 0.003,
      close,
      volume: null,
      complete: true,
    }));

  it('merges four 1h bars into one 4H bar on absolute boundaries', () => {
    const out = resample(hourly([1.1, 1.2, 1.3, 1.4, 1.5]), TIMEFRAME_SECONDS['4H']);
    expect(out).toHaveLength(2);
    expect(out[0]!.time).toBe(0);
    expect(out[1]!.time).toBe(14_400); // 04:00, not "4 bars after the first"
  });

  it('takes first open, last close, and the extremes between', () => {
    const out = resample(hourly([1.1, 1.2, 1.3, 1.4]), TIMEFRAME_SECONDS['4H']);
    expect(out[0]!.open).toBeCloseTo(1.099, 6); // open of the FIRST bar
    expect(out[0]!.close).toBe(1.4); // close of the LAST bar
    expect(out[0]!.high).toBeCloseTo(1.402, 6);
    expect(out[0]!.low).toBeCloseTo(1.097, 6);
  });

  it('aligns to the bucket even when the window starts mid-bucket', () => {
    // starts at 02:00 — the first bucket is still 00:00 and holds 2 bars
    const out = resample(hourly([1.1, 1.2, 1.3, 1.4], 2), TIMEFRAME_SECONDS['4H']);
    expect(out[0]!.time).toBe(0);
    expect(out[0]!.close).toBe(1.2);
    expect(out[1]!.time).toBe(14_400);
  });

  it('marks a bucket incomplete when any bar in it is', () => {
    const bars = hourly([1.1, 1.2, 1.3, 1.4]);
    bars[3]!.complete = false;
    expect(resample(bars, TIMEFRAME_SECONDS['4H'])[0]!.complete).toBe(false);
  });

  it('handles an empty series', () => {
    expect(resample([], TIMEFRAME_SECONDS['4H'])).toEqual([]);
  });
});

// ── the request itself ────────────────────────────────────────────────────

/** A chart body in Yahoo's shape. `null` entries are left where given. */
function chartBody(times: number[], closes: (number | null)[]) {
  return {
    chart: {
      error: null,
      result: [
        {
          meta: { symbol: 'EURUSD=X' },
          timestamp: times,
          indicators: {
            quote: [
              {
                open: closes.map((c) => (c === null ? null : c - 0.001)),
                high: closes.map((c) => (c === null ? null : c + 0.002)),
                low: closes.map((c) => (c === null ? null : c - 0.003)),
                close: closes,
                volume: closes.map(() => 0),
              },
            ],
          },
        },
      ],
    },
  };
}

function stub(body: unknown, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchYahooCandles', () => {
  const hours = (n: number, from = 0) => Array.from({ length: n }, (_, i) => (from + i) * 3600);

  it('asks our own proxy, never Yahoo directly', async () => {
    const urls = stub(chartBody(hours(3), [1.1, 1.2, 1.3]));
    await fetchYahooCandles('EUR/USD', '1H', 3);

    // Direct calls would be blocked by CORS anyway, and would leak the
    // client's IP to a third party.
    expect(urls[0]).toMatch(/^\/api\/yahoo-chart\?/);
    expect(urls[0]).toContain('symbol=EURUSD%3DX');
    expect(urls[0]).toContain('interval=1h');
  });

  it('fetches 4H as hourly bars, because Yahoo has no 4h interval', async () => {
    const urls = stub(chartBody(hours(8), [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]));
    const out = await fetchYahooCandles('EUR/USD', '4H', 2);

    expect(urls[0]).toContain('interval=1h');
    expect(out).toHaveLength(2);
    expect(out[0]!.time).toBe(0);
    expect(out[1]!.time).toBe(14_400);
    expect(out[1]!.close).toBe(1.8);
  });

  /**
   * The arrays are padded with nulls for gaps and bars that have not formed.
   * Left in, `num(null)` would be 0 and the chart would show candles at zero.
   */
  it('drops the null bars rather than charting them as zero', async () => {
    stub(chartBody(hours(5), [1.1, null, 1.3, null, 1.5]));
    const out = await fetchYahooCandles('EUR/USD', '1H', 10);

    expect(out.map((c) => c.close)).toEqual([1.1, 1.3, 1.5]);
    expect(out.every((c) => c.open > 0 && c.low > 0)).toBe(true);
  });

  it('marks only the newest bar as still forming', async () => {
    stub(chartBody(hours(3), [1.1, 1.2, 1.3]));
    const out = await fetchYahooCandles('EUR/USD', '1H', 3);

    expect(out.map((c) => c.complete)).toEqual([true, true, false]);
  });

  it('reports no volume, because forex has no exchange volume', async () => {
    stub(chartBody(hours(2), [1.1, 1.2]));
    const out = await fetchYahooCandles('EUR/USD', '1H', 2);

    // Yahoo sends 0 here; charting that as a real figure would be a lie.
    expect(out.every((c) => c.volume === null)).toBe(true);
  });

  it('returns at most the count asked for, newest last', async () => {
    stub(chartBody(hours(10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const out = await fetchYahooCandles('EUR/USD', '1H', 3);

    expect(out.map((c) => c.close)).toEqual([8, 9, 10]);
  });

  it('turns an unknown symbol into invalid_symbol', async () => {
    stub({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }, 404);
    await expect(fetchYahooCandles('XXX/YYY', '1H', 10)).rejects.toMatchObject({ kind: 'invalid_symbol' });
  });

  it('turns a body with no bars into no_data instead of an empty chart', async () => {
    stub(chartBody([], []));
    await expect(fetchYahooCandles('EUR/USD', '1H', 10)).rejects.toMatchObject({ kind: 'no_data' });
  });

  it('surfaces the datacenter-IP refusal as rate_limit', async () => {
    // This is the failure that got Yahoo dropped once; the router keys its
    // circuit breaker off exactly this kind.
    stub({ errorMessage: 'Too Many Requests' }, 429);
    await expect(fetchYahooCandles('EUR/USD', '1H', 10)).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

/**
 * Shapes and fixtures here come from a real response of
 * GET /v8/finance/chart/EURUSD=X?interval=15m&range=5d — including the
 * trailing nulls and zero volume that response actually contains.
 */
import { describe, expect, it } from 'vitest';
import { TIMEFRAME_SECONDS } from '../../../config/timeframes';
import { rangeFor, resample, toYahooSymbol } from './YahooProvider';
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
    // 300 × 15m ≈ 3.1 days of bars, ~4.7 days of calendar with the weekend pad
    expect(rangeFor('15M', 300)).toBe('5d');
    expect(rangeFor('15M', 20)).toBe('1d');
  });

  it('never exceeds what Yahoo serves for that interval', () => {
    // 1m history is capped at ~7 days however many bars are asked for
    expect(rangeFor('1M', 100_000)).toBe('5d');
    // 5m–30m are capped at ~60 days
    expect(rangeFor('15M', 100_000)).toBe('1mo');
    expect(rangeFor('30M', 100_000)).toBe('1mo');
  });

  it('allows deep history where the interval does', () => {
    expect(rangeFor('1D', 2_000)).toBe('10y');
    // 5000 hourly bars ≈ 312 calendar days with the pad — 1y covers it, so
    // there is no reason to ask Yahoo for 2y.
    expect(rangeFor('1H', 5_000)).toBe('1y');
    // …and 1H is capped at 2y however much is asked for.
    expect(rangeFor('1H', 100_000)).toBe('2y');
  });

  it('pads for the weekend, since forex trades ~5 days in 7', () => {
    // 5 days of 1h bars (120) would fit in 5 calendar days without the pad
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

  it('leaves a lone bar as its own bucket', () => {
    const out = resample(hourly([1.1]), TIMEFRAME_SECONDS['4H']);
    expect(out).toHaveLength(1);
    expect(out[0]!.open).toBeCloseTo(1.099, 6);
    expect(out[0]!.close).toBe(1.1);
  });

  it('handles an empty series', () => {
    expect(resample([], TIMEFRAME_SECONDS['4H'])).toEqual([]);
  });
});

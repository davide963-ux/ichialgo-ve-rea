import { describe, expect, it } from 'vitest';
import { atr, trueRange } from './atr';
import { ema, slopePerBar } from './ema';

describe('ema', () => {
  it('is null until the seed period is complete, then starts at the SMA', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2); // SMA(1,2,3)
  });

  it('applies the standard 2/(n+1) smoothing', () => {
    // seed 2, k = 0.5 → 4*0.5 + 2*0.5 = 3 → 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3).slice(3)).toEqual([3, 4]);
  });

  it('converges towards a constant price', () => {
    const flat = new Array(200).fill(1.25);
    expect(ema(flat, 50).at(-1)).toBeCloseTo(1.25, 10);
  });

  it('lags behind a rising series (an EMA never leads price)', () => {
    const rising = Array.from({ length: 100 }, (_, i) => 1 + i * 0.01);
    const last = ema(rising, 50).at(-1)!;
    expect(last).toBeLessThan(rising.at(-1)!);
  });

  it('returns all nulls when there is not enough data', () => {
    expect(ema([1, 2], 50).every((v) => v === null)).toBe(true);
  });
});

describe('slopePerBar', () => {
  it('measures the per-bar delta over the lookback', () => {
    expect(slopePerBar([1, 2, 3, 4, 5], 4, 4)).toBe(1);
    expect(slopePerBar([5, 4, 3, 2, 1], 4, 2)).toBe(-1);
  });
  it('is null when the window reaches before the series starts', () => {
    expect(slopePerBar([null, null, 3], 2, 2)).toBeNull();
  });
});

describe('trueRange', () => {
  it('is the bar range when there is no previous close', () => {
    expect(trueRange({ high: 1.1, low: 1.0, close: 1.05 }, null)).toBeCloseTo(0.1);
  });
  it('accounts for a gap away from the previous close', () => {
    // gap up: |high - prevClose| is the real range
    expect(trueRange({ high: 1.3, low: 1.2, close: 1.25 }, 1.0)).toBeCloseTo(0.3);
  });
});

describe('atr', () => {
  it('equals the constant range of a regular series', () => {
    const bars = Array.from({ length: 60 }, () => ({ high: 1.01, low: 1.0, close: 1.005 }));
    expect(atr(bars, 14).at(-1)).toBeCloseTo(0.01, 10);
  });
  it('is null before the period is filled', () => {
    const bars = Array.from({ length: 20 }, () => ({ high: 1.01, low: 1.0, close: 1.005 }));
    expect(atr(bars, 14).slice(0, 13).every((v) => v === null)).toBe(true);
    expect(atr(bars, 14)[13]).not.toBeNull();
  });
});

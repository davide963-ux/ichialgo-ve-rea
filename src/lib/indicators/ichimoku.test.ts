import { describe, expect, it } from 'vitest';
import { ICHIMOKU_DEFAULT, cloudIsBullish, donchianMid, futureCloud, ichimoku, kumoSide, kumoThickness } from './ichimoku';

/** Bars with an explicit range, so the midpoint maths is checkable by hand. */
const bars = (rows: [high: number, low: number, close: number][]) =>
  rows.map(([high, low, close]) => ({ high, low, close }));

/** `n` bars rising 1 a bar: high = i+1, low = i-1, close = i. */
const rising = (n: number) => bars(Array.from({ length: n }, (_, i) => [i + 1, i - 1, i]));

describe('donchianMid', () => {
  it('is the midpoint of the highest high and lowest low in the window', () => {
    const out = donchianMid(bars([[10, 2, 5], [12, 4, 8], [11, 1, 6]]), 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe((12 + 1) / 2); // highest high 12, lowest low 1
  });

  it('is null until the window is full', () => {
    expect(donchianMid(rising(5), 9).every((v) => v === null)).toBe(true);
  });
});

describe('ichimoku', () => {
  const candles = rising(120);
  const s = ichimoku(candles);

  it('uses the standard 9 / 26 / 52 / 26 periods', () => {
    expect(s.config).toEqual({ tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 });
  });

  it('starts each line only once its own window is filled', () => {
    expect(s.tenkan[7]).toBeNull();
    expect(s.tenkan[8]).not.toBeNull();
    expect(s.kijun[24]).toBeNull();
    expect(s.kijun[25]).not.toBeNull();
    expect(s.senkouBRaw[50]).toBeNull();
    expect(s.senkouBRaw[51]).not.toBeNull();
  });

  it('computes Senkou A as the midpoint of Tenkan and Kijun', () => {
    const i = 100;
    expect(s.senkouARaw[i]).toBeCloseTo((s.tenkan[i]! + s.kijun[i]!) / 2, 10);
  });

  it('displaces the cloud forward by 26 bars', () => {
    const i = 100;
    expect(s.senkouA[i]).toBe(s.senkouARaw[i - ICHIMOKU_DEFAULT.displacement]);
    expect(s.senkouB[i]).toBe(s.senkouBRaw[i - ICHIMOKU_DEFAULT.displacement]);
    expect(s.senkouA[25]).toBeNull(); // nothing computed 26 bars before bar 25
  });

  it('lags Chikou by 26 bars and leaves the last 26 undrawn', () => {
    expect(s.chikou[50]).toBe(candles[76]!.close);
    expect(s.chikou[candles.length - 1]).toBeNull();
    expect(s.chikou[candles.length - 27]).toBe(candles[candles.length - 1]!.close);
  });

  it('puts the cloud below price in a steady uptrend', () => {
    const i = candles.length - 1;
    expect(kumoSide(s, i, candles[i]!.close)).toBe('above');
    expect(cloudIsBullish(s, i)).toBe(true);
  });

  it('reads a price inside the cloud as inside', () => {
    const i = candles.length - 1;
    const mid = (s.senkouA[i]! + s.senkouB[i]!) / 2;
    expect(kumoSide(s, i, mid)).toBe('inside');
  });

  it('reports the cloud thickness', () => {
    const i = candles.length - 1;
    expect(kumoThickness(s, i)).toBeCloseTo(Math.abs(s.senkouA[i]! - s.senkouB[i]!), 10);
  });

  it('flips the cloud bearish in a downtrend', () => {
    const down = bars(Array.from({ length: 120 }, (_, i) => [120 - i + 1, 120 - i - 1, 120 - i]));
    const d = ichimoku(down);
    const i = down.length - 1;
    expect(kumoSide(d, i, down[i]!.close)).toBe('below');
    expect(cloudIsBullish(d, i)).toBe(false);
  });

  it('has no cloud at all when history is shorter than the warm-up', () => {
    const short = ichimoku(rising(30));
    expect(short.senkouA.every((v) => v === null)).toBe(true);
    expect(kumoSide(short, 29, 10)).toBeNull();
  });
});

describe('futureCloud', () => {
  const candles = rising(120);
  const s = ichimoku(candles);

  it('projects exactly `displacement` bars past the last candle', () => {
    const future = futureCloud(s, candles.length);
    expect(future).toHaveLength(ICHIMOKU_DEFAULT.displacement);
    expect(future[0]!.offset).toBe(1);
    expect(future.at(-1)!.offset).toBe(ICHIMOKU_DEFAULT.displacement);
  });

  it('carries the raw values that have not been drawn over a candle yet', () => {
    const future = futureCloud(s, candles.length);
    expect(future.at(-1)!.senkouA).toBe(s.senkouARaw[candles.length - 1]);
  });
});

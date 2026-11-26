/**
 * OANDA's "Identifying future support and resistance zones".
 *
 * Quoted: the Kumo "act[s] as a potential future support zone if price is
 * above the Cloud, and as a potential future resistance zone if price is
 * below the Cloud."
 *
 * The zone is the cloud being drawn 26 bars AHEAD, not the one in effect.
 * That distinction is the whole value of the feature — the forward cloud is
 * determined today, which is what Ichimoku has and a moving average does not
 * — and getting it wrong would silently report yesterday's levels as
 * tomorrow's.
 */
import { describe, expect, it } from 'vitest';
import { ichimoku } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData/types';
import { futureCloudZone, zoneStrength } from './cloudZones';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';

const parseCsv = (csv: string): Candle[] =>
  csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });

describe('futureCloudZone', () => {
  it('reads the cloud 26 bars ahead, not the one in effect', () => {
    const candles = parseCsv(eurusd);
    const series = ichimoku(candles);
    const i = candles.length - 1;
    const zone = futureCloudZone(candles, series, 'EUR/USD');
    if (zone === null) return; // price inside the cloud: nothing to assert

    const ahead = [series.senkouARaw[i]!, series.senkouBRaw[i]!];
    expect([zone.near, zone.far].sort()).toEqual([...ahead].sort());
    // And it is NOT the cloud in effect, which is a different pair of numbers.
    const inEffect = [series.senkouA[i], series.senkouB[i]];
    expect(ahead).not.toEqual(inEffect);
  });

  /** Support above, resistance below — and nothing while price is inside. */
  it('names the zone from which side price is on, with the near edge first', () => {
    for (const [csv, symbol] of [
      [eurusd, 'EUR/USD'],
      [usdjpy, 'USD/JPY'],
    ] as const) {
      const all = parseCsv(csv);
      let support = 0;
      let resistance = 0;
      let inside = 0;

      // Walk a window forward so every state is exercised, not just today's.
      for (let end = 200; end < all.length; end += 97) {
        const candles = all.slice(0, end);
        const series = ichimoku(candles);
        const zone = futureCloudZone(candles, series, symbol);
        const close = candles.at(-1)!.close;
        if (zone === null) {
          inside++;
          continue;
        }
        if (zone.kind === 'support') {
          support++;
          expect(close, 'support means price is above the cloud').toBeGreaterThan(zone.near);
          expect(zone.near, 'the near edge is the closer one to price').toBeGreaterThan(zone.far);
        } else {
          resistance++;
          expect(close, 'resistance means price is below the cloud').toBeLessThan(zone.near);
          expect(zone.near).toBeLessThan(zone.far);
        }
        expect(zone.thicknessPips).toBeCloseTo(Math.abs(zone.near - zone.far) / pipSize(symbol), 9);
        expect(zone.thicknessPips).toBeGreaterThanOrEqual(0);
      }

      expect(support, `${symbol} must produce support zones`).toBeGreaterThan(0);
      expect(resistance, `${symbol} must produce resistance zones`).toBeGreaterThan(0);
      expect(inside, `${symbol} must have price inside the cloud sometimes`).toBeGreaterThan(0);
    }
  });

  it('has nothing to say about an empty or too-short series', () => {
    expect(futureCloudZone([], ichimoku([]), 'EUR/USD')).toBeNull();
    const few = parseCsv(eurusd).slice(0, 10);
    expect(futureCloudZone(few, ichimoku(few), 'EUR/USD')).toBeNull();
  });
});

describe('zoneStrength', () => {
  /**
   * OANDA is qualitative here — "large or thick" against "small or thin" — so
   * the threshold is ours. What must hold is that it is RELATIVE: a 30-pip
   * cloud is thick on a quiet pair and thin on a fast one, and a fixed pip
   * figure would call USD/JPY thick permanently.
   */
  it('judges thickness against the pair’s own recent travel', () => {
    expect(zoneStrength(30, 100)).toBe('thick');
    expect(zoneStrength(30, 400)).toBe('thin');
    // The same absolute thickness flips verdict with the range, which is the
    // entire point of expressing it as a fraction.
    expect(zoneStrength(10, 50)).toBe('thick');
    expect(zoneStrength(10, 500)).toBe('thin');
  });

  it('does not divide by a zero range', () => {
    expect(zoneStrength(10, 0)).toBe('thin');
  });
});

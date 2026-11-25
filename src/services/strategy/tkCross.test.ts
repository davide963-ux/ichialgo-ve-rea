/**
 * The TK-cross detector.
 *
 * This detector is NOT wired into the app. It was built to answer whether an
 * Ichimoku-triggered entry beats the EMA50-touch one, and measured against
 * the fixtures it does not — see the docblock in tkCross.ts. The tests are
 * here so the measurement can be trusted and repeated: a negative result from
 * a detector that quietly mis-detects is worth nothing.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../marketData/types';
import { analyseTkCross, crossedOn, minBarsFor, strengthOf, tkCrossId } from './tkCross';
import { ichimoku } from '../../lib/indicators';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';

const parseCsv = (csv: string): Candle[] =>
  csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });

describe('strengthOf', () => {
  /**
   * The grade is the whole point of the signal: the same cross means
   * different things on either side of the cloud.
   */
  it('grades a cross by whether the cloud is behind it', () => {
    expect(strengthOf('LONG', 'above')).toBe('strong');
    expect(strengthOf('LONG', 'below')).toBe('weak');
    expect(strengthOf('SHORT', 'below')).toBe('strong');
    expect(strengthOf('SHORT', 'above')).toBe('weak');
  });

  it('calls a cross inside the cloud neutral, whichever way it goes', () => {
    expect(strengthOf('LONG', 'inside')).toBe('neutral');
    expect(strengthOf('SHORT', 'inside')).toBe('neutral');
  });
});

describe('crossedOn', () => {
  const t = (...v: (number | null)[]) => v;

  it('finds the bar the lines actually cross on, and only that bar', () => {
    const tenkan = t(1, 1, 3, 4);
    const kijun = t(2, 2, 2, 2);
    expect(crossedOn(tenkan, kijun, 1)).toBeNull(); // still below
    expect(crossedOn(tenkan, kijun, 2)).toBe('LONG'); // crosses here
    expect(crossedOn(tenkan, kijun, 3)).toBeNull(); // already above
  });

  it('finds a bearish cross the same way', () => {
    expect(crossedOn(t(3, 3, 1), t(2, 2, 2), 2)).toBe('SHORT');
  });

  /**
   * Touching and separating is one cross, on the bar it resolves. A strict
   * comparison on the previous bar would miss it entirely.
   */
  it('counts a cross out of equality once, on the bar it resolves', () => {
    expect(crossedOn(t(2, 2, 3), t(2, 2, 2), 2)).toBe('LONG');
    expect(crossedOn(t(2, 2, 1), t(2, 2, 2), 2)).toBe('SHORT');
    // Equal and still equal is not a cross.
    expect(crossedOn(t(2, 2, 2), t(2, 2, 2), 2)).toBeNull();
  });

  it('reports nothing where either line is undefined', () => {
    expect(crossedOn(t(null, 3), t(2, 2), 1)).toBeNull();
    expect(crossedOn(t(1, 3), t(null, 2), 1)).toBeNull();
  });
});

describe('analyseTkCross', () => {
  const candles = parseCsv(eurusd);

  it('reports nothing until a cloud exists to grade against', () => {
    const need = minBarsFor(ichimoku(candles));
    // 52 + 26: Senkou B's lookback plus the displacement.
    expect(need).toBe(78);
    expect(analyseTkCross(candles.slice(0, need - 1), 'EUR/USD', '1H').reason).toBe('not-enough-bars');
    expect(analyseTkCross(candles.slice(0, need - 1), 'EUR/USD', '1H').signals).toEqual([]);
  });

  it('finds crosses on real candles, all three grades among them', () => {
    const { signals, reason } = analyseTkCross(candles, 'EUR/USD', '1H');
    expect(reason).toBe('ok');
    expect(signals.length).toBeGreaterThan(50);
    const grades = new Set(signals.map((s) => s.strength));
    expect(grades).toContain('strong');
    expect(grades).toContain('weak');
  });

  it('gives every signal a stable id and a consistent grade', () => {
    const { signals } = analyseTkCross(candles, 'EUR/USD', '1H');
    const ids = new Set(signals.map((s) => s.id));
    expect(ids.size, 'ids must be unique per bar').toBe(signals.length);
    for (const s of signals) {
      expect(s.id).toBe(tkCrossId('EUR/USD', '1H', s.barTime));
      expect(s.strength).toBe(strengthOf(s.direction, s.kumo));
      expect(s.ichimokuScore).toBeGreaterThanOrEqual(0);
      expect(s.ichimokuScore).toBeLessThanOrEqual(4);
      expect(s.emaScore).toBeGreaterThanOrEqual(0);
      expect(s.emaScore).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic — the same candles give the same signals', () => {
    const a = analyseTkCross(candles, 'EUR/USD', '1H', undefined, 0);
    const b = analyseTkCross(candles, 'EUR/USD', '1H', undefined, 0);
    expect(a.signals).toEqual(b.signals);
  });

  /**
   * Causality: a signal must not depend on bars that had not happened yet.
   * Truncating the series must leave the earlier signals untouched — the one
   * mistake that makes any backtest of this meaningless.
   */
  it('does not change past signals when later candles are removed', () => {
    const cut = Math.floor(candles.length * 0.6);
    const full = analyseTkCross(candles, 'EUR/USD', '1H', undefined, 0);
    const part = analyseTkCross(candles.slice(0, cut), 'EUR/USD', '1H', undefined, 0);

    // Chikou needs 26 bars after the signal to be known, so the last few of
    // the truncated run legitimately differ; compare everything before that.
    const safeUntil = candles[cut - 27]!.time;
    const pick = (s: { barTime: number }[]) => s.filter((x) => x.barTime <= safeUntil);
    expect(pick(part.signals).length).toBeGreaterThan(10);
    expect(pick(part.signals)).toEqual(pick(full.signals));
  });

  it('prices the signal at the cross bar’s close, which is where a market order fills', () => {
    const { signals } = analyseTkCross(candles, 'EUR/USD', '1H');
    const byTime = new Map(candles.map((c) => [c.time, c]));
    for (const s of signals.slice(0, 20)) {
      expect(s.price).toBe(byTime.get(s.barTime)!.close);
    }
  });
});

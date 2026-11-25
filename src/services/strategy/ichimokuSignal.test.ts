/**
 * The pure-Ichimoku detector.
 *
 * The tests that matter here are the ones about what the strategy is NOT
 * allowed to depend on. "Pure Ichimoku" is a claim that can rot silently —
 * someone adds an ATR for a stop floor and nothing fails — so the first test
 * reads the source and fails if an EMA or ATR ever appears in it.
 */
import { describe, expect, it } from 'vitest';
import { ICHIMOKU_STRATEGY } from '../../config/ichimokuStrategy';
import type { Candle } from '../marketData/types';
import { analyseIchimoku, ichimokuSignalId, minBars, rangeOver } from './ichimokuSignal';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import detectorSrc from './ichimokuSignal.ts?raw';
import configSrc from '../../config/ichimokuStrategy.ts?raw';

const parseCsv = (csv: string): Candle[] =>
  csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });

const candles = parseCsv(eurusd);

describe('purity', () => {
  /**
   * The whole point of this module. A stop floor in ATR or a trend filter on
   * an EMA would both work fine and both break the promise, so the promise is
   * checked mechanically rather than by review.
   */
  it('contains no EMA and no ATR, in the detector or its config', () => {
    for (const [name, src] of [
      ['ichimokuSignal.ts', detectorSrc],
      ['ichimokuStrategy.ts', configSrc],
    ] as const) {
      // Strip comments: the docblocks explain what was removed and why.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${name} must not use an EMA`).not.toMatch(/\bema\b/i);
      expect(code, `${name} must not use an ATR`).not.toMatch(/\batr\b/i);
    }
  });
});

describe('rangeOver', () => {
  it('is the high-low span of the window, and null before it is full', () => {
    const c = (h: number, l: number): Candle => ({ time: 0, open: h, high: h, low: l, close: h, volume: null, complete: true });
    const bars = [c(3, 1), c(5, 2), c(4, 0)];
    expect(rangeOver(bars, 3)).toEqual([null, null, 5]); // hh 5, ll 0
    expect(rangeOver(bars, 2)).toEqual([null, 4, 5]); // (5-1), (5-0)
  });

  it('never returns a negative range', () => {
    for (const r of rangeOver(candles, ICHIMOKU_STRATEGY.rangePeriod)) {
      if (r !== null) expect(r).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('analyseIchimoku', () => {
  it('reports nothing until the cloud and the range have both warmed up', () => {
    const need = minBars();
    expect(need).toBe(52 + 26 + 26);
    expect(analyseIchimoku(candles.slice(0, need - 1), 'EUR/USD', '1H').reason).toBe('not-enough-bars');
  });

  it('produces signals on real candles', () => {
    const { signals, reason } = analyseIchimoku(candles, 'EUR/USD', '1H');
    expect(reason).toBe('ok');
    expect(signals.length).toBeGreaterThan(5);
  });

  /**
   * The correction this strategy exists to make. The old rule took direction
   * from which side price approached the line, so a pullback inside a
   * downtrend became a long. Here the cloud decides, and nothing else can.
   */
  it('takes direction from the Kumo, never from the approach side', () => {
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    for (const s of signals) {
      expect(s.direction).toBe(s.kumo === 'above' ? 'LONG' : 'SHORT');
    }
  });

  it('never signals while price is inside the cloud', () => {
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    for (const s of signals) expect(s.kumo === 'above' || s.kumo === 'below').toBe(true);
  });

  it('gates on the score rather than labelling with it', () => {
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    for (const s of signals) expect(s.score).toBeGreaterThanOrEqual(ICHIMOKU_STRATEGY.minScore);

    // Lowering the gate must admit strictly more signals, never fewer.
    const loose = analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU_STRATEGY, minScore: 0 });
    expect(loose.signals.length).toBeGreaterThan(signals.length);
    const strictIds = new Set(signals.map((s) => s.id));
    for (const id of strictIds) expect(loose.signals.some((s) => s.id === id)).toBe(true);
  });

  it('places the stop and target from the range, on the correct sides', () => {
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    for (const s of signals) {
      const risk = Math.abs(s.entry - s.stop);
      expect(risk).toBeCloseTo((s.rangePips * ICHIMOKU_STRATEGY.stopRange) / 10000, 9);
      expect(Math.abs(s.target - s.entry)).toBeCloseTo(risk * ICHIMOKU_STRATEGY.rewardMultiple, 9);
      if (s.direction === 'LONG') {
        expect(s.stop).toBeLessThan(s.entry);
        expect(s.target).toBeGreaterThan(s.entry);
      } else {
        expect(s.stop).toBeGreaterThan(s.entry);
        expect(s.target).toBeLessThan(s.entry);
      }
      expect(s.stopPips).toBeGreaterThan(0);
    }
  });

  it('enters at the signal bar’s close, where a market order fills', () => {
    const byTime = new Map(candles.map((c) => [c.time, c]));
    for (const s of analyseIchimoku(candles, 'EUR/USD', '1H').signals) {
      expect(s.entry).toBe(byTime.get(s.barTime)!.close);
    }
  });

  it('gives each signal a stable, unique id', () => {
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    const ids = new Set(signals.map((s) => s.id));
    expect(ids.size).toBe(signals.length);
    for (const s of signals) expect(s.id).toBe(ichimokuSignalId('EUR/USD', '1H', s.barTime));
  });

  /**
   * One signal per pullback, not one per bar: between any two signals some
   * bar must have CLOSED outside the re-arm zone.
   *
   * Note the subtlety that makes consecutive signals legitimate — a bar can
   * enter the band with its wick and still close well clear of it, which
   * re-arms on that same bar. So the invariant is about closes leaving the
   * zone, not about a gap in bar numbers.
   */
  it('requires a close outside the zone between consecutive signals', () => {
    const { signals, range } = analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU_STRATEGY, minScore: 0 });
    const series = analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU_STRATEGY, minScore: 0 }).ichimoku;
    const index = new Map(candles.map((c, i) => [c.time, i]));
    const bars = signals.map((s) => index.get(s.barTime)!).sort((a, b) => a - b);
    expect(bars.length).toBeGreaterThan(5);

    for (let n = 1; n < bars.length; n++) {
      const from = bars[n - 1]!;
      const to = bars[n]!;
      let left = false;
      for (let i = from; i < to; i++) {
        const kijun = series.kijun[i];
        const r = range[i];
        if (kijun == null || r == null) continue;
        const band = r * ICHIMOKU_STRATEGY.touchBand * ICHIMOKU_STRATEGY.rearmBands;
        if (Math.abs(candles[i]!.close - kijun) > band) { left = true; break; }
      }
      expect(left, `no close left the zone between bars ${from} and ${to}`).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = analyseIchimoku(candles, 'EUR/USD', '1H', ICHIMOKU_STRATEGY, 0);
    const b = analyseIchimoku(candles, 'EUR/USD', '1H', ICHIMOKU_STRATEGY, 0);
    expect(a.signals).toEqual(b.signals);
  });

  /**
   * Causality. Chikou needs 26 bars after a signal before it is knowable, so
   * the last stretch of a truncated run legitimately differs; everything
   * before that must be identical or no backtest of this means anything.
   */
  it('does not rewrite past signals when later candles are removed', () => {
    const cut = Math.floor(candles.length * 0.6);
    const full = analyseIchimoku(candles, 'EUR/USD', '1H', ICHIMOKU_STRATEGY, 0);
    const part = analyseIchimoku(candles.slice(0, cut), 'EUR/USD', '1H', ICHIMOKU_STRATEGY, 0);
    const safeUntil = candles[cut - 27]!.time;
    const pick = (s: { barTime: number }[]) => s.filter((x) => x.barTime <= safeUntil);
    expect(pick(part.signals).length).toBeGreaterThan(2);
    expect(pick(part.signals)).toEqual(pick(full.signals));
  });
});

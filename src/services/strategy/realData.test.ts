/**
 * The detector, run over REAL candles.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The unit tests build bars by hand to exercise one branch each. That is the
 * right way to test a state machine, and it is also how a strategy gets
 * validated against a fiction: an earlier strategy on this project was tuned
 * three times against a synthetic candle generator that injected trends 45%
 * of the time, which flattered it by construction.
 *
 * So this runs the detector over `fixtures/market/` — 5000 real 1H OANDA bars
 * per pair — and asserts the things that must hold on ANY real series. It is
 * not a backtest and makes no claim about profitability. It catches the
 * failures that hand-built fixtures cannot: a detector that fires on every
 * bar, one that never fires at all, or one that emits a touch nowhere near
 * the EMA.
 */
import { describe, expect, it } from 'vitest';
import audusd from '../../../fixtures/market/AUDUSD_1H.csv?raw';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import gbpjpy from '../../../fixtures/market/GBPJPY_1H.csv?raw';
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
import usdcad from '../../../fixtures/market/USDCAD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';
import { EMA50_TOUCH } from '../../config/strategy';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import { analyseEma50Touch } from './ema50Touch';
import { backtestTouches } from './backtest';

/**
 * Loaded through Vite's `?raw` rather than node:fs: this file lives under
 * src/, which is typechecked as browser code and has no node types.
 */
const PAIRS = [
  [eurusd, 'EUR/USD'],
  [gbpusd, 'GBP/USD'],
  [usdjpy, 'USD/JPY'],
  [audusd, 'AUD/USD'],
  [usdcad, 'USD/CAD'],
  [gbpjpy, 'GBP/JPY'],
] as const;

/** "t,o,h,l,c" rows, one per bar, oldest first. */
function loadCandles(csv: string): Candle[] {
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line: string) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });
}

describe('analyseEma50Touch on real OANDA candles', () => {
  for (const [csv, symbol] of PAIRS) {
    describe(symbol, () => {
      const candles = loadCandles(csv);
      const analysis = analyseEma50Touch(candles, symbol, '1H');

      it('loads the fixture it claims to (so this cannot pass on an empty file)', () => {
        expect(candles.length).toBeGreaterThan(4000);
        expect(candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close)).toBe(true);
      });

      /**
       * The arm/re-arm rule is the whole reason this is a state machine. A
       * market riding its EMA would otherwise signal on every single bar, and
       * on 5000 bars that failure is obvious; on a 20-bar fixture it is not.
       *
       * The observed rate is 13.7–15.7% across all six pairs — roughly one
       * touch every seven bars. The bounds here are wide enough not to be a
       * snapshot of today's numbers and tight enough to catch a detector that
       * has gone silent or started firing on everything.
       */
      it('fires sometimes, but nowhere near every bar', () => {
        const rate = analysis.signals.length / candles.length;
        expect(rate, `${analysis.signals.length} touches in ${candles.length} bars`).toBeGreaterThan(0.01);
        expect(rate, `${analysis.signals.length} touches in ${candles.length} bars`).toBeLessThan(0.25);
      });

      /**
       * `distancePips` is |contact price − EMA|, and the contact price is the
       * bar extreme that reached the band — EXCEPT on a cross, where it is the
       * close, which is beyond the band by definition of having crossed. So
       * the band bound holds for every outcome but that one.
       *
       * This is not a detail: across all six pairs the number of touches
       * outside the band equals the number of crosses exactly, which is how
       * the rule was confirmed rather than assumed.
       */
      it('keeps a non-crossing touch inside its band', () => {
        for (const s of analysis.signals) {
          if (s.outcome === 'cross') continue;
          expect(Math.abs(s.distancePips), `${s.id} is ${s.distancePips} pips out`).toBeLessThanOrEqual(
            s.tolerancePips + 1e-6,
          );
        }
      });

      it('marks a touch as a cross only when the bar closed through the EMA', () => {
        const crosses = analysis.signals.filter((s) => s.outcome === 'cross');
        expect(crosses.length).toBeGreaterThan(0);
        for (const s of crosses) {
          // Approached from above → closed below the line, and vice versa.
          const closedBelow = s.price < s.ema;
          expect(closedBelow, `${s.id} approached from ${s.approach}`).toBe(s.approach === 'above');
        }
      });

      it('gives every touch a band wider than the configured floor', () => {
        // max(ATR × multiple, minPips) — so the floor is a floor, never a cap.
        for (const s of analysis.signals) {
          expect(s.tolerancePips).toBeGreaterThanOrEqual(EMA50_TOUCH.minTolerancePips - 1e-9);
        }
      });

      it('never emits two touches on the same bar', () => {
        const times = analysis.signals.map((s) => s.barTime);
        expect(new Set(times).size).toBe(times.length);
      });

      it('reports touches in chronological order', () => {
        const times = analysis.signals.map((s) => s.barTime);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
      });

      /**
       * THE TEST EVERYTHING ELSE RESTS ON.
       *
       * A strategy that reads bars it could not have seen prints an edge that
       * does not exist, and nothing downstream can detect it — the backtest,
       * the metrics and the confidence interval are all computed faithfully
       * from a fiction.
       *
       * So: analyse a TRUNCATED series and compare. Every signal at a bar the
       * shorter series also contains must come out byte-identical, Ichimoku
       * score included. If any later bar leaks in, these disagree.
       *
       * The last bar of a truncation is excluded because it is genuinely
       * still forming there and closed in the full series — a real
       * difference, not a leak.
       */
      it('reads no bar it could not have seen', () => {
        const cut = Math.floor(candles.length * 0.6);
        const truncated = analyseEma50Touch(candles.slice(0, cut), symbol, '1H');
        const lastComparable = candles[cut - 2]!.time;

        const shape = (list: typeof truncated.signals) =>
          list
            .filter((s) => s.barTime <= lastComparable)
            .map((s) => [s.id, s.outcome, s.approach, s.bias, s.counterTrend, s.ichimoku?.score ?? null].join('|'));

        const fromTruncated = shape(truncated.signals);
        expect(fromTruncated.length, 'the truncation must contain signals to compare').toBeGreaterThan(20);
        expect(fromTruncated).toEqual(shape(analysis.signals));
      });

      /**
       * The backtest's own causality, on top of the detector's: trades that
       * closed before the cut must be identical too, since a trade's result
       * depends only on bars up to its exit.
       */
      it('produces the same closed trades from a truncated series', () => {
        const cut = Math.floor(candles.length * 0.6);
        const full = backtestTouches(candles, symbol, '1H');
        const part = backtestTouches(candles.slice(0, cut), symbol, '1H');
        const cutoff = candles[cut - 2]!.time;

        const closedBefore = (r: typeof full) =>
          r.trades
            .filter((t) => t.exitTime !== null && t.exitTime <= cutoff)
            .map((t) => `${t.id}|${t.exit}|${t.rMultiple?.toFixed(6)}`);

        const partial = closedBefore(part);
        expect(partial.length, 'the truncation must contain closed trades').toBeGreaterThan(10);
        expect(partial).toEqual(closedBefore(full));
      });

      /**
       * Entry is a resting limit at the EMA, so it can only fill at a price
       * the bar actually traded. Filling the rest anyway was worth +0.23R a
       * trade of pure fiction — see backtest.ts, rule 1.
       */
      it('turns a large share of touches away for want of a fill', () => {
        // The band is wider than the line, so most touches never trade at the
        // EMA. Filling them anyway was the single biggest lie in the first
        // version of this backtest.
        const result = backtestTouches(candles, symbol, '1H');
        expect(result.noFill).toBeGreaterThan(0);
        expect(result.trades.length + result.noFill).toBeLessThanOrEqual(result.touches);
      });

      it('never enters at a price the entry bar did not trade', () => {
        const byTime = new Map(candles.map((c) => [c.time, c]));
        const result = backtestTouches(candles, symbol, '1H');
        expect(result.trades.length).toBeGreaterThan(20);
        for (const t of result.trades) {
          const bar = byTime.get(t.entryTime)!;
          expect(t.entry, `${t.id} filled outside its bar`).toBeGreaterThanOrEqual(bar.low);
          expect(t.entry, `${t.id} filled outside its bar`).toBeLessThanOrEqual(bar.high);
        }
      });

      it('leaves a usable level on the last bar', () => {
        const level = analysis.level;
        expect(level).not.toBeNull();
        // The EMA must be a real price for this pair, not a stray 0 or NaN.
        const last = candles.at(-1)!.close;
        expect(Math.abs((level!.ema - last) / pipSize(symbol))).toBeLessThan(5000);
      });
    });
  }
});

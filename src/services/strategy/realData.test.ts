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
 * bar, one that never fires at all, or one that emits a signal nowhere near
 * the Kijun it claims to have retested.
 */
import { describe, expect, it } from 'vitest';
import audusd from '../../../fixtures/market/AUDUSD_1H.csv?raw';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import gbpjpy from '../../../fixtures/market/GBPJPY_1H.csv?raw';
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
import usdcad from '../../../fixtures/market/USDCAD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';
import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY } from '../../config/ichimokuStrategy';
import { pipSize } from '../../lib/pips';
import { kumoSide } from '../../lib/indicators';
import type { Candle } from '../marketData';
import { analyseIchimoku } from './ichimokuSignal';
import { backtestIchimoku } from './backtest';

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

describe('analyseIchimoku on real OANDA candles', () => {
  for (const [csv, symbol] of PAIRS) {
    describe(symbol, () => {
      const candles = loadCandles(csv);
      const analysis = analyseIchimoku(candles, symbol, '1H');
      const index = new Map(candles.map((c, i) => [c.time, i]));

      it('loads the fixture it claims to (so this cannot pass on an empty file)', () => {
        expect(candles.length).toBeGreaterThan(4000);
        expect(candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close)).toBe(true);
      });

      /**
       * The arm/re-arm rule is the whole reason this is a state machine. A
       * market riding its Kijun would otherwise signal on every single bar,
       * and on 5000 bars that failure is obvious; on a 20-bar fixture it is
       * not.
       *
       * The gate makes this rate much lower than the old strategy's: a
       * pullback has to clear 4 of 4 confirmations, so the observed rate is
       * roughly one signal per 40–70 bars. The bounds are wide enough not to
       * be a snapshot of today's numbers and tight enough to catch a detector
       * that has gone silent or started firing on everything.
       */
      it('fires sometimes, but nowhere near every bar', () => {
        const rate = analysis.signals.length / candles.length;
        const note = `${analysis.signals.length} signals in ${candles.length} bars`;
        expect(rate, note).toBeGreaterThan(0.002);
        expect(rate, note).toBeLessThan(0.1);
      });

      /**
       * The correction this strategy exists to make. The old rule took the
       * direction from the side price approached the line on, so a pullback
       * inside a downtrend became a long. Here the Kumo decides, and this
       * checks it against the cloud recomputed from the bar itself rather
       * than against the field the detector wrote.
       */
      it('takes every direction from the Kumo, checked against the bar', () => {
        for (const s of analysis.signals) {
          const i = index.get(s.barTime)!;
          const side = kumoSide(analysis.ichimoku, i, candles[i]!.close);
          expect(side, `${s.id} signalled inside the cloud`).not.toBe('inside');
          expect(s.kumo, `${s.id} disagrees with the cloud`).toBe(side);
          expect(s.direction).toBe(side === 'above' ? 'LONG' : 'SHORT');
        }
      });

      /**
       * `distancePips` is |entry − Kijun|, and entry is the bar's CLOSE. A bar
       * can touch the band with a wick and close well outside it, so the close
       * is not bounded by the band — but it is bounded by the bar's own range
       * plus the band, which is what "this bar retested the line" means.
       */
      it('signals only on a bar whose range reached the Kijun band', () => {
        for (const s of analysis.signals) {
          const bar = candles[index.get(s.barTime)!]!;
          const halfBand = s.rangePips * ICHIMOKU_STRATEGY.touchBand * pipSize(symbol);
          expect(bar.low, `${s.id} never reached the band`).toBeLessThanOrEqual(s.kijun + halfBand + 1e-12);
          expect(bar.high, `${s.id} never reached the band`).toBeGreaterThanOrEqual(s.kijun - halfBand - 1e-12);
        }
      });

      /** Everything emitted cleared the gate. That is what makes it a gate. */
      it('emits nothing below the confirmation threshold', () => {
        expect(analysis.signals.length).toBeGreaterThan(0);
        for (const s of analysis.signals) {
          expect(s.score).toBeGreaterThanOrEqual(ICHIMOKU_STRATEGY.minScore);
          expect(s.score).toBeLessThanOrEqual(ICHIMOKU_SIGNAL_CHECKS);
        }
      });

      it('puts the stop and target on the correct sides, sized from the range', () => {
        for (const s of analysis.signals) {
          const risk = Math.abs(s.entry - s.stop);
          expect(risk / pipSize(symbol)).toBeCloseTo(s.rangePips * ICHIMOKU_STRATEGY.stopRange, 6);
          expect(Math.abs(s.target - s.entry) / risk).toBeCloseTo(ICHIMOKU_STRATEGY.rewardMultiple, 9);
          if (s.direction === 'LONG') {
            expect(s.stop).toBeLessThan(s.entry);
            expect(s.target).toBeGreaterThan(s.entry);
          } else {
            expect(s.stop).toBeGreaterThan(s.entry);
            expect(s.target).toBeLessThan(s.entry);
          }
        }
      });

      it('never emits two signals on the same bar', () => {
        const times = analysis.signals.map((s) => s.barTime);
        expect(new Set(times).size).toBe(times.length);
      });

      it('reports signals in chronological order', () => {
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
       * shorter series also contains must come out byte-identical, score and
       * individual confirmations included. If any later bar leaks in, these
       * disagree.
       *
       * Chikou needs 26 bars AFTER a signal before it is knowable, so the
       * last stretch of the truncation legitimately differs; everything
       * before that must match exactly.
       */
      it('reads no bar it could not have seen', () => {
        const cut = Math.floor(candles.length * 0.6);
        const truncated = analyseIchimoku(candles.slice(0, cut), symbol, '1H', ICHIMOKU_STRATEGY, 0);
        const full = analyseIchimoku(candles, symbol, '1H', ICHIMOKU_STRATEGY, 0);
        const lastComparable = candles[cut - 27]!.time;

        const shape = (list: typeof full.signals) =>
          list
            .filter((s) => s.barTime <= lastComparable)
            .map((s) =>
              [s.id, s.direction, s.kumo, s.score, s.cloudBullish, s.futureCloudBullish, s.chikouFree, s.tenkanAgrees]
                .join('|'),
            );

        const fromTruncated = shape(truncated.signals);
        expect(fromTruncated.length, 'the truncation must contain signals to compare').toBeGreaterThan(10);
        expect(fromTruncated).toEqual(shape(full.signals));
      });

      /**
       * The backtest's own causality, on top of the detector's: trades that
       * closed before the cut must be identical too, since a trade's result
       * depends only on bars up to its exit.
       */
      it('produces the same closed trades from a truncated series', () => {
        const cut = Math.floor(candles.length * 0.6);
        const full = backtestIchimoku(candles, symbol, '1H');
        const part = backtestIchimoku(candles.slice(0, cut), symbol, '1H');
        const cutoff = candles[cut - 27]!.time;

        const closedBefore = (r: typeof full) =>
          r.trades
            .filter((t) => t.exitTime !== null && t.exitTime <= cutoff)
            .map((t) => `${t.id}|${t.exit}|${t.pips?.toFixed(4)}`);

        const partial = closedBefore(part);
        expect(partial.length, 'the truncation must contain closed trades').toBeGreaterThan(3);
        expect(partial).toEqual(closedBefore(full));
      });

      /**
       * Entry is the signal bar's close, so there is no fill to miss. The
       * previous strategy rested a limit at the EMA and turned away about a
       * third of its touches for want of a fill; this asserts the opposite —
       * that every eligible signal which was not crowded out became a trade.
       */
      it('turns no signal away for want of a fill', () => {
        const result = backtestIchimoku(candles, symbol, '1H');
        expect(result.trades.length).toBeGreaterThan(10);
        expect(result.trades.length + result.filtered + result.skippedWhileOpen).toBe(result.signals);
        expect(result.filtered).toBe(0);
      });

      it('enters at a price the entry bar traded, on every trade', () => {
        const byTime = new Map(candles.map((c) => [c.time, c]));
        for (const t of backtestIchimoku(candles, symbol, '1H').trades) {
          const bar = byTime.get(t.entryTime)!;
          expect(t.entry, `${t.id} filled outside its bar`).toBeGreaterThanOrEqual(bar.low);
          expect(t.entry, `${t.id} filled outside its bar`).toBeLessThanOrEqual(bar.high);
        }
      });

      it('leaves a usable level on the last bar', () => {
        const level = analysis.level;
        expect(level).not.toBeNull();
        // Kijun must be a real price for this pair, not a stray 0 or NaN.
        const last = candles.at(-1)!.close;
        expect(Math.abs((level!.kijun - last) / pipSize(symbol))).toBeLessThan(5000);
        expect(level!.range).toBeGreaterThan(0);
        expect(level!.band).toBeGreaterThan(0);
      });
    });
  }
});

/**
 * The system across EVERY pair the scanner trades, and through the backtest.
 *
 * WHY THIS IS A SEPARATE FILE FROM ichimokuSystem.test.ts
 * ──────────────────────────────────────────────────────
 * That file tests the RULES: it takes each condition OANDA's article states
 * and checks the detector honours it, in depth, on three pairs. This file
 * tests BREADTH and INTEGRATION — the same detector over all six fixtures,
 * and the backtest's own causality on top of the detector's. The division
 * matters because the two fail for different reasons: a rule regression shows
 * up on any pair, while the failures this file is for (a pair that goes
 * silent, a yen cross whose pip size is wrong, a trade resolved against bars
 * it never held) show up only in aggregate or only downstream.
 *
 * Neither is a backtest. Nothing here claims the strategy is profitable; the
 * measured numbers live in the README.
 */
import { describe, expect, it } from 'vitest';
import audusd from '../../../fixtures/market/AUDUSD_1H.csv?raw';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import gbpjpy from '../../../fixtures/market/GBPJPY_1H.csv?raw';
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
import usdcad from '../../../fixtures/market/USDCAD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import { analyseIchimoku } from './ichimokuSystem';
import { backtest } from './backtest';

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

describe('the system on real OANDA candles, every pair', () => {
  for (const [csv, symbol] of PAIRS) {
    describe(symbol, () => {
      const candles = loadCandles(csv);
      const analysis = analyseIchimoku(candles, symbol, '1H');

      it('loads the fixture it claims to (so this cannot pass on an empty file)', () => {
        expect(candles.length).toBeGreaterThan(4000);
        expect(candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close)).toBe(true);
      });

      /**
       * The arm/re-arm rule is the whole reason this is a state machine. A
       * market riding its Kijun would otherwise signal on every bar, and on
       * 5000 bars that failure is obvious where on a 20-bar fixture it is not.
       *
       * These bounds are deliberately wide. The rate is a PROPERTY of the
       * article's rules, not a number we chose — measured at 10–15% of bars,
       * because a close back through Kijun inside a trend is a common event
       * and OANDA's pullback rule asks for little else. Narrow bounds here
       * would make every honest change to the strategy look like a break.
       */
      it('fires sometimes, but nowhere near every bar', () => {
        const rate = analysis.signals.length / candles.length;
        const note = `${analysis.signals.length} signals in ${candles.length} bars`;
        expect(rate, note).toBeGreaterThan(0.01);
        expect(rate, note).toBeLessThan(0.25);
      });

      /** Both entries have to survive on every pair, not just on EUR/USD. */
      it('produces both entry types', () => {
        const kinds = new Set(analysis.signals.map((s) => s.entryType));
        expect([...kinds].sort()).toEqual(['breakout', 'pullback']);
      });

      /**
       * Stops come from STRUCTURE now — Kijun for a pullback, the far cloud
       * edge for a breakout — so their size is whatever the market's own
       * geometry says. This is the sanity bound that catches a pip size
       * applied to the wrong quote currency, which on a yen cross is a factor
       * of 100 and would otherwise sail through every other test.
       */
      it('sizes every stop like a real price distance for this pair', () => {
        for (const s of analysis.signals) {
          expect(s.stopPips, `${s.id} has a degenerate stop`).toBeGreaterThan(0.5);
          expect(s.stopPips, `${s.id} has an absurd stop`).toBeLessThan(500);
          expect(Math.abs(s.entry - s.stop) / pipSize(symbol)).toBeCloseTo(s.stopPips, 6);
        }
      });

      /**
       * The backtest's own causality, on top of the detector's: a trade's
       * result depends only on bars up to its exit, so every trade that
       * closed before the cut must come out identical from a series that ends
       * there. This is what stops a change to the walk-forward from quietly
       * resolving trades against bars they never held.
       */
      it('produces the same closed trades from a truncated series', () => {
        const cut = Math.floor(candles.length * 0.6);
        const full = backtest(candles, symbol, '1H');
        const part = backtest(candles.slice(0, cut), symbol, '1H');
        const cutoff = candles[cut - 27]!.time;

        const closedBefore = (r: typeof full) =>
          r.trades
            .filter((t) => t.exitTime !== null && t.exitTime <= cutoff)
            .map((t) => `${t.id}|${t.entryType}|${t.exit}|${t.pips?.toFixed(4)}`);

        const partial = closedBefore(part);
        expect(partial.length, 'the truncation must contain closed trades').toBeGreaterThan(3);
        expect(partial).toEqual(closedBefore(full));
      });

      /**
       * Entry is the signal bar's close, so there is no fill to miss. A
       * retired strategy rested a limit at an EMA and turned away about a
       * third of its touches for want of a fill; this asserts the opposite —
       * every signal not crowded out became a trade.
       */
      it('turns no signal away for want of a fill', () => {
        const result = backtest(candles, symbol, '1H');
        expect(result.trades.length).toBeGreaterThan(10);
        expect(result.trades.length + result.filtered + result.skippedWhileOpen).toBe(result.signals);
        expect(result.filtered).toBe(0);
      });

      it('enters at a price the entry bar traded, on every trade', () => {
        const byTime = new Map(candles.map((c) => [c.time, c]));
        for (const t of backtest(candles, symbol, '1H').trades) {
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

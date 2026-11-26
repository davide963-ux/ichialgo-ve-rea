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
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
import usdcad from '../../../fixtures/market/USDCAD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';
import { BARS_PER_FIXTURE } from '../../hooks/useBacktest';
import { ICHIMOKU } from '../../config/ichimokuStrategy';
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

/**
 * Every fixture here is a pair the scanner actually trades. That is not a
 * coincidence to rely on: `useBacktest.test.ts` asserts the two lists match,
 * because a fixture for an untraded pair once reached the published results
 * and made the strategy look worse than the thing being run.
 */
describe('the system on real OANDA candles, every traded pair', () => {
  for (const [csv, symbol] of PAIRS) {
    describe(symbol, () => {
      const candles = loadCandles(csv);
      const analysis = analyseIchimoku(candles, symbol, '1H');

      /**
       * Exactly BARS_PER_FIXTURE, not merely "a lot": the backtest page shows
       * a candle count by multiplying that constant by the number of pairs,
       * so if a fixture is ever replaced with a shorter one the page would
       * quietly overstate how much data is behind its numbers.
       */
      it('loads the fixture it claims to (so this cannot pass on an empty file)', () => {
        expect(candles.length).toBe(BARS_PER_FIXTURE);
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
      /**
       * Entry is the signal bar's close, so there is no fill to miss, and the
       * detector no longer offers a signal while a trade is running. Every
       * signal therefore becomes a trade — on EVERY pair, which is the part
       * worth checking here. The identity held on EUR/USD alone for a while
       * before this ran across the set, and "it balances on the pair I looked
       * at" is exactly how an accounting hole survives.
       */
      it('turns every signal into a trade, with nothing unaccounted for', () => {
        const result = backtest(candles, symbol, '1H');
        expect(result.trades.length).toBeGreaterThan(10);
        expect(result.trades.length + result.filtered + result.skippedWhileOpen).toBe(result.signals);
        expect(result.filtered).toBe(0);
        expect(result.skippedWhileOpen).toBe(0);
        expect(result.trades.length).toBe(result.signals);
        // Rows split cleanly into resolved and still-running; nothing else.
        expect(result.metrics.trades + result.metrics.stillOpen).toBe(result.trades.length);
      });

      it('enters at a price the entry bar traded, on every trade', () => {
        const byTime = new Map(candles.map((c) => [c.time, c]));
        for (const t of backtest(candles, symbol, '1H').trades) {
          const bar = byTime.get(t.entryTime)!;
          expect(t.entry, `${t.id} filled outside its bar`).toBeGreaterThanOrEqual(bar.low);
          expect(t.entry, `${t.id} filled outside its bar`).toBeLessThanOrEqual(bar.high);
        }
      });

      /**
       * What the break-even rule must never do on real candles: lose more
       * than the trade risked, or quietly turn into a different ticket.
       *
       * A scratch lands on the LOCKED price, a pip the profitable side of
       * the entry — not on the entry itself. That one pip is the point of
       * the rule as it now stands: it is what turns the commonest outcome of
       * the strategy from "lose the spread" into "cost nothing". Asserting
       * it in pips rather than in price keeps the check honest on yen
       * crosses, where a pip is a hundred times bigger.
       */
      it('scratches a pip into profit, and never loses more than the original risk', () => {
        const result = backtest(candles, symbol, '1H', { costPips: 0 });
        const scratched = result.trades.filter((t) => t.exit === 'be');
        expect(scratched.length, 'break-even must actually fire on real bars').toBeGreaterThan(10);

        for (const t of result.trades) {
          if (t.pips === null) continue;
          // No outcome may exceed the risk the trade was taken with.
          expect(t.pips, `${t.id} lost more than it risked`).toBeGreaterThanOrEqual(-t.stopPips - 1e-6);
          if (t.exit === 'be') {
            // Before costs a scratch is worth exactly what was locked in.
            expect(t.pips, `${t.id} scratched for the wrong amount`).toBeCloseTo(
              ICHIMOKU.breakEvenLockPips,
              6,
            );
            const beyondEntry =
              t.direction === 'LONG' ? t.exitPrice! - t.entry : t.entry - t.exitPrice!;
            expect(beyondEntry, `${t.id} scratched on the wrong side of entry`).toBeGreaterThan(0);
          }
        }
      });

      /**
       * And the reason that pip matters: with a one-pip spread the scratch
       * nets zero. On the entry itself it would net minus one, on every one
       * of them — which on this strategy is most trades.
       */
      it('nets zero on a scratch once a one-pip spread is paid', () => {
        for (const t of backtest(candles, symbol, '1H', { costPips: 1 }).trades) {
          if (t.exit === 'be') expect(t.pips).toBeCloseTo(0, 6);
        }
      });

      /**
       * The rule's whole purpose, stated as a measurement rather than a hope:
       * turning it on must convert stop-outs into scratches. It is checked
       * here rather than only in the README because a silent regression — a
       * trigger that never arms — would look exactly like "the market
       * changed".
       */
      it('converts stop-outs into scratches when switched on', () => {
        const off = backtest(candles, symbol, '1H', { costPips: 0, config: { ...ICHIMOKU, breakEvenAtPips: 0 } });
        const on = backtest(candles, symbol, '1H', { costPips: 0 });

        expect(off.metrics.breakEvens).toBe(0);
        expect(on.metrics.breakEvens).toBeGreaterThan(10);

        const slRate = (r: typeof on) =>
          r.trades.filter((t) => t.exit === 'sl').length / r.trades.filter((t) => t.pips !== null).length;
        expect(slRate(on), 'the share of full stop-outs must fall').toBeLessThan(slRate(off));
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

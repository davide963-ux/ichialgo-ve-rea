/**
 * OANDA's Tenkan/Kijun trend continuation pullback.
 *
 * These tests are written against the ARTICLE, not against the code: each one
 * names a condition OANDA states and checks it holds for every signal the
 * detector produces on 5000 real bars. That is the only way to know the
 * implementation matches the source rather than matching itself.
 *
 * The article's rules, for reference:
 *   Price above the Cloud (green coloured).
 *     - Tenkan-sen is above Kijun-sen.
 *     - Pullback touches or dips slightly below Tenkan-sen or Kijun-sen.
 *     - Price closes above Kijun-sen with a bullish candlestick.
 */
import { describe, expect, it } from 'vitest';
import { OANDA_PULLBACK } from '../../config/ichimokuStrategy';
import { kumoSide } from '../../lib/indicators';
import type { Candle } from '../marketData/types';
import { ichimokuContext, minBarsFor } from './ichimokuBars';
import { analyseOandaPullback, minBars } from './oandaPullback';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
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

const PAIRS = [
  [eurusd, 'EUR/USD'],
  [gbpusd, 'GBP/USD'],
  [usdjpy, 'USD/JPY'],
] as const;

describe('minBars', () => {
  it('waits for a cloud in effect plus the range window', () => {
    expect(minBars()).toBe(minBarsFor(OANDA_PULLBACK.rangePeriod));
    expect(minBars()).toBe(52 + 26 + 26);
  });

  it('reports nothing before then', () => {
    const candles = parseCsv(eurusd).slice(0, minBars() - 1);
    const out = analyseOandaPullback(candles, 'EUR/USD', '1H');
    expect(out.reason).toBe('not-enough-bars');
    expect(out.signals).toEqual([]);
  });
});

for (const [csv, symbol] of PAIRS) {
  describe(`OANDA's rules on real ${symbol} candles`, () => {
    const candles = parseCsv(csv);
    const ctx = ichimokuContext(candles, symbol, OANDA_PULLBACK.rangePeriod);
    const index = new Map(candles.map((c, i) => [c.time, i]));
    const { signals } = analyseOandaPullback(candles, symbol, '1H', OANDA_PULLBACK, 0);

    /**
     * This rule is BUSY, and the bounds say so. Measured across the three
     * fixtures it fires on 9-13% of bars — roughly one signal every eight —
     * against 2% for our own. That is what removing a gate does: OANDA's
     * pullback has four conditions and none of them is a threshold, so
     * anything that meets the shape qualifies. The bound is wide enough not
     * to be a snapshot and tight enough to catch a detector that has gone
     * silent or started firing on everything.
     */
    it('produces signals at all, and not on every bar', () => {
      const rate = signals.length / candles.length;
      const note = `${signals.length} signals in ${candles.length} bars`;
      expect(rate, note).toBeGreaterThan(0.02);
      expect(rate, note).toBeLessThan(0.2);
    });

    /** "Price above the Cloud" / "Price below the Cloud". */
    it('only fires while price is clear of the Kumo, on the correct side', () => {
      for (const s of signals) {
        const i = index.get(s.barTime)!;
        const side = kumoSide(ctx.series, i, candles[i]!.close);
        expect(side, `${s.id} fired inside the cloud`).not.toBe('inside');
        expect(s.direction).toBe(side === 'above' ? 'LONG' : 'SHORT');
      }
    });

    /** "Tenkan-sen (Conversion line) is above Kijun-sen (Base line)." */
    it('requires Tenkan on the trade’s side of Kijun at the signal bar', () => {
      for (const s of signals) {
        expect(s.tenkan, `${s.id} has no Tenkan`).not.toBeNull();
        if (s.direction === 'LONG') expect(s.tenkan!).toBeGreaterThan(s.kijun);
        else expect(s.tenkan!).toBeLessThan(s.kijun);
      }
    });

    /** "Price closes above Kijun-sen (Base line) with a bullish candlestick." */
    it('fires only on a close through Kijun, on a candle of the trade’s colour', () => {
      for (const s of signals) {
        const bar = candles[index.get(s.barTime)!]!;
        expect(s.entry, 'entry is the confirming close').toBe(bar.close);
        if (s.direction === 'LONG') {
          expect(bar.close, `${s.id} did not close above Kijun`).toBeGreaterThan(s.kijun);
          expect(bar.close, `${s.id} is not a bullish candle`).toBeGreaterThan(bar.open);
        } else {
          expect(bar.close, `${s.id} did not close below Kijun`).toBeLessThan(s.kijun);
          expect(bar.close, `${s.id} is not a bearish candle`).toBeLessThan(bar.open);
        }
      }
    });

    /**
     * "Pullback touches or dips slightly below Tenkan-sen or Kijun-sen."
     *
     * The touch is on an EARLIER bar than the confirming close — that is the
     * whole shape of the setup, and the article's own USD/JPY example has
     * hours between them. So this walks back from the signal and requires a
     * bar that actually reached a line within the window.
     */
    it('has a real pullback to a line behind every signal', () => {
      for (const s of signals) {
        const i = index.get(s.barTime)!;
        const long = s.direction === 'LONG';
        let touched = false;
        for (let j = i - 1; j >= Math.max(1, i - OANDA_PULLBACK.confirmWithinBars); j--) {
          const f = ctx.at(j);
          if (!f) continue;
          const line = f.tenkan === null ? f.kijun : long ? Math.max(f.tenkan, f.kijun) : Math.min(f.tenkan, f.kijun);
          if (long ? f.bar.low <= line : f.bar.high >= line) {
            touched = true;
            break;
          }
        }
        expect(touched, `${s.id} fired with no pullback behind it`).toBe(true);
      }
    });

    /** The article uses none of these for this strategy. */
    it('does not quietly require the cloud’s colour, the forward cloud or Chikou', () => {
      const labels = new Set(signals.flatMap((s) => s.checks.map((c) => c.label)));
      for (const l of labels) {
        expect(l).not.toMatch(/Chikou/);
        expect(l).not.toMatch(/26 bars ahead/);
      }
      // And some signal must exist whose cloud colour disagrees with it, or
      // the rule is secretly filtering on something the article does not.
      const disagreeing = signals.filter((s) =>
        s.direction === 'LONG' ? s.senkouA < s.senkouB : s.senkouA > s.senkouB,
      );
      expect(disagreeing.length, 'cloud colour must not be acting as a hidden gate').toBeGreaterThan(0);
    });

    it('never emits two signals on one bar, and reports them in order', () => {
      const times = signals.map((s) => s.barTime);
      expect(new Set(times).size).toBe(times.length);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    /**
     * Causality. A rule that reads bars it could not have seen prints an edge
     * that does not exist, and nothing downstream can detect it.
     */
    it('reads no bar it could not have seen', () => {
      const cut = Math.floor(candles.length * 0.6);
      const part = analyseOandaPullback(candles.slice(0, cut), symbol, '1H', OANDA_PULLBACK, 0);
      const safeUntil = candles[cut - 2]!.time;
      const pick = (list: typeof signals) => list.filter((x) => x.barTime <= safeUntil).map((x) => x.id);
      expect(pick(part.signals).length).toBeGreaterThan(3);
      expect(pick(part.signals)).toEqual(pick(signals));
    });

    it('is deterministic', () => {
      const again = analyseOandaPullback(candles, symbol, '1H', OANDA_PULLBACK, 0);
      expect(again.signals).toEqual(signals);
    });
  });
}

describe('the waiting window', () => {
  const candles = parseCsv(eurusd);

  /**
   * The confirmation window is OURS, not OANDA's — the article sets no limit.
   * Shrinking it must only ever remove signals, never add one: that is what
   * makes it a bound on waiting rather than a parameter that changes the rule.
   */
  it('only ever removes signals as it tightens', () => {
    const wide = analyseOandaPullback(candles, 'EUR/USD', '1H', { ...OANDA_PULLBACK, confirmWithinBars: 26 }, 0);
    const tight = analyseOandaPullback(candles, 'EUR/USD', '1H', { ...OANDA_PULLBACK, confirmWithinBars: 3 }, 0);

    expect(tight.signals.length).toBeLessThan(wide.signals.length);
    const wideIds = new Set(wide.signals.map((s) => s.id));
    for (const s of tight.signals) expect(wideIds.has(s.id)).toBe(true);
  });
});

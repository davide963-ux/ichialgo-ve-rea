/**
 * The Ichimoku system.
 *
 * These tests are written against the ARTICLE, not against the code: each one
 * names a condition OANDA states and checks it holds for every signal the
 * detector produces on 5000 real bars. That is the only way to know the
 * implementation matches the source rather than matching itself.
 *
 * The first test is about what the strategy is NOT allowed to depend on.
 * "Pure Ichimoku" is a claim that rots silently — someone adds a volatility
 * floor under a stop and nothing fails — so it is checked mechanically.
 */
import { describe, expect, it } from 'vitest';
import { ICHIMOKU } from '../../config/ichimokuStrategy';
import { kumoSide } from '../../lib/indicators';
import type { Candle } from '../marketData/types';
import { ichimokuContext, minBarsFor } from './ichimokuBars';
import { analyseIchimoku, ichimokuSignalId, minBars, rangeOver } from './ichimokuSystem';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';
import gbpusd from '../../../fixtures/market/GBPUSD_1H.csv?raw';
import usdjpy from '../../../fixtures/market/USDJPY_1H.csv?raw';
import systemSrc from './ichimokuSystem.ts?raw';
import configSrc from '../../config/ichimokuStrategy.ts?raw';
import barsSrc from './ichimokuBars.ts?raw';
import zonesSrc from './cloudZones.ts?raw';
import ticketSrc from './signalTicket.ts?raw';
import planSrc from './tradePlan.ts?raw';

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

describe('purity', () => {
  /**
   * A stop floor in an average true range, or a trend filter on a moving
   * average, would both work fine and both break the promise. OANDA's own
   * article closes by recommending the Cloud be paired with RSI or
   * Stochastic — a reasonable suggestion, and exactly the kind of thing that
   * arrives one day as a small addition. It would fail this.
   */
  it('contains no EMA and no ATR, in any strategy file', () => {
    for (const [name, src] of [
      ['ichimokuSystem.ts', systemSrc],
      ['ichimokuStrategy.ts', configSrc],
      ['ichimokuBars.ts', barsSrc],
      ['cloudZones.ts', zonesSrc],
      ['signalTicket.ts', ticketSrc],
      ['tradePlan.ts', planSrc],
    ] as const) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${name} must not use an EMA`).not.toMatch(/\bema\b/i);
      expect(code, `${name} must not use an ATR`).not.toMatch(/\batr\b/i);
    }
  });
});

describe('rangeOver', () => {
  it('is the high-low span of the window, and null before it is full', () => {
    const c = (h: number, l: number): Candle => ({ time: 0, open: h, high: h, low: l, close: h, volume: null, complete: true });
    const bars = [c(3, 1), c(5, 2), c(4, 0)];
    expect(rangeOver(bars, 3)).toEqual([null, null, 5]);
    expect(rangeOver(bars, 2)).toEqual([null, 4, 5]);
  });
});

describe('minBars', () => {
  /**
   * 78, not 104: the cloud in effect is the binding constraint and the range
   * window is already satisfied long before it. The second assertion is the
   * one that matters — the guard must agree with the first bar the detector
   * will actually answer for, or truncating a series changes the result for
   * reasons unrelated to causality.
   */
  it('waits exactly as long as the cloud in effect requires', () => {
    expect(minBars()).toBe(minBarsFor(ICHIMOKU.rangePeriod));
    expect(minBars()).toBe(78);

    const candles = parseCsv(eurusd);
    const ctx = ichimokuContext(candles, 'EUR/USD', ICHIMOKU.rangePeriod);
    const first = candles.findIndex((_, i) => ctx.at(i) !== null);
    expect(first, 'the guard must not reject bars the detector can analyse').toBe(minBars() - 1);
  });

  it('reports nothing before then', () => {
    const out = analyseIchimoku(parseCsv(eurusd).slice(0, minBars() - 1), 'EUR/USD', '1H');
    expect(out.reason).toBe('not-enough-bars');
    expect(out.signals).toEqual([]);
  });
});

for (const [csv, symbol] of PAIRS) {
  describe(`the system on real ${symbol} candles`, () => {
    const candles = parseCsv(csv);
    const ctx = ichimokuContext(candles, symbol, ICHIMOKU.rangePeriod);
    const index = new Map(candles.map((c, i) => [c.time, i]));
    const { signals } = analyseIchimoku(candles, symbol, '1H', ICHIMOKU, 0);
    const breakouts = signals.filter((s) => s.entryType === 'breakout');
    const pullbacks = signals.filter((s) => s.entryType === 'pullback');

    it('produces both entries, and not on every bar', () => {
      expect(breakouts.length, 'breakouts').toBeGreaterThan(0);
      expect(pullbacks.length, 'pullbacks').toBeGreaterThan(10);
      const rate = signals.length / candles.length;
      expect(rate, `${signals.length} signals in ${candles.length} bars`).toBeLessThan(0.2);
    });

    /** "Price above the Cloud" / "Price below the Cloud". */
    it('only fires with price clear of the Kumo, on the correct side', () => {
      for (const s of signals) {
        const i = index.get(s.barTime)!;
        const side = kumoSide(ctx.series, i, candles[i]!.close);
        expect(side, `${s.id} fired inside the cloud`).not.toBe('inside');
        expect(s.direction).toBe(side === 'above' ? 'LONG' : 'SHORT');
        expect(s.kumo).toBe(side);
      }
    });

    /**
     * OANDA compares Chikou with "its prior 26-period price" — that bar's
     * CLOSE. A stricter test against the whole bar's range is a different
     * rule, and using it here would quietly change the strategy.
     */
    it('validates every signal with Chikou against the prior 26-period close', () => {
      for (const s of signals) {
        const i = index.get(s.barTime)!;
        const back = candles[i - 26];
        if (!back) continue;
        if (s.direction === 'LONG') expect(candles[i]!.close).toBeGreaterThan(back.close);
        else expect(candles[i]!.close).toBeLessThan(back.close);
      }
    });

    describe('entry A: the Kumo breakout', () => {
      /** "Cloud is turning bullish (Span A crossing above span B)". */
      it('requires the cloud 26 bars ahead to agree', () => {
        for (const s of breakouts) {
          expect(s.senkouAheadA).not.toBeNull();
          if (s.direction === 'LONG') expect(s.senkouAheadA!).toBeGreaterThan(s.senkouAheadB!);
          else expect(s.senkouAheadA!).toBeLessThan(s.senkouAheadB!);
        }
      });

      /**
       * A break is a TRANSITION, not a state. Price that has sat above the
       * cloud for fifty bars has not "broken above" it, and testing the state
       * instead would fire continuously through every trend.
       */
      it('fires on a crossing, never on a pair that is simply trending', () => {
        for (const s of breakouts) {
          const i = index.get(s.barTime)!;
          const detail = s.checks.find((c) => c.label.startsWith('Price broke'))!.detail;
          const barsAgo = /^(\d+) bars? ago/.exec(detail)?.[1];
          const at = barsAgo === undefined ? i : i - Number(barsAgo);
          const before = ctx.at(at - 1);
          const after = ctx.at(at);
          expect(after!.side, `${s.id} did not change side at its break bar`).not.toBe(before!.side);
        }
      });

      /** The behaviour both of OANDA's worked examples show. */
      it('lets the span twist arrive after the break', () => {
        const later = breakouts.filter((s) => /\d+ bars? ago/.test(s.checks[0]!.detail));
        expect(later.length, 'the two-stage case must actually occur').toBeGreaterThan(0);
      });

      /** "...through a thick Cloud are considered more significant." */
      it('grades cloud thickness without gating on it', () => {
        for (const s of breakouts) {
          expect(s.checks.find((c) => c.label.includes('thick'))!.required).toBe(false);
        }
      });

      /**
       * A breakout bets price has LEFT the zone, so its stop belongs beyond
       * the far edge. A stop inside the cloud would be taken out by the cloud
       * the trade just crossed.
       */
      it('stops beyond the far cloud edge', () => {
        for (const s of breakouts) {
          const far = s.direction === 'LONG' ? Math.min(s.senkouA, s.senkouB) : Math.max(s.senkouA, s.senkouB);
          expect(s.stopLevel).toBeCloseTo(far, 10);
          if (s.direction === 'LONG') expect(s.stop).toBeLessThan(s.stopLevel);
          else expect(s.stop).toBeGreaterThan(s.stopLevel);
        }
      });
    });

    describe('entry B: the Tenkan/Kijun pullback', () => {
      /** "Tenkan-sen (Conversion line) is above Kijun-sen (Base line)." */
      it('requires Tenkan on the trade’s side of Kijun', () => {
        for (const s of pullbacks) {
          expect(s.tenkan).not.toBeNull();
          if (s.direction === 'LONG') expect(s.tenkan!).toBeGreaterThan(s.kijun);
          else expect(s.tenkan!).toBeLessThan(s.kijun);
        }
      });

      /** "Price closes above Kijun-sen with a bullish candlestick." */
      it('fires only on a close through Kijun, on a candle of the trade’s colour', () => {
        for (const s of pullbacks) {
          const bar = candles[index.get(s.barTime)!]!;
          expect(s.entry).toBe(bar.close);
          if (s.direction === 'LONG') {
            expect(bar.close).toBeGreaterThan(s.kijun);
            expect(bar.close).toBeGreaterThan(bar.open);
          } else {
            expect(bar.close).toBeLessThan(s.kijun);
            expect(bar.close).toBeLessThan(bar.open);
          }
        }
      });

      /**
       * "Pullback touches or dips slightly below Tenkan-sen or Kijun-sen."
       * The touch is on an EARLIER bar than the confirming close — the shape
       * of the setup, and the article's USD/JPY example has hours between.
       */
      it('has a real pullback to a line behind every signal', () => {
        for (const s of pullbacks) {
          const i = index.get(s.barTime)!;
          const long = s.direction === 'LONG';
          let touched = false;
          for (let j = i - 1; j >= Math.max(1, i - ICHIMOKU.confirmWithinBars); j--) {
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

      /**
       * A pullback bets the base line holds. If it does not, the reason for
       * the trade is gone — so that is where the stop belongs, and it makes
       * the pullback's risk much smaller than a breakout's.
       */
      it('stops beyond Kijun-sen, and risks less than a breakout does', () => {
        for (const s of pullbacks) {
          expect(s.stopLevel).toBeCloseTo(s.kijun, 10);
          if (s.direction === 'LONG') expect(s.stop).toBeLessThan(s.kijun);
          else expect(s.stop).toBeGreaterThan(s.kijun);
        }
        if (breakouts.length > 3) {
          const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
          expect(mean(pullbacks.map((s) => s.stopPips))).toBeLessThan(mean(breakouts.map((s) => s.stopPips)));
        }
      });
    });

    it('gives every signal a stable, unique id and a usable ticket', () => {
      const ids = new Set(signals.map((s) => s.id));
      expect(ids.size).toBe(signals.length);
      for (const s of signals) {
        expect(s.id).toBe(ichimokuSignalId(symbol, '1H', s.barTime));
        expect(s.stopPips).toBeGreaterThan(0);
        expect(Math.abs(s.target - s.entry) / Math.abs(s.entry - s.stop)).toBeCloseTo(ICHIMOKU.rewardMultiple, 9);
        if (s.direction === 'LONG') {
          expect(s.stop).toBeLessThan(s.entry);
          expect(s.target).toBeGreaterThan(s.entry);
        } else {
          expect(s.stop).toBeGreaterThan(s.entry);
          expect(s.target).toBeLessThan(s.entry);
        }
        // Every required check passed, or the signal would not exist.
        for (const c of s.checks) if (c.required) expect(c.pass, `${s.id}: ${c.label}`).toBe(true);
      }
    });

    it('reports signals in chronological order, one per bar', () => {
      const times = signals.map((s) => s.barTime);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(new Set(times).size).toBe(times.length);
    });

    /**
     * THE TEST EVERYTHING ELSE RESTS ON. A rule that reads bars it could not
     * have seen prints an edge that does not exist, and nothing downstream
     * can detect it — the backtest and its confidence interval are both
     * computed faithfully from a fiction.
     */
    it('reads no bar it could not have seen', () => {
      const cut = Math.floor(candles.length * 0.6);
      const part = analyseIchimoku(candles.slice(0, cut), symbol, '1H', ICHIMOKU, 0);
      const safeUntil = candles[cut - 2]!.time;
      const pick = (list: typeof signals) =>
        list.filter((x) => x.barTime <= safeUntil).map((x) => `${x.id}|${x.entryType}|${x.stop}`);
      expect(pick(part.signals).length).toBeGreaterThan(3);
      expect(pick(part.signals)).toEqual(pick(signals));
    });

    it('is deterministic', () => {
      expect(analyseIchimoku(candles, symbol, '1H', ICHIMOKU, 0).signals).toEqual(signals);
    });

    it('leaves a usable level on the last bar', () => {
      const { level } = analyseIchimoku(candles, symbol, '1H', ICHIMOKU, 0);
      expect(level).not.toBeNull();
      expect(level!.range).toBeGreaterThan(0);
      expect(level!.pending === null || level!.pending === 'breakout' || level!.pending === 'pullback').toBe(true);
      // `armed` and `pending` are two views of one fact and must not disagree.
      expect(level!.armed).toBe(level!.pending === null);
    });
  });
}

describe('the Chikou filter on the pullback', () => {
  const candles = parseCsv(eurusd);

  /**
   * The article attaches the filter to the breakout and separately says the
   * four approaches work together. Applying it to the pullback as well is the
   * work-together reading; turning it off is the literal one. Either way it
   * must only ever REMOVE pullbacks, which is what makes it a filter and not
   * a different strategy.
   */
  it('removes pullbacks when on, and never invents one', () => {
    const both = analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU, chikouFiltersPullback: true }, 0);
    const literal = analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU, chikouFiltersPullback: false }, 0);

    const p = (r: typeof both) => r.signals.filter((s) => s.entryType === 'pullback');
    expect(p(literal).length).toBeGreaterThan(p(both).length);

    for (const s of p(both)) {
      const c = s.checks.find((x) => x.label.includes('Chikou'))!;
      expect(c.required).toBe(true);
      expect(c.pass).toBe(true);
    }
    for (const s of p(literal)) {
      expect(s.checks.find((x) => x.label.includes('Chikou'))!.required).toBe(false);
    }
  });
});

describe('the waiting windows', () => {
  const candles = parseCsv(eurusd);
  const wide = analyseIchimoku(candles, 'EUR/USD', '1H', ICHIMOKU, 0);
  const run = (over: Partial<typeof ICHIMOKU>) => analyseIchimoku(candles, 'EUR/USD', '1H', { ...ICHIMOKU, ...over }, 0);
  const ids = (r: typeof wide) => new Set(r.signals.map((s) => s.id));

  /**
   * Both windows are OURS. The article sets no limit on how long a setup may
   * wait for its second event, and the shape of its own examples — hours
   * between the USD/JPY dip and its confirming close — is why a limit has to
   * exist at all. So the question for each is not "is the value right" but
   * "does the value impose an opinion", and the answer is measured, not
   * assumed.
   *
   * THE CONFIRMATION WINDOW IMPOSES NONE. Measured on these bars, the close
   * that confirms a pullback arrives on the VERY NEXT bar in 537 of 560 cases,
   * and the longest wait seen on any pair is 6 bars:
   *
   *   lag (bars)   1     2    3    4    6
   *   EUR/USD      537   21   2    -    -
   *   USD/JPY      521   24   11   2    1
   *
   * At 26 the bound therefore never binds: it is a guard against a stale
   * pending, not a tuning knob, and the pullback rule is effectively
   * parameter-free. This test pins that, so if a change ever makes the value
   * matter, it is not discovered as a mystery difference in the backtest.
   */
  it('the confirmation window never binds at its configured value', () => {
    expect(ICHIMOKU.confirmWithinBars).toBe(26);
    for (const n of [26, 12, 7]) expect(run({ confirmWithinBars: n }).signals).toEqual(wide.signals);
  });

  /** It starts to bite only when it is shorter than the lag itself. */
  it('the confirmation window is a filter once it is short enough to bite', () => {
    const tight = run({ confirmWithinBars: 1 });
    expect(tight.signals.length).toBeLessThan(wide.signals.length);
    // What it adds is a pullback, never a breakout — see the twist test below
    // for why releasing a pair can hand the slot to the other entry.
    const wideIds = ids(wide);
    for (const s of tight.signals.filter((x) => !wideIds.has(x.id))) expect(s.entryType).toBe('pullback');
  });

  /**
   * A shorter TWIST window produces a handful of signals the wide run does
   * not have, and the reason is worth stating because it reads as a bug. A
   * breakout waiting for its span twist HOLDS the pair — one position per
   * pair, so the pullback entry cannot arm underneath it. Expiring that wait
   * sooner releases the pair, and a pullback it was sitting on top of fires
   * instead. So what a shorter twist window adds is always a pullback: on the
   * breakout itself, waiting less can only ever remove.
   */
  it('a shorter twist window trades one entry for the other', () => {
    const tight = run({ twistWithinBars: 3 });
    expect(tight.signals.length).toBeLessThan(wide.signals.length);

    const wideIds = ids(wide);
    const added = tight.signals.filter((s) => !wideIds.has(s.id));
    expect(added.length, 'the trade-off must occur, or this test proves nothing').toBeGreaterThan(0);
    for (const s of added) expect(s.entryType, `${s.id} was added`).toBe('pullback');

    const tightIds = ids(tight);
    const lost = wide.signals.filter((s) => s.entryType === 'breakout' && !tightIds.has(s.id));
    expect(lost.length, 'and it must cost more breakouts than it gains pullbacks').toBeGreaterThan(added.length);
  });
});

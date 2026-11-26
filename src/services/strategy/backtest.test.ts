/**
 * The harness, not the strategy.
 *
 * Every test here is about a decision that changes the headline number: which
 * bar can close a trade, what happens when one bar covers both exits, whether
 * an unfinished trade is counted. Those are the ways a backtest lies.
 *
 * The walk-forward tests run on the REAL fixture rather than a hand-built
 * series, and that is not laziness. Ichimoku needs 104 bars before it reports
 * anything and a cloud it is clear of; a synthetic series shaped to produce
 * one signal would be shaped by whatever the detector happens to do, which is
 * the thing under test. The fixture also crowds out signals, which is the
 * case the one-position rule exists for and a toy series cannot show.
 */
import { describe, expect, it } from 'vitest';
import { ICHIMOKU } from '../../config/ichimokuStrategy';
import type { Candle } from '../marketData/types';
import { backtest, combine, equityCurve, measure, pipsOf, type BacktestResult, type BacktestTrade } from './backtest';
import { analyseIchimoku } from './ichimokuSystem';
import { ticketLevels } from './tradePlan';
import eurusd from '../../../fixtures/market/EURUSD_1H.csv?raw';

const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({
  time,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: null,
  complete: true,
});

/** "t,o,h,l,c" rows, oldest first — the fixtures' format. */
function parseCsv(csv: string): Candle[] {
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });
}

const candles = parseCsv(eurusd);
const SYMBOL = 'EUR/USD';

const trade = (over: Partial<BacktestTrade> = {}): BacktestTrade => ({
  id: 't',
  symbol: SYMBOL,
  timeframe: '1H',
  direction: 'LONG',
  entryTime: 0,
  entry: 1.1,
  stop: 1.09,
  target: 1.12,
  exit: 'tp',
  exitTime: 3600,
  exitPrice: 1.12,
  barsHeld: 1,
  pips: 200,
  stopPips: 100,
  score: 5,
  checksTotal: 5,
  entryType: 'pullback',
  rangePips: 250,
  ...over,
});

const result = (symbol: string, exitTime: number, pips: number): BacktestResult => ({
  symbol,
  timeframe: '1H',
  bars: 0,
  signals: 0,
  filtered: 0,
  skippedWhileOpen: 0,
  trades: [trade({ symbol, exitTime, pips })],
  metrics: measure([]),
  equity: [],
});

describe('pipsOf', () => {
  it('measures a win and a loss in pips, both directions', () => {
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.09, 1.12)).toBeCloseTo(200, 6);
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.09, 1.09)).toBeCloseTo(-100, 6);
    expect(pipsOf(SYMBOL, 'SHORT', 1.1, 1.11, 1.08)).toBeCloseTo(200, 6);
    expect(pipsOf(SYMBOL, 'SHORT', 1.1, 1.11, 1.11)).toBeCloseTo(-100, 6);
  });

  /**
   * The reason the symbol is a parameter at all. The same price move is a
   * different number of pips on a JPY pair, and getting this wrong would
   * inflate every JPY result by a hundred times.
   */
  it("uses the pair's own pip size, so a JPY pip is 0.01", () => {
    expect(pipsOf('USD/JPY', 'LONG', 150.0, 149.0, 152.0)).toBeCloseTo(200, 6);
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.0999, 1.1002)).toBeCloseTo(2, 6);
  });

  /** Cost is a price distance, so it must be charged before the pip division. */
  it('charges the cost in price units, not in pips', () => {
    // 1 pip of EUR/USD = 0.0001: a +200-pip win becomes +199.
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.09, 1.12, 0.0001)).toBeCloseTo(199, 6);
    // 1 pip of USD/JPY = 0.01, a hundred times the price distance.
    expect(pipsOf('USD/JPY', 'LONG', 150.0, 149.0, 152.0, 0.01)).toBeCloseTo(199, 6);
  });

  it('refuses a zero-risk trade rather than reporting a result for it', () => {
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.1, 1.2)).toBeNull();
  });
});

describe('measure', () => {
  it('counts only closed trades, and says how many are still open', () => {
    const m = measure([trade(), trade({ pips: -100, exit: 'sl' }), trade({ pips: null, exit: 'open' })]);
    expect(m.trades).toBe(2);
    expect(m.stillOpen).toBe(1);
    expect(m.totalPips).toBeCloseTo(100, 9);
    expect(m.averagePips).toBeCloseTo(50, 9);
  });

  /**
   * The average result means nothing without the average bet beside it, so it
   * is computed over the same population: closed trades only.
   */
  it('averages the stop over closed trades, ignoring the open one', () => {
    const m = measure([
      trade({ stopPips: 10 }),
      trade({ stopPips: 30 }),
      trade({ pips: null, exit: 'open', stopPips: 1000 }),
    ]);
    expect(m.averageStopPips).toBeCloseTo(20, 9);
  });

  it('has no average stop to report for an empty run', () => {
    expect(measure([]).averageStopPips).toBeNull();
  });

  it('reports the win rate the payoff actually needs to break even', () => {
    // +200-pip wins against −100-pip losses: 1/3 must win to stand still.
    const m = measure([trade({ pips: 200 }), trade({ pips: -100 }), trade({ pips: -100 })]);
    expect(m.breakEvenWinRatePct).toBeCloseTo(33.33, 1);
    expect(m.winRatePct).toBeCloseTo(33.33, 1);
    expect(m.averagePips).toBeCloseTo(0, 9);
  });

  /**
   * The headline number alone has misled this project before: an average of
   * −1 pip over 170 trades and over 5000 are different claims, and only the
   * interval says which one you have.
   */
  it('puts a confidence interval on the average, and calls a spanning one insignificant', () => {
    const noise = measure([trade({ pips: 200 }), trade({ pips: -100 }), trade({ pips: 200 }), trade({ pips: -100 })]);
    expect(noise.standardError).toBeGreaterThan(0);
    expect(noise.ciLow! < 0 && noise.ciHigh! > 0).toBe(true);
    expect(noise.significant).toBe(false);

    // Twenty identical wins: the interval collapses and the sign is real.
    const clear = measure(Array.from({ length: 20 }, () => trade({ pips: 200 })));
    expect(clear.significant).toBe(true);
    expect(clear.ciLow).toBeGreaterThan(0);
  });

  it('has no interval to report for a single trade', () => {
    const m = measure([trade()]);
    expect(m.standardError).toBeNull();
    expect(m.significant).toBe(false);
  });

  it('measures drawdown from the running peak, not from zero', () => {
    // +200, −100, −100, +200 → peak 200, trough 0: the deepest fall is 200.
    const m = measure([trade({ pips: 200 }), trade({ pips: -100 }), trade({ pips: -100 }), trade({ pips: 200 })]);
    expect(m.maxDrawdownPips).toBeCloseTo(200, 9);
  });

  it('reports no profit factor when nothing lost, rather than a fake infinity on an empty run', () => {
    expect(measure([]).profitFactor).toBeNull();
    expect(measure([trade({ pips: 200 })]).profitFactor).toBe(Infinity);
  });
});

describe('equityCurve', () => {
  it('accumulates closed trades and skips open ones', () => {
    const curve = equityCurve([
      trade({ pips: 200, exitTime: 100 }),
      trade({ pips: null, exit: 'open', exitTime: null }),
      trade({ pips: -100, exitTime: 300 }),
    ]);
    expect(curve).toEqual([
      { time: 100, pips: 200 },
      { time: 300, pips: 100 },
    ]);
  });
});

// ── the walk-forward rules ────────────────────────────────────────────────

describe('backtestIchimoku', () => {
  const run = backtest(candles, SYMBOL, '1H');

  it('produces trades from the fixture at all', () => {
    expect(run.signals).toBeGreaterThan(50);
    expect(run.trades.length).toBeGreaterThan(20);
  });

  /**
   * Rule 1. A market order at the close fills at the close, which is the one
   * price in the bar that cannot be argued about. The previous strategy
   * entered on a resting limit and had to decide whether each bar reached it.
   */
  it("enters at the signal bar's close, so every trade is fillable by construction", () => {
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const signals = new Map(analyseIchimoku(candles, SYMBOL, '1H').signals.map((s) => [s.id, s]));
    for (const t of run.trades) {
      const entryBar = byTime.get(t.entryTime)!;
      expect(t.entry).toBeGreaterThanOrEqual(entryBar.low);
      expect(t.entry).toBeLessThanOrEqual(entryBar.high);
      // And it is the close specifically, not merely inside the bar.
      expect(t.entry).toBe(ticketLevels(signals.get(t.id)!)!.entry);
    }
  });

  /**
   * Rule 2. The fill is at the signal bar's CLOSE, so everything that bar did
   * is already behind the position. Letting it close the trade would resolve
   * a trade against bars it never held — in either direction.
   */
  it('never closes a trade on the bar that opened it', () => {
    for (const t of run.trades) {
      if (t.exitTime !== null) expect(t.exitTime).toBeGreaterThan(t.entryTime);
      if (t.exit !== 'open') expect(t.barsHeld).toBeGreaterThanOrEqual(1);
    }
  });

  it('takes the stop when one bar covers both the stop and the target', () => {
    const first = run.trades[0]!;
    // Replace everything after entry with one bar that engulfs both levels.
    const entryIndex = candles.findIndex((c) => c.time === first.entryTime);
    const wide = candles.slice(0, entryIndex + 1);
    const lo = Math.min(first.stop, first.target) - 0.005;
    const hi = Math.max(first.stop, first.target) + 0.005;
    wide.push(bar(candles[entryIndex]!.time + 3600, first.entry, hi, lo, first.entry));

    const engulfed = backtest(wide, SYMBOL, '1H');
    const same = engulfed.trades.find((t) => t.id === first.id)!;
    expect(same.exit).toBe('sl');
    // Stopped out: the loss is exactly the stop distance it recorded.
    expect(same.pips).toBeCloseTo(-same.stopPips, 6);
  });

  it('holds at most one position at a time', () => {
    const sorted = [...run.trades].sort((a, b) => a.entryTime - b.entryTime);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      expect(prev.exitTime, 'a trade opened while another was still open').not.toBeNull();
      expect(sorted[i]!.entryTime).toBeGreaterThanOrEqual(prev.exitTime!);
    }
  });

  it('leaves an unfinished trade uncounted rather than guessing its result', () => {
    for (const t of run.trades) {
      if (t.exit === 'open') expect(t.pips).toBeNull();
    }
    expect(run.metrics.trades + run.metrics.stillOpen).toBe(run.trades.length);
  });

  it('uses the same levels the live trade-plan card shows', () => {
    const signals = new Map(analyseIchimoku(candles, SYMBOL, '1H').signals.map((s) => [s.id, s]));
    for (const t of run.trades) {
      const levels = ticketLevels(signals.get(t.id)!)!;
      expect({ entry: t.entry, stop: t.stop, target: t.target }).toEqual({
        entry: levels.entry,
        stop: levels.stop,
        target: levels.target,
      });
    }
  });

  /**
   * Every signal has to be accounted for, and the identity below is what
   * guarantees none goes quietly missing.
   *
   * `skippedWhileOpen` is now ZERO, and that is the assertion worth making.
   * The one-trade-per-pair rule moved into the detector, so it no longer
   * OFFERS a signal that arrives while a position is running — this counter
   * is the harness checking the detector's work rather than doing it. A
   * non-zero value here would mean the two have drifted apart, which is
   * exactly the failure the move was meant to make impossible.
   */
  it('accounts for every signal as traded, filtered out, or crowded out', () => {
    expect(run.trades.length + run.filtered + run.skippedWhileOpen).toBe(run.signals);
    expect(run.skippedWhileOpen, 'the detector should never offer an overlapping signal').toBe(0);
    expect(run.trades.length).toBe(run.signals);
  });

  /**
   * The rules live INSIDE the detector, so changing one has to change how
   * many SIGNALS exist — not how many of a fixed set survive a filter. A
   * control that only filtered the output could never show what the looser
   * rule would have done, because the looser rule's signals were never
   * generated in the first place.
   *
   * The knob used here is the one real open question in the strategy: the
   * article attaches the Chikou check to the breakout and separately says the
   * four approaches work together, so whether it also gates the pullback is a
   * reading, not a given. Measuring it needs the detector re-run.
   */
  it('re-runs the detector when a rule changes, rather than filtering its output', () => {
    /**
     * The reward multiple is the clearest demonstration available, and it
     * only became so once one trade per pair was a rule. A nearer target
     * resolves trades sooner, which frees the pair sooner, which lets the
     * detector take far more of them — three times as many at 0.5:1 as at
     * 2:1, from the very same candles.
     *
     * No filter applied to a finished list can ADD a trade. So this number
     * going up is proof the detector ran again, which is the only way to
     * answer "what would this rule have done" honestly.
     */
    const near = backtest(candles, SYMBOL, '1H', { config: { ...ICHIMOKU, rewardMultiple: 0.5 } });
    const far = backtest(candles, SYMBOL, '1H', { config: { ...ICHIMOKU, rewardMultiple: 5 } });

    expect(near.signals).toBeGreaterThan(run.signals);
    expect(far.signals).toBeLessThan(run.signals);
    expect(near.filtered).toBe(0); // nothing filtered: the rule itself changed
    expect(near.trades.length).toBeGreaterThan(run.trades.length);

    // The live default is what the page reports.
    expect(run.signals).toBe(backtest(candles, SYMBOL, '1H', { config: ICHIMOKU }).signals);
  });

  it('handles a series too short to produce anything', () => {
    const short = backtest([bar(0, 1.1, 1.1, 1.1, 1.1)], SYMBOL, '1H');
    expect(short.trades).toEqual([]);
    expect(short.signals).toBe(0);
    expect(short.metrics.trades).toBe(0);
    expect(short.metrics.averagePips).toBeNull();
  });
});

describe('combine', () => {
  it('orders trades across pairs by when they closed', () => {
    const merged = combine([result(SYMBOL, 300, 200), result('GBP/USD', 100, -100)]);
    expect(merged.trades.map((t) => t.symbol)).toEqual(['GBP/USD', SYMBOL]);
    expect(merged.equity).toEqual([
      { time: 100, pips: -100 },
      { time: 300, pips: 100 },
    ]);
  });

  /**
   * Adding a JPY pip to a EUR/USD pip is adding unlike things. The merge is
   * still allowed — the page needs one curve — but it has to be FLAGGED, and
   * the flag belongs next to the trades rather than re-derived by each caller.
   */
  it('flags a selection that mixes JPY and non-JPY pips, and leaves a single-unit one unflagged', () => {
    expect(combine([result(SYMBOL, 100, 10), result('GBP/USD', 200, 10)]).mixesPipValues).toBe(false);
    expect(combine([result(SYMBOL, 100, 10), result('USD/JPY', 200, 10)]).mixesPipValues).toBe(true);
    expect(combine([result('USD/JPY', 100, 10), result('EUR/JPY', 200, 10)]).mixesPipValues).toBe(false);
    // Nothing to mix.
    expect(combine([]).mixesPipValues).toBe(false);
  });
});

/**
 * `accept` is a POST-HOC FILTER, and it did not used to be.
 *
 * It was built so a proposed entry rule could be measured through the same
 * walk-forward as the real one, and the subtlety it existed for was this:
 * rejecting a signal freed the position, so a later signal the unfiltered run
 * was too busy to take could now be traded. Filtering a finished trade list
 * cannot produce that.
 *
 * One trade per pair moved into the DETECTOR, and that reasoning went with
 * it. The detector decides occupancy while it walks the bars, so by the time
 * `accept` sees a signal the alternatives have already not been emitted.
 * Rejecting one now removes a row and nothing else.
 *
 * So: to ask "what would a different entry rule have done", use `config`,
 * which re-runs the detector — `accept` would silently answer a different and
 * much weaker question. What `accept` is still good for is subsetting a run
 * that has already happened ("only the longs", "only thick-cloud breaks"),
 * where removing rows is exactly what you mean.
 */
describe('accept — subsetting a finished run', () => {
  const all = backtest(candles, SYMBOL, '1H');

  it('runs the rule against every signal and keeps only what it allows', () => {
    const none = backtest(candles, SYMBOL, '1H', { accept: () => false });
    const every = backtest(candles, SYMBOL, '1H', { accept: () => true });

    expect(none.trades).toEqual([]);
    expect(none.filtered).toBe(all.signals);
    // Accepting everything must be identical to no filter at all.
    expect(every.trades.length).toBe(all.trades.length);
    expect(every.metrics.totalPips).toBeCloseTo(all.metrics.totalPips, 9);
  });

  it('is applied on top of the rule being measured, not instead of it', () => {
    const config = { ...ICHIMOKU, rewardMultiple: 0.5 };
    const both = backtest(candles, SYMBOL, '1H', { config, accept: () => true });
    const configOnly = backtest(candles, SYMBOL, '1H', { config });
    expect(both.trades.length).toBe(configOnly.trades.length);
    expect(configOnly.signals).toBeGreaterThan(all.signals);
  });

  /**
   * The property that replaces "it opens a trade the unfiltered run never
   * took", which was true of the old design and is false of this one.
   * Asserting it directly is what stops someone reaching for `accept` to
   * measure an entry rule and quietly getting a subset instead of a
   * counterfactual.
   */
  it('can only ever remove trades, never admit one', () => {
    const taken = new Set(all.trades.map((t) => t.id));
    const half = backtest(candles, SYMBOL, '1H', { accept: (s) => s.direction === 'LONG' });

    expect(half.trades.length).toBeGreaterThan(0);
    expect(half.trades.length).toBeLessThan(all.trades.length);
    for (const t of half.trades) {
      expect(taken.has(t.id), `${t.id} was never in the unfiltered run`).toBe(true);
      expect(t.direction).toBe('LONG');
    }
    // And every removed row is accounted for rather than dropped silently.
    expect(half.trades.length + half.filtered).toBe(half.signals);
  });

  /**
   * The same fact from the other side: rejecting the very trade that was
   * holding the pair does NOT let anything new through, because the detector
   * had already decided what to offer before `accept` was consulted.
   */
  it('rejecting a trade does not free the pair for another', () => {
    const first = all.trades[0]!;
    const without = backtest(candles, SYMBOL, '1H', { accept: (s) => s.id !== first.id });
    const taken = new Set(all.trades.map((t) => t.id));

    expect(without.trades.some((t) => t.id === first.id)).toBe(false);
    expect(without.trades.every((t) => taken.has(t.id))).toBe(true);
    expect(without.trades.length).toBe(all.trades.length - 1);
  });
});

describe('trading costs', () => {
  it('takes the cost straight off the pip result, both directions', () => {
    // 10-pip stop on EUR/USD, 20-pip target. A 1-pip spread costs one pip.
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.099, 1.102, 0.0001)).toBeCloseTo(19, 9);
    expect(pipsOf(SYMBOL, 'LONG', 1.1, 1.099, 1.099, 0.0001)).toBeCloseTo(-11, 9);
    // A short pays it the same way round.
    expect(pipsOf(SYMBOL, 'SHORT', 1.1, 1.101, 1.098, 0.0001)).toBeCloseTo(19, 9);
  });

  it('makes every trade worse, and never changes how many there are', () => {
    const free = backtest(candles, SYMBOL, '1H');
    const paid = backtest(candles, SYMBOL, '1H', { costPips: 1 });

    expect(paid.trades.length).toBe(free.trades.length);
    expect(paid.metrics.trades).toBe(free.metrics.trades);
    expect(paid.metrics.totalPips).toBeLessThan(free.metrics.totalPips);
  });
});

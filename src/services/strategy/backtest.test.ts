/**
 * The harness, not the strategy.
 *
 * Every test here is about a decision that changes the headline number: which
 * bar can close a trade, what happens when one bar covers both exits, whether
 * an unfinished trade is counted. Those are the ways a backtest lies.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../marketData/types';
import { backtestTouches, combine, equityCurve, measure, pipsOf, type BacktestTrade } from './backtest';
import { analyseEma50Touch } from './ema50Touch';
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

const trade = (over: Partial<BacktestTrade> = {}): BacktestTrade => ({
  id: 't',
  symbol: 'EUR/USD',
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
  ichimokuScore: 3,
  counterTrend: false,
  touchOutcome: 'bounce',
  ...over,
});

describe('pipsOf', () => {
  it('measures a win and a loss in pips, both directions', () => {
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.09, 1.12)).toBeCloseTo(200, 6);
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.09, 1.09)).toBeCloseTo(-100, 6);
    expect(pipsOf('EUR/USD', 'SHORT', 1.1, 1.11, 1.08)).toBeCloseTo(200, 6);
    expect(pipsOf('EUR/USD', 'SHORT', 1.1, 1.11, 1.11)).toBeCloseTo(-100, 6);
  });

  /**
   * The reason the symbol is a parameter at all. The same price move is a
   * different number of pips on a JPY pair, and getting this wrong would
   * inflate every JPY result by a hundred times.
   */
  it('uses the pair\'s own pip size, so a JPY pip is 0.01', () => {
    expect(pipsOf('USD/JPY', 'LONG', 150.0, 149.0, 152.0)).toBeCloseTo(200, 6);
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.0999, 1.1002)).toBeCloseTo(2, 6);
  });

  /** Cost is a price distance, so it must be charged before the pip division. */
  it('charges the cost in price units, not in pips', () => {
    // 1 pip of EUR/USD = 0.0001: a +200-pip win becomes +199.
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.09, 1.12, 0.0001)).toBeCloseTo(199, 6);
    // 1 pip of USD/JPY = 0.01, a hundred times the price distance.
    expect(pipsOf('USD/JPY', 'LONG', 150.0, 149.0, 152.0, 0.01)).toBeCloseTo(199, 6);
  });

  it('refuses a zero-risk trade rather than reporting a result for it', () => {
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.1, 1.2)).toBeNull();
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

/**
 * A series that pulls back to its own EMA and then resolves the way the test
 * needs. Built by hand so the exit bar is unambiguous.
 */
function seriesWithTouch(after: Candle[]): { candles: Candle[]; symbol: string } {
  const symbol = 'EUR/USD';
  const candles: Candle[] = [];
  let t = 1_700_000_000;
  // A long, gentle uptrend: enough bars for EMA50 + ATR14 to exist.
  let price = 1.1;
  for (let i = 0; i < 80; i++) {
    const open = price;
    price += 0.0004;
    candles.push(bar(t, open, price + 0.0002, open - 0.0002, price));
    t += 3600;
  }
  // A pullback that reaches back down into the EMA.
  for (let i = 0; i < 12; i++) {
    const open = price;
    price -= 0.0011;
    candles.push(bar(t, open, open + 0.0002, price - 0.0002, price));
    t += 3600;
  }
  for (const c of after) candles.push({ ...c, time: t, ...(t += 3600, {}) });
  return { candles, symbol };
}

describe('backtestTouches', () => {
  const symbol = 'EUR/USD';

  /**
   * The touch bar's range mostly happened BEFORE the touch — its extremes sit
   * where the move began. Letting it also close the trade books a target the
   * trade never had a chance to reach.
   */
  it('never closes a trade on the bar that opened it', () => {
    const { candles } = seriesWithTouch([]);
    const result = backtestTouches(candles, symbol, '1H');
    for (const t of result.trades) {
      if (t.exitTime !== null) expect(t.exitTime).toBeGreaterThan(t.entryTime);
      expect(t.barsHeld === 0 ? t.exit : 'ok').not.toBe('tp');
    }
  });

  it('takes the stop when one bar covers both the stop and the target', () => {
    const { candles } = seriesWithTouch([]);
    const base = backtestTouches(candles, symbol, '1H');
    const first = base.trades[0];
    expect(first, 'the fixture must produce a trade').toBeTruthy();

    // Replace everything after entry with one bar that engulfs both levels.
    const entryIndex = candles.findIndex((c) => c.time === first!.entryTime);
    const wide = candles.slice(0, entryIndex + 1);
    const lo = Math.min(first!.stop, first!.target) - 0.005;
    const hi = Math.max(first!.stop, first!.target) + 0.005;
    wide.push(bar(candles[entryIndex]!.time + 3600, first!.entry, hi, lo, first!.entry));

    const result = backtestTouches(wide, symbol, '1H');
    expect(result.trades[0]!.exit).toBe('sl');
    // Stopped out: the loss is exactly the stop distance it recorded.
    expect(result.trades[0]!.pips).toBeCloseTo(-result.trades[0]!.stopPips, 6);
  });

  it('holds at most one position at a time', () => {
    const { candles } = seriesWithTouch([]);
    const result = backtestTouches(candles, symbol, '1H');
    const sorted = [...result.trades].sort((a, b) => a.entryTime - b.entryTime);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      expect(prev.exitTime, 'a trade opened while another was still open').not.toBeNull();
      expect(sorted[i]!.entryTime).toBeGreaterThanOrEqual(prev.exitTime!);
    }
  });

  it('leaves an unfinished trade uncounted rather than guessing its result', () => {
    const { candles } = seriesWithTouch([]);
    const result = backtestTouches(candles, symbol, '1H');
    for (const t of result.trades) {
      if (t.exit === 'open') expect(t.pips).toBeNull();
    }
    expect(result.metrics.trades + result.metrics.stillOpen).toBe(result.trades.length);
  });

  it('uses the same levels the live trade-plan card shows', async () => {
    const { ticketLevels } = await import('./tradePlan');
    const { candles } = seriesWithTouch([]);
    const analysis = analyseEma50Touch(candles, symbol, '1H');
    const result = backtestTouches(candles, symbol, '1H');

    for (const t of result.trades) {
      const signal = analysis.signals.find((s) => s.id === t.id)!;
      const levels = ticketLevels(signal)!;
      expect({ entry: t.entry, stop: t.stop, target: t.target }).toEqual({
        entry: levels.entry,
        stop: levels.stop,
        target: levels.target,
      });
    }
  });

  it('skips the touches the filters exclude, and says how many', () => {
    const { candles } = seriesWithTouch([]);
    const all = backtestTouches(candles, symbol, '1H');
    const strict = backtestTouches(candles, symbol, '1H', { minIchimoku: 5 });

    expect(strict.touches).toBe(all.touches);
    expect(strict.filtered).toBeGreaterThanOrEqual(all.filtered);
    expect(strict.trades.length).toBeLessThanOrEqual(all.trades.length);
  });

  it('handles a series too short to produce anything', () => {
    const result = backtestTouches([bar(0, 1.1, 1.1, 1.1, 1.1)], symbol, '1H');
    expect(result.trades).toEqual([]);
    expect(result.metrics.trades).toBe(0);
    expect(result.metrics.averagePips).toBeNull();
  });
});

describe('combine', () => {
  it('orders trades across pairs by when they closed', () => {
    const mk = (symbol: string, exitTime: number, pips: number) => ({
      symbol,
      timeframe: '1H' as const,
      bars: 0,
      touches: 0,
      filtered: 0,
      noFill: 0,
      trades: [trade({ symbol, exitTime, pips })],
      metrics: measure([]),
      equity: [],
    });
    const merged = combine([mk('EUR/USD', 300, 200), mk('GBP/USD', 100, -100)]);
    expect(merged.trades.map((t) => t.symbol)).toEqual(['GBP/USD', 'EUR/USD']);
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
    const mk = (symbol: string, exitTime: number, pips: number) => ({
      symbol,
      timeframe: '1H' as const,
      bars: 0,
      touches: 0,
      filtered: 0,
      noFill: 0,
      trades: [trade({ symbol, exitTime, pips })],
      metrics: measure([]),
      equity: [],
    });

    expect(combine([mk('EUR/USD', 100, 10), mk('GBP/USD', 200, 10)]).mixesPipValues).toBe(false);
    expect(combine([mk('EUR/USD', 100, 10), mk('USD/JPY', 200, 10)]).mixesPipValues).toBe(true);
    expect(combine([mk('USD/JPY', 100, 10), mk('GBP/JPY', 200, 10)]).mixesPipValues).toBe(false);
    // Nothing to mix.
    expect(combine([]).mixesPipValues).toBe(false);
  });
});

/**
 * `accept` exists so a PROPOSED entry rule can be measured through the same
 * walk-forward as the real one. The subtlety it is there for: rejecting a
 * touch frees the position, so a later touch the unfiltered run never saw can
 * now be taken. Filtering a finished trade list cannot produce that, which is
 * why rule variants have to be tested here rather than afterwards.
 */
describe('accept — measuring a proposed rule', () => {
  it('runs the rule against every touch and keeps only what it allows', () => {
    const { candles, symbol } = seriesWithTouch([]);
    const all = backtestTouches(candles, symbol, '1H');
    const none = backtestTouches(candles, symbol, '1H', { accept: () => false });
    const every = backtestTouches(candles, symbol, '1H', { accept: () => true });

    expect(none.trades).toEqual([]);
    expect(none.filtered).toBe(all.touches);
    // Accepting everything must be identical to no filter at all.
    expect(every.trades.length).toBe(all.trades.length);
    expect(every.metrics.totalPips).toBeCloseTo(all.metrics.totalPips, 9);
  });

  it('is applied on top of the built-in filters, not instead of them', () => {
    const { candles, symbol } = seriesWithTouch([]);
    const both = backtestTouches(candles, symbol, '1H', {
      minIchimoku: 5,
      accept: () => true,
    });
    const ichiOnly = backtestTouches(candles, symbol, '1H', { minIchimoku: 5 });
    expect(both.trades.length).toBe(ichiOnly.trades.length);
  });

  /**
   * The behaviour that makes post-hoc filtering wrong: with one position at a
   * time, rejecting a touch lets a DIFFERENT touch trade that the unfiltered
   * run was too busy to take. Filtering a finished trade list can only ever
   * remove rows, so it cannot show this, and it would quietly measure the
   * wrong strategy.
   *
   * Needs REAL candles: the hand-built fixture above has too few touches for
   * any of them to be crowded out, so it cannot demonstrate this at all.
   * Over 5000 bars of EUR/USD the detector finds far more touches than the
   * one-position rule can trade, which is exactly the crowded case.
   */
  it('can open a trade the unfiltered run never took', () => {
    const candles = parseCsv(eurusd);
    const all = backtestTouches(candles, 'EUR/USD', '1H');
    expect(all.touches, 'the fixture must crowd out touches').toBeGreaterThan(all.trades.length * 2);
    const taken = new Set(all.trades.map((t) => t.id));

    // Trades that hold a touch inside their window — the ones whose removal
    // frees something. 123 of this fixture's 167 trades qualify.
    const index = new Map(candles.map((c, i) => [c.time, i]));
    const touches = analyseEma50Touch(candles, 'EUR/USD', '1H').signals;
    const blockers = all.trades.filter((t) => {
      if (t.exitTime === null) return false;
      const from = index.get(t.entryTime)!;
      const to = index.get(t.exitTime)!;
      return touches.some((sig) => {
        const i = index.get(sig.barTime)!;
        return i > from && i <= to;
      });
    });
    expect(blockers.length, 'the fixture must contain trades that block a touch').toBeGreaterThan(10);

    // Removing a blocker usually admits the touch it was sitting on — but not
    // always, because that touch may itself be a no-fill. The claim is that it
    // CAN happen, which post-hoc filtering could never show, so it is enough
    // that one of a handful does it. (Measured: 12 of the first 15.)
    const admitted = blockers.slice(0, 15).filter((b) => {
      const without = backtestTouches(candles, 'EUR/USD', '1H', { accept: (sig) => sig.id !== b.id });
      expect(without.trades.some((t) => t.id === b.id)).toBe(false);
      return without.trades.some((t) => !taken.has(t.id));
    });
    expect(admitted.length, 'freeing a position should admit touches the unfiltered run never took').toBeGreaterThan(5);
  });
});

describe('trading costs', () => {
  it('takes the cost straight off the pip result, both directions', () => {
    // 10-pip stop on EUR/USD, 20-pip target. A 1-pip spread costs one pip.
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.099, 1.102, 0.0001)).toBeCloseTo(19, 9);
    expect(pipsOf('EUR/USD', 'LONG', 1.1, 1.099, 1.099, 0.0001)).toBeCloseTo(-11, 9);
    // A short pays it the same way round.
    expect(pipsOf('EUR/USD', 'SHORT', 1.1, 1.101, 1.098, 0.0001)).toBeCloseTo(19, 9);
  });

  it('makes every trade worse, and never changes how many there are', () => {
    const { candles } = seriesWithTouch([]);
    const free = backtestTouches(candles, 'EUR/USD', '1H');
    const paid = backtestTouches(candles, 'EUR/USD', '1H', { costPips: 1 });

    expect(paid.trades.length).toBe(free.trades.length);
    expect(paid.metrics.trades).toBe(free.metrics.trades);
    expect(paid.metrics.totalPips).toBeLessThan(free.metrics.totalPips);
  });
});

describe('fills', () => {
  /**
   * The touch band is wider than the EMA line, so a bar can touch without
   * ever trading at the entry. Filling those anyway was worth +0.23R a trade
   * across 1105 trades — pure fiction. See backtest.ts, rule 1.
   */
  it('accounts for every touch as a trade, a no-fill or a filtered-out', () => {
    const { candles } = seriesWithTouch([]);
    const result = backtestTouches(candles, 'EUR/USD', '1H');
    // Nothing may vanish: a touch is taken, skipped by a filter, skipped for
    // want of a fill, or crowded out by a position already open.
    expect(result.trades.length + result.noFill + result.filtered).toBeLessThanOrEqual(result.touches);
    expect(result.touches).toBeGreaterThan(0);
  });

  it('never fills outside the entry bar, whichever way the touch came', () => {
    const { candles } = seriesWithTouch([]);
    const byTime = new Map(candles.map((c) => [c.time, c]));
    for (const t of backtestTouches(candles, 'EUR/USD', '1H').trades) {
      const bar = byTime.get(t.entryTime)!;
      expect(t.entry).toBeGreaterThanOrEqual(bar.low);
      expect(t.entry).toBeLessThanOrEqual(bar.high);
    }
  });
});

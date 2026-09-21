import { describe, expect, it } from 'vitest';
import type { Candle } from '../marketData/types';
import { resolveBar, rMultipleOf, runConfluenceBacktest } from './confluenceBacktest';

const PIP = 0.0001;

function toCandles(closes: readonly number[], wickPips = 6): Candle[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: i === 0 ? close : closes[i - 1]!,
    high: close + wickPips * PIP,
    low: close - wickPips * PIP,
    close,
    volume: null,
    complete: true,
  }));
}

const bar = (over: Partial<Candle> = {}): Candle => ({
  time: 1,
  open: 1.1,
  high: 1.1,
  low: 1.1,
  close: 1.1,
  volume: null,
  complete: true,
  ...over,
});

/**
 * A market with swings proportional to its ATR.
 *
 * The amplitude matters: a fixture with 300-pip swings against an 8-pip ATR
 * reads as OVEREXTENDED on two thirds of its bars, which tests the guard
 * rather than the strategy.
 *
 * `noise` adds a deterministic pseudo-random wobble. Without it the series is
 * a perfect sine, every pullback resolves the same way, and the backtest
 * reports a flawless win rate that says nothing about the strategy — only
 * that a noiseless trend is easy. The noisy variant is what proves the engine
 * records losses as readily as wins.
 */
const market = (n: number, driftPips: number, swingPips: number, period: number, noisePips = 0) => {
  // Deterministic LCG: the tests must not change answer between runs.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  return Array.from(
    { length: n },
    (_, i) => 1.05 + i * driftPips * PIP + Math.sin((i / period) * 2 * Math.PI) * swingPips * PIP + rand() * noisePips * PIP,
  );
};

describe('resolveBar', () => {
  const targets = [1.103, 1.105, 1.107];

  it('stops out a long when the LOW reaches the stop', () => {
    expect(resolveBar(bar({ low: 1.0979, high: 1.101 }), 'long', 1.098, targets, false)).toMatchObject({
      exit: 'sl',
      price: 1.098,
    });
  });

  it('stops out a short when the HIGH reaches the stop', () => {
    expect(resolveBar(bar({ high: 1.1021, low: 1.099 }), 'short', 1.102, [1.097, 1.095, 1.093], false)).toMatchObject({
      exit: 'sl',
    });
  });

  it('takes the stop when one bar covers both — the pessimistic reading', () => {
    // This bar's range reaches the stop AND TP3; OHLC cannot order them.
    const wide = bar({ low: 1.0979, high: 1.1071 });
    expect(resolveBar(wide, 'long', 1.098, targets, false).exit).toBe('sl');
  });

  it('reports breakeven at TP1 rather than exiting', () => {
    expect(resolveBar(bar({ high: 1.1031, low: 1.102 }), 'long', 1.098, targets, false)).toMatchObject({
      exit: null,
      breakeven: true,
    });
  });

  it('does not re-trigger breakeven once TP1 is already hit', () => {
    expect(resolveBar(bar({ high: 1.1031, low: 1.102 }), 'long', 1.1, targets, true).breakeven).toBe(false);
  });

  it('exits at the furthest target the bar reached', () => {
    expect(resolveBar(bar({ high: 1.1071, low: 1.104 }), 'long', 1.098, targets, true).exit).toBe('tp3');
    expect(resolveBar(bar({ high: 1.1051, low: 1.104 }), 'long', 1.098, targets, true).exit).toBe('tp2');
  });

  it('calls a stop after TP1 a breakeven, not a loss', () => {
    expect(resolveBar(bar({ low: 1.0999, high: 1.101 }), 'long', 1.1, targets, true).exit).toBe('be');
  });

  it('leaves the trade open when nothing is reached', () => {
    expect(resolveBar(bar({ high: 1.101, low: 1.0995 }), 'long', 1.098, targets, false)).toMatchObject({ exit: null, breakeven: false });
  });
});

describe('rMultipleOf', () => {
  it('measures a win in multiples of the risk', () => {
    expect(rMultipleOf('long', 1.1, 1.098, 1.105)).toBeCloseTo(2.5);
  });

  it('is symmetric for a short', () => {
    expect(rMultipleOf('short', 1.1, 1.102, 1.095)).toBeCloseTo(2.5);
  });

  it('gives exactly -1 at the stop', () => {
    expect(rMultipleOf('long', 1.1, 1.098, 1.098)).toBeCloseTo(-1);
  });

  it('refuses to divide by zero risk', () => {
    expect(rMultipleOf('long', 1.1, 1.1, 1.2)).toBeNull();
  });
});

describe('runConfluenceBacktest — guards', () => {
  it('refuses a series too short to warm the indicators up', () => {
    const result = runConfluenceBacktest(toCandles(market(50, 1, 20, 14)), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(result.trades).toHaveLength(0);
    expect(result.note).toMatch(/at least/);
  });

  it('takes no trade on a dead flat market', () => {
    const flat = toCandles(Array.from({ length: 400 }, () => 1.1));
    const result = runConfluenceBacktest(flat, { symbol: 'EUR/USD', timeframe: '1H' });
    expect(result.trades).toHaveLength(0);
    expect(result.barsAnalysed).toBeGreaterThan(0);
  });

  it('says why it produced nothing rather than looking broken', () => {
    const flat = toCandles(Array.from({ length: 400 }, () => 1.1));
    expect(runConfluenceBacktest(flat, { symbol: 'EUR/USD', timeframe: '1H' }).note).toMatch(/selective/);
  });
});

describe('runConfluenceBacktest — on a realistic market', () => {
  const candles = toCandles(market(900, 0.6, 20, 90));
  const result = runConfluenceBacktest(candles, { symbol: 'EUR/USD', timeframe: '1H' });

  it('produces trades', () => {
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.barsAnalysed).toBeGreaterThan(500);
  });

  it('holds one position at a time', () => {
    const sorted = [...result.trades].sort((a, b) => a.entryIndex - b.entryIndex);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const closedAt = previous.entryIndex + previous.barsHeld;
      expect(sorted[i]!.entryIndex).toBeGreaterThanOrEqual(closedAt);
    }
  });

  it('gives every closed trade a stop, targets and an R', () => {
    for (const t of result.trades) {
      expect(t.entry).not.toBe(t.initialStop);
      expect(t.targets.length).toBeGreaterThan(0);
      expect(t.stopPips).toBeGreaterThan(0);
      if (t.exit !== 'open') expect(t.rMultiple).not.toBeNull();
    }
  });

  it('never exits on the entry bar', () => {
    for (const t of result.trades) {
      if (t.exit !== 'open') expect(t.barsHeld).toBeGreaterThanOrEqual(1);
    }
  });

  it('places long stops below entry and short stops above', () => {
    for (const t of result.trades) {
      if (t.direction === 'long') expect(t.initialStop).toBeLessThan(t.entry);
      else expect(t.initialStop).toBeGreaterThan(t.entry);
    }
  });

  it('scores a stop-out at exactly -1R', () => {
    for (const t of result.trades) {
      if (t.exit === 'sl') expect(t.rMultiple).toBeCloseTo(-1, 6);
    }
  });

  it('scores a breakeven exit at exactly 0R', () => {
    for (const t of result.trades) {
      if (t.exit === 'be') expect(t.rMultiple).toBe(0);
    }
  });

  it('leaves an unresolved trade unscored rather than guessing', () => {
    for (const t of result.trades) {
      if (t.exit === 'open') expect(t.rMultiple).toBeNull();
    }
  });

  it('builds a report whose overall totals match the trades', () => {
    const closed = result.trades.filter((t) => t.rMultiple !== null);
    const total = closed.reduce((sum, t) => sum + t.rMultiple!, 0);
    expect(result.report.overall.closed).toBe(closed.length);
    expect(result.report.overall.totalR).toBeCloseTo(total, 6);
  });

  it('breaks the results down by regime and by signal strength', () => {
    expect(result.report.byRegimeFamily.length).toBeGreaterThan(0);
    expect(result.report.bySignalStrength.length).toBeGreaterThan(0);
    for (const g of result.report.byMarketCondition) {
      expect(g.key).toMatch(/^[A-Z_]+$/);
    }
  });

  it('records why each trade was taken', () => {
    expect(result.trades.every((t) => t.reasons.length > 0)).toBe(true);
  });
});

describe('runConfluenceBacktest — causality', () => {
  it('cannot see past the bar it is analysing', () => {
    const candles = toCandles(market(700, 0.6, 20, 90));
    const full = runConfluenceBacktest(candles, { symbol: 'EUR/USD', timeframe: '1H' });

    // Truncating the data must not change trades that opened before the cut:
    // if it did, the engine was reading bars it should not have seen.
    const cut = 500;
    const truncated = runConfluenceBacktest(candles.slice(0, cut), { symbol: 'EUR/USD', timeframe: '1H' });

    const earlyFull = full.trades.filter((t) => t.entryIndex < cut - 300).map((t) => `${t.entryIndex}|${t.direction}|${t.entry.toFixed(6)}`);
    const earlyCut = truncated.trades.filter((t) => t.entryIndex < cut - 300).map((t) => `${t.entryIndex}|${t.direction}|${t.entry.toFixed(6)}`);

    expect(earlyCut).toEqual(earlyFull);
  });

  it('respects a from/to window', () => {
    const candles = toCandles(market(900, 0.6, 20, 90));
    const from = candles[500]!.time;
    const windowed = runConfluenceBacktest(candles, { symbol: 'EUR/USD', timeframe: '1H', from });
    for (const t of windowed.trades) expect(t.entryTime).toBeGreaterThanOrEqual(from);
  });

  it('abandons a trade that never resolves rather than holding it for ever', () => {
    const candles = toCandles(market(900, 0.6, 20, 90));
    const result = runConfluenceBacktest(candles, { symbol: 'EUR/USD', timeframe: '1H', maxBarsHeld: 5 });
    for (const t of result.trades) expect(t.barsHeld).toBeLessThanOrEqual(5);
  });
});

describe('runConfluenceBacktest — a noisy market', () => {
  // The clean sine above wins every trade, which tells you the fixture is easy
  // rather than the strategy good. Noise is what makes the result mean
  // anything: a backtest engine that cannot book a loss is worthless.
  // 60 pips of noise against a 20-pip swing: a trend you would struggle to
  // trade. Milder noise leaves the sine intact enough that every trade still
  // reaches TP2, which proves nothing about the exit path.
  const noisy = toCandles(market(1200, 0.6, 20, 90, 60));
  const result = runConfluenceBacktest(noisy, { symbol: 'EUR/USD', timeframe: '1H' });

  it('still finds setups once the trend is not perfectly clean', () => {
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it('records losing trades, not only winners', () => {
    const closed = result.trades.filter((t) => t.rMultiple !== null);
    expect(closed.length).toBeGreaterThan(0);
    // An engine that cannot book a loss would report a flawless record on any
    // fixture, which is the failure mode this test exists to rule out.
    expect(result.trades.some((t) => t.exit === 'sl' || t.exit === 'be')).toBe(true);
    expect(result.report.overall.totalR).toBeLessThan(result.report.overall.closed * 2.5);
  });

  it('degrades on noise rather than reporting the same result regardless', () => {
    const clean = runConfluenceBacktest(toCandles(market(1200, 0.6, 20, 90, 0)), { symbol: 'EUR/USD', timeframe: '1H' });
    // The clean sine is a perfect trend; if the noisy market scored as well,
    // the backtest would not be measuring anything about the market at all.
    expect(result.report.overall.averageR!).toBeLessThan(clean.report.overall.averageR!);
  });

  it('keeps every R within the bounds the ticket allows', () => {
    for (const t of result.trades) {
      if (t.rMultiple === null) continue;
      // Worst case is the stop (-1R), best is TP3.
      expect(t.rMultiple).toBeGreaterThanOrEqual(-1.000001);
      expect(t.rMultiple).toBeLessThanOrEqual(4);
    }
  });
});

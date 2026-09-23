/**
 * The backtest harness, tested independently of any strategy.
 *
 * Its job is exit resolution and bookkeeping, and every mistake it can make
 * flatters the result: counting the entry bar as an exit bar, resolving a
 * stop-and-target bar as the target, or measuring R against a stop that was
 * moved to breakeven. A number that is wrong in that direction is worse than
 * no number, because it is the one someone risks money on.
 */
import { describe, expect, it } from 'vitest';
import { rMultipleOf, resolveBar, runBacktest } from './backtest';
import { MIN_BARS } from './analyse';
import type { Candle } from '../marketData/types';

const bar = (over: Partial<Candle> = {}): Candle => ({
  time: 1_700_000_000,
  open: 1.1,
  high: 1.105,
  low: 1.095,
  close: 1.1,
  volume: 0,
  complete: true,
  ...over,
});

describe('resolveBar — two outcomes and nothing else', () => {
  it('takes the stop when one bar covers both the stop and the target', () => {
    // OHLC cannot order the two. Reading it as the target invents a win.
    const b = bar({ low: 1.09, high: 1.12 });
    expect(resolveBar(b, 'long', 1.095, 1.11).exit).toBe('sl');
  });

  it('applies the same rule to a short', () => {
    const b = bar({ low: 1.08, high: 1.115 });
    expect(resolveBar(b, 'short', 1.11, 1.09).exit).toBe('sl');
  });

  it('reports the target when only the target was reached', () => {
    const b = bar({ high: 1.12, low: 1.099 });
    expect(resolveBar(b, 'long', 1.09, 1.11).exit).toBe('tp');
  });

  it('reports the target for a short reaching down to it', () => {
    const b = bar({ high: 1.101, low: 1.085 });
    expect(resolveBar(b, 'short', 1.11, 1.09).exit).toBe('tp');
  });

  it('leaves a quiet bar open', () => {
    expect(resolveBar(bar(), 'long', 1.05, 1.2).exit).toBeNull();
  });

  it('has no breakeven outcome at all', () => {
    // The ladder's first rung banked nothing and only pulled the stop to
    // entry, which turned the commonest winner into a 0R scratch while every
    // loser still paid −1R. Measured on a random walk that lost 0.14R a trade.
    // There is deliberately no third outcome now.
    const outcomes = new Set<string>();
    for (const [low, high] of [[1.09, 1.12], [1.099, 1.12], [1.0999, 1.1001]] as const) {
      const r = resolveBar(bar({ low, high }), 'long', 1.095, 1.11);
      if (r.exit) outcomes.add(r.exit);
    }
    expect(outcomes.has('sl')).toBe(true);
    expect(outcomes.has('tp')).toBe(true);
    expect([...outcomes].every((o) => o === 'sl' || o === 'tp')).toBe(true);
  });
});

describe('rMultipleOf', () => {
  it('measures a win as a multiple of the risk taken', () => {
    expect(rMultipleOf('long', 1.1, 1.09, 1.12)).toBeCloseTo(2);
  });

  it('measures a short the same way, with the sign the trader experienced', () => {
    expect(rMultipleOf('short', 1.1, 1.11, 1.08)).toBeCloseTo(2);
  });

  it('is negative for a loss', () => {
    expect(rMultipleOf('long', 1.1, 1.09, 1.09)).toBeCloseTo(-1);
  });

  it('refuses to divide by zero risk rather than returning Infinity', () => {
    // This is what a breakeven stop looks like if the ORIGINAL stop was lost.
    // Returning null forces the caller to notice; Infinity would quietly
    // poison every aggregate downstream.
    expect(rMultipleOf('long', 1.1, 1.1, 1.12)).toBeNull();
  });
});

describe('runBacktest guards', () => {
  const series = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => bar({ time: 1_700_000_000 + i * 3600 }));

  it('refuses a series too short to analyse, and says how short', () => {
    const out = runBacktest(series(10), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(out.trades).toEqual([]);
    expect(out.note).toMatch(/Needs at least/);
  });

  it('runs clean over a featureless series and produces nothing', () => {
    // Flat bars give no setup. The harness must still complete, report the
    // bars it looked at, and say plainly that nothing confirmed — rather than
    // erroring or implying a fault.
    const out = runBacktest(series(MIN_BARS + 50), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(out.trades).toEqual([]);
    expect(out.barsAnalysed).toBeGreaterThan(0);
    expect(out.note).toBe('No setup confirmed over this range.');
    expect(out.report.overall.closed).toBe(0);
  });

  it('reports an empty report rather than null statistics', () => {
    const out = runBacktest(series(MIN_BARS + 50), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(out.report.overall.winRatePct).toBeNull();
    expect(out.report.overall.totalR).toBe(0);
  });
});

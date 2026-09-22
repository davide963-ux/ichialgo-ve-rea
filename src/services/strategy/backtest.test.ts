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

describe('resolveBar — same-bar ambiguity resolves against the trade', () => {
  it('takes the stop when one bar covers both the stop and a target', () => {
    // OHLC cannot order the two. Reading it as the target invents a win.
    const b = bar({ low: 1.09, high: 1.12 });
    expect(resolveBar(b, 'long', 1.095, [1.11], false).exit).toBe('sl');
  });

  it('applies the same rule to a short', () => {
    const b = bar({ low: 1.08, high: 1.115 });
    expect(resolveBar(b, 'short', 1.11, [1.09], false).exit).toBe('sl');
  });

  it('reports a stop hit after breakeven as be, not sl', () => {
    const b = bar({ low: 1.09 });
    expect(resolveBar(b, 'long', 1.095, [1.11], true).exit).toBe('be');
  });
});

describe('resolveBar — targets', () => {
  it('reports the furthest target a bar reached, not the nearest', () => {
    const b = bar({ high: 1.2, low: 1.099 });
    expect(resolveBar(b, 'long', 1.09, [1.11, 1.13, 1.15], false).exit).toBe('tp3');
  });

  it('treats the first target as a breakeven move rather than an exit', () => {
    const b = bar({ high: 1.115, low: 1.099 });
    const out = resolveBar(b, 'long', 1.09, [1.11, 1.13, 1.15], false);
    expect(out.exit).toBeNull();
    expect(out.breakeven).toBe(true);
  });

  it('leaves a quiet bar open', () => {
    const out = resolveBar(bar(), 'long', 1.05, [1.2], false);
    expect(out.exit).toBeNull();
    expect(out.breakeven).toBe(false);
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

describe('runBacktest with no strategy installed', () => {
  const series = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => bar({ time: 1_700_000_000 + i * 3600 }));

  it('refuses a series too short to analyse, and says how short', () => {
    const out = runBacktest(series(10), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(out.trades).toEqual([]);
    expect(out.note).toMatch(/Needs at least/);
  });

  it('runs clean over a long series and produces nothing', () => {
    // The stub strategy never signals. The harness must still complete,
    // report the bars it looked at, and say plainly that nothing confirmed —
    // rather than erroring or implying a fault.
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

/**
 * The seam's contract.
 *
 * These are the promises everything downstream relies on, and they must hold
 * for whatever strategy is installed here. When the real rules arrive, this
 * file should keep passing unchanged — if it does not, something outside
 * `analyse()` is about to break.
 */
import { describe, expect, it } from 'vitest';
import { analyse, hasEnoughBars, MIN_BARS } from './analyse';
import { directionOf, isActionable } from './contract';
import type { Candle } from '../marketData/types';

const series = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: 1.1,
    high: 1.105,
    low: 1.095,
    close: 1.1 + i * 0.0001,
    volume: 0,
    complete: true,
  }));

describe('analyse always returns a well-formed answer', () => {
  it('returns an analysis for an empty series rather than throwing', () => {
    // The scanner runs unattended. A throw here is an error in a log nobody
    // reads; a refusal carrying a reason shows up in the dry-run output.
    const a = analyse([], { symbol: 'EUR/USD', timeframe: '1H' });
    expect(a.signal).toBe('NO_TRADE');
    expect(a.symbol).toBe('EUR/USD');
  });

  it('echoes the symbol and timeframe it was asked about', () => {
    const a = analyse(series(260), { symbol: 'GBP/JPY', timeframe: '4H' });
    expect(a.symbol).toBe('GBP/JPY');
    expect(a.timeframe).toBe('4H');
  });

  it('reports the bar it analysed, not the newest one, when given an index', () => {
    // The backtest relies on this to replay history without lookahead.
    const candles = series(320);
    const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: 250 });
    expect(a.barTime).toBe(candles[250]!.time);
    expect(a.price).toBe(candles[250]!.close);
  });

  it('defaults to the final bar', () => {
    const candles = series(260);
    expect(analyse(candles, { symbol: 'EUR/USD', timeframe: '1H' }).barTime).toBe(candles[259]!.time);
  });

  it('carries the forming-bar flag through untouched', () => {
    const a = analyse(series(260), { symbol: 'EUR/USD', timeframe: '1H', lastBarClosed: false });
    expect(a.barClosed).toBe(false);
  });
});

describe('the engine answers rather than refusing', () => {
  it('returns a real verdict on a flat series instead of an error', () => {
    // Dead-flat data is a legitimate market state, not a fault. The engine
    // must grade it (low), not throw or refuse.
    const a = analyse(series(260), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(a.signal).not.toBe('NO_TRADE');
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(100);
  });

  it('refuses only when there genuinely is not enough history', () => {
    const a = analyse(series(50), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(a.signal).toBe('NO_TRADE');
    expect(a.marketCondition).toBe('INSUFFICIENT_DATA');
    expect(a.warnings[0]).toMatch(/Needs \d+ bars/);
  });

  it('never emits an actionable signal without a complete ticket', () => {
    // A tradeable tier with no entry, stop or target would be recorded as a
    // trade with nothing to execute or measure.
    const a = analyse(series(260), { symbol: 'EUR/USD', timeframe: '1H' });
    if (isActionable(a.signal)) {
      expect(a.risk.entry).not.toBeNull();
      expect(a.risk.stop).not.toBeNull();
      expect(a.risk.target).not.toBeNull();
    }
  });

  it('records the full structured read for later audit', () => {
    const d = analyse(series(260), { symbol: 'EUR/USD', timeframe: '1H' }).detail;
    expect(d).toHaveProperty('structure');
    expect(d).toHaveProperty('levels');
    expect(d).toHaveProperty('ema50');
    expect(d).toHaveProperty('ichimoku');
    expect(d).toHaveProperty('scores');
    expect(d).toHaveProperty('scoreBreakdown');
  });
});

describe('contract helpers', () => {
  it('reads the side off a signal, ignoring its grade', () => {
    expect(directionOf('STRONG_LONG')).toBe('long');
    expect(directionOf('WATCH_SHORT')).toBe('short');
    expect(directionOf('NEUTRAL')).toBe('none');
    expect(directionOf('NO_TRADE')).toBe('none');
  });

  it('counts only order-worthy signals as actionable', () => {
    expect(isActionable('LONG')).toBe(true);
    expect(isActionable('STRONG_SHORT')).toBe(true);
    // A WATCH is a real setup that has not met its entry condition. Treating
    // it as actionable is how a terminal becomes noise.
    expect(isActionable('WATCH_LONG')).toBe(false);
    expect(isActionable('NEUTRAL')).toBe(false);
  });
});

describe('hasEnoughBars', () => {
  it('is false below the declared minimum and true at it', () => {
    expect(hasEnoughBars(series(MIN_BARS - 1))).toBe(false);
    expect(hasEnoughBars(series(MIN_BARS))).toBe(true);
  });
});

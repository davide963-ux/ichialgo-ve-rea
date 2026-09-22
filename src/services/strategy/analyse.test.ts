/**
 * The seam's contract.
 *
 * These are the promises everything downstream relies on, and they must hold
 * for whatever strategy is installed here. When the real rules arrive, this
 * file should keep passing unchanged — if it does not, something outside
 * `analyse()` is about to break.
 */
import { describe, expect, it } from 'vitest';
import { analyse, hasEnoughBars, MIN_BARS, NO_STRATEGY_REASON } from './analyse';
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
    const a = analyse(series(200), { symbol: 'GBP/JPY', timeframe: '4H' });
    expect(a.symbol).toBe('GBP/JPY');
    expect(a.timeframe).toBe('4H');
  });

  it('reports the bar it analysed, not the newest one, when given an index', () => {
    // The backtest relies on this to replay history without lookahead.
    const candles = series(200);
    const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: 50 });
    expect(a.barTime).toBe(candles[50]!.time);
    expect(a.price).toBe(candles[50]!.close);
  });

  it('defaults to the final bar', () => {
    const candles = series(200);
    expect(analyse(candles, { symbol: 'EUR/USD', timeframe: '1H' }).barTime).toBe(candles[199]!.time);
  });

  it('carries the forming-bar flag through untouched', () => {
    const a = analyse(series(200), { symbol: 'EUR/USD', timeframe: '1H', lastBarClosed: false });
    expect(a.barClosed).toBe(false);
  });
});

describe('with no strategy installed', () => {
  it('refuses every pair, and says why in a warning the UI can render', () => {
    const a = analyse(series(200), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(a.signal).toBe('NO_TRADE');
    expect(a.direction).toBe('none');
    expect(a.confidence).toBe(0);
    expect(a.warnings).toContain(NO_STRATEGY_REASON);
  });

  it('proposes no trade ticket at all', () => {
    // A signal with a direction but no levels would be recorded as a trade
    // with nothing to execute or measure.
    const { risk } = analyse(series(200), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(risk.entry).toBeNull();
    expect(risk.stop).toBeNull();
    expect(risk.targets).toEqual([]);
  });

  it('is never actionable', () => {
    expect(isActionable(analyse(series(200), { symbol: 'EUR/USD', timeframe: '1H' }).signal)).toBe(false);
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

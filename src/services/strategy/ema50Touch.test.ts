import { describe, expect, it } from 'vitest';
import { EMA50_TOUCH } from '../../config/strategy';
import { emaOfCloses } from '../../lib/indicators';
import type { Candle } from '../marketData';
import { analyseEma50Touch, biasFor, checkLiveTouch, touchTimeMs, trendFromSlope } from './ema50Touch';
import type { WatchLevel } from './types';

const SYMBOL = 'EUR/USD';
const PIP = 0.0001;

/** Candles from a close path; each bar's wick extends `wickPips` either way. */
function candles(closes: number[], wickPips = 2, complete = true): Candle[] {
  const w = wickPips * PIP;
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 900,
    open: i === 0 ? close : closes[i - 1]!,
    high: Math.max(close, i === 0 ? close : closes[i - 1]!) + w,
    low: Math.min(close, i === 0 ? close : closes[i - 1]!) - w,
    close,
    volume: null,
    complete: complete || i < closes.length - 1,
  }));
}

/** A bar with an explicit range, appended after `prev`. */
function bar(prev: Candle, { low, high, close }: { low: number; high: number; close: number }): Candle {
  return { time: prev.time + 900, open: prev.close, high, low, close, volume: null, complete: true };
}

/** 80 bars climbing 2 pips a bar — price stays well above a lagging EMA50. */
const uptrend = (bars = 80, step = 2 * PIP) => Array.from({ length: bars }, (_, i) => 1.1 + i * step);

describe('analyseEma50Touch', () => {
  it('reports not-enough-bars below the warm-up window', () => {
    const a = analyseEma50Touch(candles(uptrend(40)), SYMBOL, '15M');
    expect(a.reason).toBe('not-enough-bars');
    expect(a.signals).toEqual([]);
    expect(a.level).toBeNull();
  });

  it('finds no touch while price runs away from the EMA', () => {
    const a = analyseEma50Touch(candles(uptrend()), SYMBOL, '15M');
    expect(a.reason).toBe('ok');
    expect(a.signals).toEqual([]);
    expect(a.level?.side).toBe('above');
    expect(a.level?.armed).toBe(true);
  });

  it('signals once when a pullback reaches the EMA from above', () => {
    const closes = uptrend();
    const emaNow = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    closes.push(emaNow); // one bar drops onto the line
    const a = analyseEma50Touch(candles(closes), SYMBOL, '15M');

    expect(a.signals).toHaveLength(1);
    const s = a.signals[0]!;
    expect(s.approach).toBe('above');
    expect(s.trend).toBe('up');
    expect(s.bias).toBe('long'); // pullback into a rising EMA
    expect(s.counterTrend).toBe(false);
    expect(s.distancePips).toBeLessThan(s.tolerancePips + 0.01);
    expect(s.id).toBe(`ema50-touch|EUR/USD|15M|${a.signals[0]!.barTime}`);
  });

  it('signals once — not once per bar — while price rides the EMA', () => {
    const closes = uptrend();
    const emaNow = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    for (let i = 0; i < 6; i++) closes.push(emaNow + i * 0.2 * PIP); // sits on the line
    const a = analyseEma50Touch(candles(closes), SYMBOL, '15M');

    expect(a.signals).toHaveLength(1);
    expect(a.level?.armed).toBe(false); // still disarmed: price never left
  });

  it('re-arms after price leaves the zone and signals the next approach', () => {
    const closes = uptrend();
    let emaNow = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    closes.push(emaNow); // touch #1
    for (let i = 1; i <= 12; i++) closes.push(emaNow + i * 4 * PIP); // walk away → re-arm
    emaNow = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    closes.push(emaNow); // touch #2

    const a = analyseEma50Touch(candles(closes), SYMBOL, '15M');
    expect(a.signals).toHaveLength(2);
    expect(a.signals[0]!.barTime).toBeLessThan(a.signals[1]!.barTime);
  });

  it('classifies a rejection as bounce and a break as cross', () => {
    const base = candles(uptrend());
    const prev = base.at(-1)!;
    const ema = emaOfCloses(base, EMA50_TOUCH.period).at(-1)!;

    // Wick tags the EMA, close back above it → the EMA held.
    const held = analyseEma50Touch(
      [...base, bar(prev, { low: ema - PIP, high: prev.close, close: ema + 12 * PIP })],
      SYMBOL,
      '15M',
    );
    expect(held.signals.at(-1)?.outcome).toBe('bounce');

    // Same contact, but the bar closes through the line → the EMA broke.
    const broke = analyseEma50Touch(
      [...base, bar(prev, { low: ema - 15 * PIP, high: prev.close, close: ema - 12 * PIP })],
      SYMBOL,
      '15M',
    );
    expect(broke.signals.at(-1)?.outcome).toBe('cross');
  });

  it('marks a touch on the still-forming bar as pending', () => {
    const closes = uptrend();
    const ema = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    closes.push(ema);
    const bars = candles(closes);
    bars[bars.length - 1]!.complete = false;

    expect(analyseEma50Touch(bars, SYMBOL, '15M').signals.at(-1)?.outcome).toBe('pending');
  });

  it('reads a rally into a falling EMA as a short', () => {
    const downtrend = Array.from({ length: 80 }, (_, i) => 1.3 - i * 2 * PIP);
    const ema = emaOfCloses(candles(downtrend), EMA50_TOUCH.period).at(-1)!;
    const a = analyseEma50Touch(candles([...downtrend, ema]), SYMBOL, '15M');

    const s = a.signals.at(-1)!;
    expect(s.approach).toBe('below');
    expect(s.trend).toBe('down');
    expect(s.bias).toBe('short');
  });

  it('widens the tolerance with volatility', () => {
    const closes = uptrend();
    const ema = emaOfCloses(candles(closes), EMA50_TOUCH.period).at(-1)!;
    const calm = analyseEma50Touch(candles([...closes, ema], 2), SYMBOL, '15M').signals.at(-1)!;
    const wild = analyseEma50Touch(candles([...closes, ema], 40), SYMBOL, '15M').signals.at(-1)!;
    expect(wild.tolerancePips).toBeGreaterThan(calm.tolerancePips);
  });

  it('never returns an EMA value where the series is undefined', () => {
    const a = analyseEma50Touch(candles(uptrend()), SYMBOL, '15M');
    expect(a.ema.slice(0, EMA50_TOUCH.period - 1).every((v) => v === null)).toBe(true);
    expect(a.ema[EMA50_TOUCH.period - 1]).not.toBeNull();
  });
});

describe('trendFromSlope / biasFor', () => {
  it('needs a real slope to call a trend', () => {
    expect(trendFromSlope(0.05, 0.15)).toBe('flat');
    expect(trendFromSlope(0.5, 0.15)).toBe('up');
    expect(trendFromSlope(-0.5, 0.15)).toBe('down');
    expect(trendFromSlope(null, 0.15)).toBe('flat');
  });

  it('flags a touch that fights the trend', () => {
    expect(biasFor('above', 'up')).toEqual({ bias: 'long', counterTrend: false });
    expect(biasFor('below', 'down')).toEqual({ bias: 'short', counterTrend: false });
    expect(biasFor('below', 'up')).toEqual({ bias: 'neutral', counterTrend: true });
    expect(biasFor('above', 'flat')).toEqual({ bias: 'neutral', counterTrend: false });
  });
});

describe('checkLiveTouch', () => {
  const level = (over: Partial<WatchLevel> = {}): WatchLevel => ({
    symbol: SYMBOL,
    timeframe: '15M',
    ema: 1.1,
    tolerance: 2 * PIP,
    tolerancePips: 2,
    atr: 8 * PIP,
    trend: 'up',
    side: 'above',
    armed: true,
    barTime: 1_700_000_000,
    ichimoku: null,
    updatedAt: 0,
    ...over,
  });

  it('fires the moment a quote reaches the band', () => {
    const { signal, level: next } = checkLiveTouch(level(), 1.1001, 1_000);
    expect(signal?.source).toBe('live');
    expect(signal?.outcome).toBe('pending');
    expect(signal?.approach).toBe('above');
    expect(signal?.bias).toBe('long');
    expect(next.armed).toBe(false); // disarmed straight away
  });

  it('does not fire again while price stays in the band', () => {
    const first = checkLiveTouch(level(), 1.1001, 1_000);
    const second = checkLiveTouch(first.level, 1.09995, 2_000);
    expect(second.signal).toBeNull();
  });

  it('re-arms once price leaves the band far enough', () => {
    const touched = checkLiveTouch(level(), 1.1, 1_000).level;
    expect(touched.armed).toBe(false);
    const away = checkLiveTouch(touched, 1.1 + 4 * PIP, 2_000).level;
    expect(away.armed).toBe(true);
    expect(away.side).toBe('above');
    expect(checkLiveTouch(away, 1.1, 3_000).signal).not.toBeNull();
  });

  it('stays silent for a quote nowhere near the level', () => {
    const { signal, level: next } = checkLiveTouch(level(), 1.2, 1_000);
    expect(signal).toBeNull();
    expect(next.side).toBe('above');
  });

  it('reports no direction when the last scan left price inside the band', () => {
    const { signal } = checkLiveTouch(level({ side: 'inside' }), 1.1, 1_000);
    expect(signal?.bias).toBe('neutral');
  });
});

describe('touchTimeMs', () => {
  it('dates a closed bar by the bar, not by when the scan ran', () => {
    expect(touchTimeMs({ source: 'candle', barTime: 1_700_000_000, detectedAt: 9_999 })).toBe(1_700_000_000_000);
  });

  it('dates a live touch by the tick that made it', () => {
    expect(touchTimeMs({ source: 'live', barTime: 1_700_000_000, detectedAt: 9_999 })).toBe(9_999);
  });
});

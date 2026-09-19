import { describe, expect, it } from 'vitest';
import { ICHIMOKU_CONFLUENCE } from '../../config/strategy';
import { ichimoku } from '../../lib/indicators';
import type { Candle } from '../marketData';
import { ICHIMOKU_CHECKS, explainContext, ichimokuContextAt } from './ichimokuContext';

const SYMBOL = 'EUR/USD';
const PIP = 0.0001;

/** Candles from a close path, with a fixed wick either side. */
function candles(closes: number[], wickPips = 3): Candle[] {
  const w = wickPips * PIP;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      time: 1_700_000_000 + i * 1800,
      open,
      high: Math.max(open, close) + w,
      low: Math.min(open, close) - w,
      close,
      volume: null,
      complete: true,
    };
  });
}

const upPath = (n = 150, step = 2 * PIP) => Array.from({ length: n }, (_, i) => 1.1 + i * step);
const downPath = (n = 150, step = 2 * PIP) => Array.from({ length: n }, (_, i) => 1.4 - i * step);

const contextFor = (closes: number[], approach: 'above' | 'below', emaOffsetPips = 0) => {
  const bars = candles(closes);
  const series = ichimoku(bars);
  const i = bars.length - 1;
  const ema = bars[i]!.close + emaOffsetPips * PIP;
  return { ctx: ichimokuContextAt(series, bars, i, SYMBOL, approach, ema), series, bars, i };
};

describe('ichimokuContextAt', () => {
  it('scores a textbook long: above a bullish cloud, Tenkan up, Chikou free', () => {
    const { ctx } = contextFor(upPath(), 'above');
    expect(ctx).not.toBeNull();
    expect(ctx!.kumo).toBe('above');
    expect(ctx!.cloudBullish).toBe(true);
    expect(ctx!.tenkanAboveKijun).toBe(true);
    expect(ctx!.chikouFree).toBe(true);
    expect(ctx!.score).toBeGreaterThanOrEqual(ICHIMOKU_CONFLUENCE.agreeThreshold);
    expect(ctx!.agrees).toBe(true);
  });

  it('scores a textbook short on the mirrored path', () => {
    const { ctx } = contextFor(downPath(), 'below');
    expect(ctx!.kumo).toBe('below');
    expect(ctx!.cloudBullish).toBe(false);
    expect(ctx!.tenkanAboveKijun).toBe(false);
    expect(ctx!.chikouFree).toBe(true); // "free" is read in the trade's direction
    expect(ctx!.agrees).toBe(true);
  });

  it('reads the SAME bar as disagreement when the touch points the other way', () => {
    const up = candles(upPath());
    const series = ichimoku(up);
    const i = up.length - 1;
    const long = ichimokuContextAt(series, up, i, SYMBOL, 'above', up[i]!.close)!;
    const short = ichimokuContextAt(series, up, i, SYMBOL, 'below', up[i]!.close)!;

    expect(long.agrees).toBe(true);
    expect(short.agrees).toBe(false); // shorting into a bullish Ichimoku
    expect(short.kumo).toBe('above'); // the facts are identical…
    expect(short.score).toBeLessThan(long.score); // …only the reading differs
  });

  it('flags the EMA50 and Kijun marking the same level', () => {
    const bars = candles(upPath());
    const series = ichimoku(bars);
    const i = bars.length - 1;
    const kijun = series.kijun[i]!;

    const onKijun = ichimokuContextAt(series, bars, i, SYMBOL, 'above', kijun + 2 * PIP)!;
    expect(onKijun.kijunDistancePips).toBeCloseTo(2, 6);
    expect(onKijun.kijunConfluence).toBe(true);

    const farFromKijun = ichimokuContextAt(series, bars, i, SYMBOL, 'above', kijun + 40 * PIP)!;
    expect(farFromKijun.kijunConfluence).toBe(false);
    expect(farFromKijun.score).toBe(onKijun.score - 1);
  });

  it('reports the cloud thickness in pips', () => {
    const { ctx } = contextFor(upPath(), 'above');
    expect(ctx!.cloudPips).toBeGreaterThan(0);
  });

  it('returns null before the cloud exists (needs 52 + 26 bars)', () => {
    const bars = candles(upPath(60));
    const series = ichimoku(bars);
    expect(ichimokuContextAt(series, bars, bars.length - 1, SYMBOL, 'above', 1.2)).toBeNull();
  });

  it('never scores above the number of checks', () => {
    const { ctx } = contextFor(upPath(), 'above');
    expect(ctx!.score).toBeLessThanOrEqual(ICHIMOKU_CHECKS);
  });

  it('handles a JPY pair on its own pip scale', () => {
    const jpy = Array.from({ length: 150 }, (_, i) => 150 + i * 0.02);
    const bars = jpy.map((close, i) => {
      const open = i === 0 ? close : jpy[i - 1]!;
      return { time: i * 1800, open, high: Math.max(open, close) + 0.03, low: Math.min(open, close) - 0.03, close, volume: null, complete: true };
    });
    const series = ichimoku(bars);
    const i = bars.length - 1;
    const ctx = ichimokuContextAt(series, bars, i, 'USD/JPY', 'above', series.kijun[i]! + 0.02)!;
    expect(ctx.kijunDistancePips).toBeCloseTo(2, 6); // 0.02 / 0.01, not / 0.0001
  });
});

describe('explainContext', () => {
  it('ticks the checks that support the direction', () => {
    const { ctx } = contextFor(upPath(), 'above');
    const lines = explainContext(ctx!, 'LONG');
    expect(lines).toHaveLength(ICHIMOKU_CHECKS);
    expect(lines[0]).toMatch(/above the Kumo ✓/);
    expect(lines.filter((l) => l.includes('✓')).length).toBe(ctx!.score);
  });

  it('leaves them unticked when read against the direction', () => {
    const { ctx } = contextFor(upPath(), 'below');
    expect(explainContext(ctx!, 'SHORT').filter((l) => l.includes('✓')).length).toBe(ctx!.score);
  });
});

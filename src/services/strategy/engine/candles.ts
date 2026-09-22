/**
 * Candlestick patterns.
 *
 * WHY EVERY PATTERN CARRIES A BASE WEIGHT
 * ───────────────────────────────────────
 * These are not equal. A three-white-soldiers sequence is three bars of
 * sustained buying; a doji is one bar of indecision that resolves either way
 * about half the time. Scoring them identically — which is what a flat "a
 * pattern was found" boolean does — lets the weakest signal in the set carry
 * as much weight as the strongest.
 *
 * LOCATION IS THE MULTIPLIER, NOT THE PATTERN
 * ───────────────────────────────────────────
 * A bullish engulfing in the middle of a range is noise. The same candle at
 * support, on the EMA50, or at a broken level being retested is a rejection by
 * someone with size. This module reports WHAT it found and how strong the
 * pattern is in isolation; the scorer applies the location multiplier, because
 * only the scorer knows where the levels are.
 *
 * SIZE FILTER
 * ───────────
 * A pattern formed by three doji-sized bars in dead volume is arithmetically a
 * morning star and practically nothing. Patterns must involve a bar of at
 * least `minRangeRatio` of the recent average range to be reported at all.
 */
import type { Candle } from '../../marketData/types';
import type { EngineConfig } from './config';

export type CandleBias = 'bullish' | 'bearish' | 'neutral';

export interface CandlePattern {
  name: string;
  bias: CandleBias;
  /** Bar the pattern completed on. */
  index: number;
  barsAgo: number;
  /** 0–1 strength in isolation, before any location bonus. */
  weight: number;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const isUp = (c: Candle) => c.close > c.open;
const isDown = (c: Candle) => c.close < c.open;
const mid = (c: Candle) => (c.open + c.close) / 2;

/** Average range over the preceding bars, for the size filter. */
function averageRange(candles: readonly Candle[], end: number, lookback = 20): number {
  const from = Math.max(0, end - lookback);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= end; i++) {
    sum += range(candles[i]!);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Detect every pattern completing on bar `i`.
 *
 * Returns all matches rather than the "best" one: a hammer that is also a pin
 * bar at a tweezer bottom is three independent readings of the same bar, and
 * the scorer caps the family so they cannot stack without limit.
 */
function patternsAt(candles: readonly Candle[], i: number, config: EngineConfig, avgRange: number): CandlePattern[] {
  const c = candles[i];
  if (!c) return [];
  const p1 = candles[i - 1];
  const p2 = candles[i - 2];

  const out: CandlePattern[] = [];
  const add = (name: string, bias: CandleBias, weight: number) => out.push({ name, bias, index: i, barsAgo: 0, weight });

  const r = range(c);
  if (r <= 0) return out;

  const b = body(c);
  const bodyRatio = b / r;
  const up = upperWick(c);
  const low = lowerWick(c);

  // Size filter: only applied to single-bar patterns, since multi-bar patterns
  // carry their own significance through the sequence.
  const bigEnough = r >= avgRange * config.candles.minRangeRatio;

  // ── Doji family ────────────────────────────────────────────────────────
  if (bodyRatio <= config.candles.dojiBodyRatio) {
    if (low >= r * 0.6 && up <= r * 0.1) add('Dragonfly Doji', 'bullish', 0.55);
    else if (up >= r * 0.6 && low <= r * 0.1) add('Gravestone Doji', 'bearish', 0.55);
    else add('Doji', 'neutral', 0.25);
  }

  // ── Single-bar rejection ───────────────────────────────────────────────
  if (bigEnough && b > 0) {
    const longLower = low >= b * config.candles.pinWickRatio && up <= r * config.candles.pinOppositeMax;
    const longUpper = up >= b * config.candles.pinWickRatio && low <= r * config.candles.pinOppositeMax;

    if (longLower) {
      add('Pin Bar', 'bullish', 0.6);
      // Hammer and hanging man are the same shape; the trend decides which,
      // and the scorer knows the trend. Both are reported so neither is lost.
      add('Hammer', 'bullish', 0.6);
      add('Hanging Man', 'bearish', 0.35);
    }
    if (longUpper) {
      add('Pin Bar', 'bearish', 0.6);
      add('Shooting Star', 'bearish', 0.6);
      add('Inverted Hammer', 'bullish', 0.35);
    }
  }

  if (!p1) return out;

  // ── Two-bar patterns ───────────────────────────────────────────────────
  const b1 = body(p1);

  if (isUp(c) && isDown(p1) && c.close >= p1.open && c.open <= p1.close && b > b1) {
    add('Bullish Engulfing', 'bullish', 0.8);
  }
  if (isDown(c) && isUp(p1) && c.close <= p1.open && c.open >= p1.close && b > b1) {
    add('Bearish Engulfing', 'bearish', 0.8);
  }

  // Harami: the reverse containment — a small bar inside the previous body.
  if (b < b1 * 0.6) {
    const inside = Math.max(c.open, c.close) <= Math.max(p1.open, p1.close) && Math.min(c.open, c.close) >= Math.min(p1.open, p1.close);
    if (inside && isDown(p1)) add('Harami', 'bullish', 0.45);
    if (inside && isUp(p1)) add('Harami', 'bearish', 0.45);
  }

  if (c.high <= p1.high && c.low >= p1.low) add('Inside Bar', 'neutral', 0.3);
  if (c.high > p1.high && c.low < p1.low) add('Outside Bar', isUp(c) ? 'bullish' : 'bearish', 0.45);

  // Piercing / dark cloud: a close back through the midpoint of the previous
  // body — a genuine reversal of the prior session, not just a gap.
  if (isUp(c) && isDown(p1) && c.open < p1.low && c.close > mid(p1) && c.close < p1.open) {
    add('Piercing Pattern', 'bullish', 0.65);
  }
  if (isDown(c) && isUp(p1) && c.open > p1.high && c.close < mid(p1) && c.close > p1.open) {
    add('Dark Cloud Cover', 'bearish', 0.65);
  }

  const tolerance = avgRange * 0.12;
  if (Math.abs(c.low - p1.low) <= tolerance && isUp(c) && isDown(p1)) add('Tweezer Bottom', 'bullish', 0.5);
  if (Math.abs(c.high - p1.high) <= tolerance && isDown(c) && isUp(p1)) add('Tweezer Top', 'bearish', 0.5);

  if (!p2) return out;

  // ── Three-bar patterns ─────────────────────────────────────────────────
  const b2 = body(p2);

  // Morning / evening star: decisive bar, small indecisive bar, decisive
  // reversal closing well into the first body.
  if (isDown(p2) && body(p1) < b2 * 0.5 && isUp(c) && c.close > mid(p2)) {
    add('Morning Star', 'bullish', 0.85);
  }
  if (isUp(p2) && body(p1) < b2 * 0.5 && isDown(c) && c.close < mid(p2)) {
    add('Evening Star', 'bearish', 0.85);
  }

  const solid = (x: Candle) => body(x) >= range(x) * 0.6;
  if (isUp(c) && isUp(p1) && isUp(p2) && c.close > p1.close && p1.close > p2.close && solid(c) && solid(p1) && solid(p2)) {
    add('Three White Soldiers', 'bullish', 0.9);
  }
  if (isDown(c) && isDown(p1) && isDown(p2) && c.close < p1.close && p1.close < p2.close && solid(c) && solid(p1) && solid(p2)) {
    add('Three Black Crows', 'bearish', 0.9);
  }

  return out;
}

/**
 * Patterns completing within the freshness window, newest first.
 *
 * A bullish engulfing eleven bars ago has already been acted on or ignored by
 * the market. Only recent ones describe the situation now.
 */
export function readCandles(candles: readonly Candle[], end: number, config: EngineConfig): CandlePattern[] {
  const avgRange = averageRange(candles, end);
  if (avgRange <= 0) return [];

  const found: CandlePattern[] = [];
  for (let i = Math.max(2, end - config.candles.freshnessBars + 1); i <= end; i++) {
    for (const p of patternsAt(candles, i, config, avgRange)) {
      found.push({ ...p, barsAgo: end - i });
    }
  }

  return found.sort((a, b) => a.barsAgo - b.barsAgo || b.weight - a.weight);
}

/** The strongest pattern agreeing with a side, if any. */
export function strongestFor(patterns: readonly CandlePattern[], bias: 'bullish' | 'bearish'): CandlePattern | null {
  const matching = patterns.filter((p) => p.bias === bias);
  if (matching.length === 0) return null;
  // Decay by age: a fresh 0.6 beats a three-bar-old 0.8.
  const scored = matching.map((p) => ({ p, v: p.weight * (1 - p.barsAgo * 0.15) }));
  scored.sort((a, b) => b.v - a.v);
  return scored[0]!.p;
}

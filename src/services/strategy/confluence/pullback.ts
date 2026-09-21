/**
 * Pullback detection and entry confirmation.
 *
 * These two exist because of the single biggest flaw in the old detector:
 * it treated "price touched the EMA50" as an event worth trading. It is not.
 * A touch during a collapse and a touch during a healthy retracement look
 * identical to a distance check and are opposite trades.
 *
 * WHAT MAKES A PULLBACK
 * ─────────────────────
 * A pullback is only meaningful RELATIVE TO AN IMPULSE. So we first find the
 * impulse leg (the move from the last opposing swing to the extreme), then
 * measure how much of it price has given back:
 *
 *      impulse high ●
 *                 ╱ │╲
 *                ╱  │ ╲___  ← 38% retrace: healthy
 *               ╱   │     ╲
 *              ╱    │      ╲___  ← 70%: deep, still valid
 *   impulse   ●     │
 *   low             │          ╲  ← beyond 100%: not a pullback, a reversal
 *
 *   retracement = (extreme − price) / (extreme − origin)      [for a long]
 *
 * Under `shallowPct` price has not really pulled back yet — that is trend
 * continuation, and chasing it is how you buy the top of a leg.
 *
 * WHY CONFIRMATION IS SEPARATE
 * ────────────────────────────
 * Reaching the zone is necessary, never sufficient. Price falls through
 * support constantly. Confirmation asks price to prove it: a bar that pushed
 * into the zone and closed back out of it, with the rejection on the right
 * side. Only CLOSED bars can confirm — a forming candle's close is just the
 * current price and will move.
 */
import type { ConfirmationConfig, PullbackConfig } from '../../../config/confluence';
import type { OHLC } from '../../../lib/indicators/atr';
import { microStructure, type MarketStructure } from '../../../lib/indicators/marketStructure';
import type { PullbackState } from './types';

/** Wick maths needs the open, which the bare OHLC alias omits. */
export interface Bar extends OHLC {
  open: number;
}

export interface ImpulseLeg {
  originIndex: number;
  originPrice: number;
  extremeIndex: number;
  extremePrice: number;
  direction: 'up' | 'down';
}

/**
 * The most recent impulse leg in `direction`.
 *
 * For a long: from the last swing low up to the highest high after it. The
 * extreme is taken from the candles rather than only from confirmed swings,
 * because the top of the leg is often the most recent bars — which cannot be
 * confirmed pivots yet, but are certainly where the move ran out.
 */
export function findImpulse(
  candles: readonly OHLC[],
  end: number,
  structure: MarketStructure,
  direction: 'up' | 'down',
  config: PullbackConfig,
): ImpulseLeg | null {
  const origin = direction === 'up' ? structure.lastSwingLow : structure.lastSwingHigh;
  if (!origin) return null;
  if (end - origin.index > config.maxImpulseBars) return null;
  if (origin.index >= end) return null;

  let extremeIndex = origin.index;
  let extremePrice = origin.price;
  for (let i = origin.index + 1; i <= end; i++) {
    const c = candles[i];
    if (!c) continue;
    if (direction === 'up' && c.high > extremePrice) {
      extremePrice = c.high;
      extremeIndex = i;
    } else if (direction === 'down' && c.low < extremePrice) {
      extremePrice = c.low;
      extremeIndex = i;
    }
  }

  if (extremeIndex === origin.index) return null;
  if (direction === 'up' && extremePrice <= origin.price) return null;
  if (direction === 'down' && extremePrice >= origin.price) return null;

  return {
    originIndex: origin.index,
    originPrice: origin.price,
    extremeIndex,
    extremePrice,
    direction,
  };
}

export interface PullbackRead {
  state: PullbackState;
  /** 0–1+; 1.0 means the whole impulse has been given back. */
  retracementPct: number | null;
  /** 0–1 composite of depth, zone proximity and remaining structure. */
  quality: number;
  impulse: ImpulseLeg | null;
  /** True when price is currently inside the confluence zone. */
  inZone: boolean;
}

/**
 * Read the retracement at bar `end`.
 *
 * `quality` peaks for a retracement in the classic 38–62% band that also
 * reaches the confluence zone, and decays away from it. A pullback that never
 * reached the zone is not a setup for THIS strategy however pretty it looks.
 */
export function analysePullback(
  candles: readonly OHLC[],
  end: number,
  structure: MarketStructure,
  direction: 'up' | 'down',
  zoneLevel: number | null,
  atrValue: number,
  config: PullbackConfig,
): PullbackRead {
  const impulse = findImpulse(candles, end, structure, direction, config);
  const bar = candles[end];

  if (!impulse || !bar || !(atrValue > 0)) {
    return { state: 'none', retracementPct: null, quality: 0, impulse: null, inZone: false };
  }

  const span = Math.abs(impulse.extremePrice - impulse.originPrice);
  if (span <= 0) {
    return { state: 'none', retracementPct: null, quality: 0, impulse, inZone: false };
  }

  // Measure the retracement from the deepest point reached since the extreme,
  // not from the current close: a wick into the zone that closed back out is
  // exactly the setup, and measuring the close alone would miss it.
  let deepest = direction === 'up' ? bar.low : bar.high;
  for (let i = impulse.extremeIndex + 1; i <= end; i++) {
    const c = candles[i];
    if (!c) continue;
    if (direction === 'up' && c.low < deepest) deepest = c.low;
    if (direction === 'down' && c.high > deepest) deepest = c.high;
  }

  const retracementPct = Math.abs(impulse.extremePrice - deepest) / span;

  const inZone =
    zoneLevel !== null &&
    Math.min(Math.abs(deepest - zoneLevel), Math.abs(bar.close - zoneLevel)) / atrValue <= config.zoneTouchAtr;

  let state: PullbackState;
  if (retracementPct >= config.invalidationPct) state = 'invalidated';
  else if (retracementPct >= config.deepPct) state = 'deep';
  else if (retracementPct >= config.shallowPct) state = 'healthy';
  else state = 'continuation';

  let quality = 0;
  if (state === 'healthy' || state === 'deep') {
    // Triangular preference around the 38.2–61.8% band: full marks in the
    // middle, tapering to zero at "no pullback" and at "fully retraced".
    const ideal = 0.5;
    const spread = 0.5;
    quality = Math.max(0, 1 - Math.abs(retracementPct - ideal) / spread);
    if (inZone) quality = Math.min(1, quality + 0.25);
    // Structure must still support the original direction. A "pullback" in a
    // structure that has already turned is the first leg of the new trend.
    if (structure.direction !== direction) quality *= 0.5;
    quality *= 0.5 + 0.5 * structure.strength;
  }

  return { state, retracementPct, quality: Math.max(0, Math.min(1, quality)), impulse, inZone };
}

export interface ConfirmationRead {
  confirmed: boolean;
  reason: string | null;
  /** Index of the bar that confirmed, when one did. */
  barIndex: number | null;
}

/**
 * Look for a closed bar that rejected the zone in the trade's direction.
 *
 * Three things must hold together, and each rules out a common false positive:
 *   1. the bar reached the zone           — otherwise it is unrelated
 *   2. it closed back out of it, recovering `minCloseRecovery` of its range
 *                                         — rules out closing through support
 *   3. the rejection wick is real         — rules out a nothing bar that
 *                                           happened to close green
 * Plus short-term structure must agree, so a single green bar inside a
 * continuing slide does not qualify.
 */
export function findConfirmation(
  candles: readonly Bar[],
  end: number,
  direction: 'up' | 'down',
  zoneLevel: number | null,
  atrValue: number,
  zoneTouchAtr: number,
  config: ConfirmationConfig,
  lastBarClosed: boolean,
): ConfirmationRead {
  if (zoneLevel === null || !(atrValue > 0)) return { confirmed: false, reason: null, barIndex: null };

  // A forming bar's close is just "the price right now" and will move before
  // the bar ends. Confirming on it is the single easiest way to produce a
  // signal that evaporates.
  const lastUsable = lastBarClosed ? end : end - 1;
  const first = Math.max(0, lastUsable - config.window + 1);

  for (let i = lastUsable; i >= first; i--) {
    const bar = candles[i];
    if (!bar) continue;

    const range = bar.high - bar.low;
    if (range <= 0) continue;

    const reachedZone =
      (direction === 'up' && bar.low - zoneLevel <= zoneTouchAtr * atrValue && bar.low <= zoneLevel + zoneTouchAtr * atrValue) ||
      (direction === 'down' && zoneLevel - bar.high <= zoneTouchAtr * atrValue && bar.high >= zoneLevel - zoneTouchAtr * atrValue);
    if (!reachedZone) continue;

    const recovery = direction === 'up' ? (bar.close - bar.low) / range : (bar.high - bar.close) / range;
    if (recovery < config.minCloseRecovery) continue;

    const wick = direction === 'up' ? (Math.min(bar.open, bar.close) - bar.low) / range : (bar.high - Math.max(bar.open, bar.close)) / range;
    if (wick < config.minWickRatio) continue;

    const micro = microStructure(candles, i, Math.max(2, config.window));
    if (micro !== null && micro !== direction) continue;

    return {
      confirmed: true,
      reason: `Bar rejected the zone: close recovered ${(recovery * 100).toFixed(0)}% of range with a ${(wick * 100).toFixed(0)}% ${direction === 'up' ? 'lower' : 'upper'} wick`,
      barIndex: i,
    };
  }

  return { confirmed: false, reason: null, barIndex: null };
}

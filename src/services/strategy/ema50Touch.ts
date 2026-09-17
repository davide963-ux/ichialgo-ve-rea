/**
 * EMA-50 touch detector — pure functions over candles, no I/O, no state.
 *
 * WHAT COUNTS AS A TOUCH
 * ──────────────────────
 * Price almost never prints the EMA to the last decimal, so a touch is
 * "the bar's range entered a band around the EMA":
 *
 *        high ─┐
 *              │      ema + tol  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
 *              ├─ bar            ━━━━━ EMA50 ━━━━━   ← band = max(ATR×k, minPips)
 *              │      ema − tol  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
 *         low ─┘
 *        touch ⇔ low ≤ ema+tol AND high ≥ ema−tol
 *
 * The band scales with ATR, so the same signal means the same thing in a
 * quiet session and a volatile one.
 *
 * WHY THE ARM/RE-ARM STATE
 * ────────────────────────
 * A market that rides the EMA would otherwise fire on every bar. After a
 * touch the pair is disarmed and only re-arms once a bar CLOSES more than
 * `rearmBands × tolerance` away from the EMA:
 *
 *   armed ──touch──▶ disarmed ──close leaves the zone──▶ armed ──touch──▶ …
 *     │                                                              │
 *     └────────────── one signal per approach, not per bar ──────────┘
 *
 * OUTCOME of the touch bar (what happened after contact):
 *   bounce — closed back on the side it came from (the EMA held)
 *   cross  — closed through (the EMA broke)
 *   inside — closed inside the band (undecided)
 *   pending— the bar is still forming
 */
import type { Timeframe } from '../../config/timeframes';
import type { Ema50TouchConfig } from '../../config/strategy';
import { EMA50_TOUCH } from '../../config/strategy';
import { atr, emaOfCloses, slopePerBar } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import type { Approach, Bias, TouchOutcome, TouchSignal, Trend, WatchLevel } from './types';

export interface TouchAnalysis {
  /** EMA series, index-aligned with `candles` (null before it is defined). */
  ema: (number | null)[];
  /** Touches found in this window, oldest first. */
  signals: TouchSignal[];
  /** Level for the live watcher, from the most recent bar. */
  level: WatchLevel | null;
  /** Why nothing was produced, when that is the case. */
  reason: 'ok' | 'not-enough-bars';
}

export const signalId = (symbol: string, timeframe: Timeframe, barTime: number) =>
  `ema50-touch|${symbol}|${timeframe}|${barTime}`;

/**
 * When the touch happened in MARKET time, in ms.
 *
 * `detectedAt` is when this app noticed, which for the touches found in the
 * initial 300-bar scan is simply "now" — using it would date every historical
 * touch to the moment the page loaded, and count them all as today's.
 * A closed bar is dated by its own bar time; a live tick is dated by the tick.
 */
export const touchTimeMs = (signal: Pick<TouchSignal, 'source' | 'barTime' | 'detectedAt'>): number =>
  signal.source === 'live' ? signal.detectedAt : signal.barTime * 1000;

/** Trend from the EMA's own slope, measured in pips per bar. */
export function trendFromSlope(slopePips: number | null, threshold: number): Trend {
  if (slopePips === null) return 'flat';
  if (slopePips > threshold) return 'up';
  if (slopePips < -threshold) return 'down';
  return 'flat';
}

/**
 * Directional read of a touch.
 *   pullback into a RISING ema (price came from above) → long
 *   rally into a FALLING ema (price came from below)   → short
 * Anything else is neutral, and a touch that fights the EMA's trend is
 * flagged so the UI can grey it out.
 */
export function biasFor(approach: Approach, trend: Trend): { bias: Bias; counterTrend: boolean } {
  if (approach === 'above' && trend === 'up') return { bias: 'long', counterTrend: false };
  if (approach === 'below' && trend === 'down') return { bias: 'short', counterTrend: false };
  const counterTrend = (approach === 'above' && trend === 'down') || (approach === 'below' && trend === 'up');
  return { bias: 'neutral', counterTrend };
}

function outcomeOf(candle: Candle, ema: number, tolerance: number, approach: Approach): TouchOutcome {
  if (!candle.complete) return 'pending';
  if (candle.close > ema + tolerance) return approach === 'above' ? 'bounce' : 'cross';
  if (candle.close < ema - tolerance) return approach === 'below' ? 'bounce' : 'cross';
  return 'inside';
}

/**
 * Run the detector over a candle window.
 *
 * @param candles oldest-first, as the providers return them.
 */
export function analyseEma50Touch(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: Ema50TouchConfig = EMA50_TOUCH,
  detectedAt = Date.now(),
): TouchAnalysis {
  const emaSeries = emaOfCloses(candles, config.period);
  if (candles.length < config.minBars) {
    return { ema: emaSeries, signals: [], level: null, reason: 'not-enough-bars' };
  }

  const pip = pipSize(symbol);
  const atrSeries = atr(candles, config.atrPeriod);
  const minTolerance = config.minTolerancePips * pip;
  const signals: TouchSignal[] = [];

  let armed = true;
  let level: WatchLevel | null = null;

  for (let i = 1; i < candles.length; i++) {
    const e = emaSeries[i];
    const prevE = emaSeries[i - 1];
    const bar = candles[i]!;
    const prev = candles[i - 1]!;
    if (e === null || e === undefined || prevE === null || prevE === undefined) continue;

    const tolerance = Math.max((atrSeries[i] ?? 0) * config.atrMultiple, minTolerance);
    const approach: Approach = prev.close >= prevE ? 'above' : 'below';
    const touched = bar.low <= e + tolerance && bar.high >= e - tolerance;

    if (touched && armed) {
      // The extreme that actually reached the band is the contact price.
      const price = approach === 'above' ? Math.max(bar.low, Math.min(bar.close, e)) : Math.min(bar.high, Math.max(bar.close, e));
      const slopePips = (() => {
        const s = slopePerBar(emaSeries, i, config.slopeLookback);
        return s === null ? null : s / pip;
      })();
      const trend = trendFromSlope(slopePips, config.trendSlopePips);
      const { bias, counterTrend } = biasFor(approach, trend);

      signals.push({
        id: signalId(symbol, timeframe, bar.time),
        strategy: 'ema50-touch',
        symbol,
        timeframe,
        barTime: bar.time,
        detectedAt,
        source: 'candle',
        price,
        ema: e,
        tolerancePips: tolerance / pip,
        distancePips: Math.abs(price - e) / pip,
        approach,
        outcome: outcomeOf(bar, e, tolerance, approach),
        trend,
        bias,
        counterTrend,
      });
      armed = false;
    }

    // Re-arm once a close leaves the zone entirely.
    if (!armed && Math.abs(bar.close - e) > tolerance * config.rearmBands) armed = true;

    if (i === candles.length - 1) {
      const slope = slopePerBar(emaSeries, i, config.slopeLookback);
      const side: WatchLevel['side'] =
        bar.close > e + tolerance ? 'above' : bar.close < e - tolerance ? 'below' : 'inside';
      level = {
        symbol,
        timeframe,
        ema: e,
        tolerance,
        tolerancePips: tolerance / pip,
        trend: trendFromSlope(slope === null ? null : slope / pip, config.trendSlopePips),
        side,
        armed,
        barTime: bar.time,
        updatedAt: detectedAt,
      };
    }
  }

  return { ema: emaSeries, signals, level, reason: 'ok' };
}

/**
 * Live (between-scan) touch check: does this quote reach the watched band?
 * The 50-period EMA barely moves inside one bar, so the level from the last
 * scan is a good approximation until the next candle refresh — and this
 * costs zero provider credits, because the quote stream is already running.
 */
export function checkLiveTouch(
  level: WatchLevel,
  price: number,
  now = Date.now(),
): { signal: TouchSignal | null; level: WatchLevel } {
  const pip = pipSize(level.symbol);
  const distance = price - level.ema;
  const inside = Math.abs(distance) <= level.tolerance;

  // Price left the zone → re-arm, and remember which side it is on now.
  if (!inside) {
    const side: Approach = distance > 0 ? 'above' : 'below';
    const armed = level.armed || Math.abs(distance) > level.tolerance * EMA50_TOUCH.rearmBands;
    return { signal: null, level: { ...level, side, armed, updatedAt: now } };
  }

  if (!level.armed) return { signal: null, level: { ...level, side: 'inside', updatedAt: now } };

  // `side` is where price was before it entered the band; 'inside' at the last
  // scan means we cannot tell, so the touch is reported without a direction.
  const approach: Approach | null = level.side === 'inside' ? null : level.side;
  const { bias, counterTrend } = approach
    ? biasFor(approach, level.trend)
    : { bias: 'neutral' as Bias, counterTrend: false };

  return {
    signal: {
      id: signalId(level.symbol, level.timeframe, level.barTime),
      strategy: 'ema50-touch',
      symbol: level.symbol,
      timeframe: level.timeframe,
      barTime: level.barTime,
      detectedAt: now,
      source: 'live',
      price,
      ema: level.ema,
      tolerancePips: level.tolerancePips,
      distancePips: Math.abs(distance) / pip,
      approach: approach ?? 'above',
      outcome: 'pending',
      trend: level.trend,
      bias,
      counterTrend,
    },
    level: { ...level, side: 'inside', armed: false, updatedAt: now },
  };
}

/**
 * Ichimoku confluence for an EMA50 touch.
 *
 * The touch tells you WHERE price is. Ichimoku tells you whether the rest of
 * the picture agrees with taking it. Five independent checks, each read
 * relative to the DIRECTION the touch implies (long for a pullback from
 * above, short for a rally from below):
 *
 *   1. Kumo side      price above the cloud for a long, below it for a short
 *   2. Cloud colour   Senkou A above B (bullish) for a long, below for a short
 *   3. Tenkan/Kijun   conversion line on the trade's side of the base line
 *   4. Chikou free    the lagging line is clear of the candles 26 bars back
 *   5. Kijun overlap  the EMA50 and Kijun-sen are within a few pips — two
 *                     independent methods pointing at the same level, which
 *                     is the case worth waiting for
 *
 *                  ╱▔▔▔╲          price above a rising bullish cloud,
 *          ────────       ╲___     EMA50 and Kijun on top of each other
 *      ━━━━━ EMA50 ≈ Kijun ━━━━━   → a long touch with 5/5 agreement
 *      ░░░░░░░ Kumo ░░░░░░░░░░░░
 *
 * Nothing here filters: a 0/5 touch is still reported, flagged, and left to
 * the trader. `agrees` is just "score ≥ threshold".
 */
import { ICHIMOKU_CONFLUENCE, type IchimokuConfluenceConfig } from '../../config/strategy';
import { cloudIsBullish, kumoSide, kumoThickness, type IchimokuSeries, type KumoSide } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import type { Approach } from './types';

export interface IchimokuContext {
  /** Where the touch price sits relative to the cloud in effect. */
  kumo: KumoSide;
  /** Senkou A above Senkou B — the cloud drawn green by convention. */
  cloudBullish: boolean;
  tenkanAboveKijun: boolean;
  /** Lagging line clear of the candles it is drawn over; null near the edge. */
  chikouFree: boolean | null;
  kijun: number | null;
  /** |EMA50 − Kijun| in pips. Small means both methods mark the same level. */
  kijunDistancePips: number | null;
  /** True when that distance is inside the configured window. */
  kijunConfluence: boolean;
  /** Cloud thickness in pips — a thin cloud is weak support/resistance. */
  cloudPips: number | null;
  /** Checks agreeing with the touch direction, 0–5. */
  score: number;
  agrees: boolean;
}

export const ICHIMOKU_CHECKS = 5;

/**
 * Build the context for a touch at bar `i`.
 * Returns null when Ichimoku has not warmed up (needs senkouB + displacement
 * bars before a cloud is in effect at all).
 */
export function ichimokuContextAt(
  series: IchimokuSeries,
  candles: readonly Candle[],
  i: number,
  symbol: string,
  approach: Approach,
  ema: number,
  config: IchimokuConfluenceConfig = ICHIMOKU_CONFLUENCE,
): IchimokuContext | null {
  const bar = candles[i];
  if (!bar) return null;

  const side = kumoSide(series, i, bar.close);
  const bullish = cloudIsBullish(series, i);
  if (side === null || bullish === null) return null;

  const pip = pipSize(symbol);
  const long = approach === 'above';

  const tenkan = series.tenkan[i] ?? null;
  const kijun = series.kijun[i] ?? null;
  const tenkanAboveKijun = tenkan !== null && kijun !== null ? tenkan > kijun : false;

  // Chikou is the current close drawn back over the candles of `displacement`
  // bars ago; "free" means it is clear of that range, not merely near it.
  const back = candles[i - series.config.displacement];
  const chikouFree = back ? (long ? bar.close > back.high : bar.close < back.low) : null;

  const kijunDistancePips = kijun === null ? null : Math.abs(ema - kijun) / pip;
  const kijunConfluence = kijunDistancePips !== null && kijunDistancePips <= config.kijunConfluencePips;

  const thickness = kumoThickness(series, i);

  const checks = [
    long ? side === 'above' : side === 'below',
    long ? bullish : !bullish,
    long ? tenkanAboveKijun : !tenkanAboveKijun,
    chikouFree === true,
    kijunConfluence,
  ];
  const score = checks.filter(Boolean).length;

  return {
    kumo: side,
    cloudBullish: bullish,
    tenkanAboveKijun,
    chikouFree,
    kijun,
    kijunDistancePips,
    kijunConfluence,
    cloudPips: thickness === null ? null : thickness / pip,
    score,
    agrees: score >= config.agreeThreshold,
  };
}

/** Human-readable reasons, for the signal tooltip. */
export function explainContext(ctx: IchimokuContext, direction: 'LONG' | 'SHORT'): string[] {
  const want = direction === 'LONG';
  return [
    `Price ${ctx.kumo} the Kumo${(want ? ctx.kumo === 'above' : ctx.kumo === 'below') ? ' ✓' : ''}`,
    `Cloud ${ctx.cloudBullish ? 'bullish' : 'bearish'}${(want ? ctx.cloudBullish : !ctx.cloudBullish) ? ' ✓' : ''}`,
    `Tenkan ${ctx.tenkanAboveKijun ? 'above' : 'below'} Kijun${(want ? ctx.tenkanAboveKijun : !ctx.tenkanAboveKijun) ? ' ✓' : ''}`,
    ctx.chikouFree === null ? 'Chikou: not enough history' : `Chikou ${ctx.chikouFree ? 'free ✓' : 'blocked'}`,
    ctx.kijunDistancePips === null
      ? 'Kijun: unavailable'
      : `EMA50 ${ctx.kijunDistancePips.toFixed(1)} pips from Kijun${ctx.kijunConfluence ? ' ✓' : ''}`,
  ];
}

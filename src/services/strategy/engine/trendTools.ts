/**
 * EMA50 and Ichimoku, read as CONFIRMATION rather than permission.
 *
 * Both modules report a set of independent observations and a net lean. What
 * they deliberately do NOT do is return a veto. The spec is explicit on this
 * twice — "EMA50 should be used as a trend confirmation tool, NOT as a strict
 * mandatory requirement", and "price inside the cloud should reduce
 * confidence, not automatically cancel every trade" — because a strategy that
 * waits for price above a rising EMA *and* above the cloud *and* Tenkan over
 * Kijun has already missed the move those conditions describe.
 *
 * So each observation is a small, separately-earned contribution, and the
 * scorer adds up whatever is present. Absence costs points; it does not
 * disqualify.
 *
 * CORRELATION IS REAL, AND HANDLED BY THE SCORER
 * ──────────────────────────────────────────────
 * "Price above cloud", "Span A above Span B" and "Tenkan above Kijun" are
 * largely one fact seen three ways in a trending market. This module reports
 * them all honestly; the scorer caps the family so a single trend cannot be
 * counted three times at full weight.
 */
import { cloudIsBullish, kumoSide, kumoThickness, type IchimokuSeries, type KumoSide } from '../../../lib/indicators';
import { slopePerBar } from '../../../lib/indicators/ema';
import type { Candle } from '../../marketData/types';
import type { EngineConfig } from './config';

export interface EmaRead {
  value: number;
  /** Change over the slope lookback, divided by ATR. */
  slopeAtr: number;
  direction: 'rising' | 'falling' | 'flat';
  side: 'above' | 'below' | 'at';
  /** |close − EMA| / ATR. Large means extended, not strong. */
  distanceAtr: number;
  /** Price is close enough to the EMA to call it a test. */
  atLevel: boolean;
  /** Price crossed from below to above inside the reclaim window. */
  reclaimed: boolean;
  /** Crossed from above to below. */
  brokeDown: boolean;
  /** Price is far enough from the EMA that chasing it is poor entry. */
  overextended: boolean;
}

export interface IchimokuRead {
  side: KumoSide;
  cloudBullish: boolean | null;
  tenkan: number | null;
  kijun: number | null;
  tenkanAboveKijun: boolean | null;
  /** Direction of the cloud projected `displacement` bars ahead. */
  futureCloudBullish: boolean | null;
  /** Chikou clear of the price range it is drawn over. Null near the edge. */
  chikouFree: 'bullish' | 'bearish' | null;
  /** Cloud thickness in ATR. Thin clouds are weak support/resistance. */
  thicknessAtr: number | null;
  /** Price broke out of the cloud within the reclaim window. */
  brokeAbove: boolean;
  brokeBelow: boolean;
}

export function readEma(
  candles: readonly Candle[],
  ema: readonly (number | null)[],
  end: number,
  atr: number,
  config: EngineConfig,
): EmaRead | null {
  const value = ema[end];
  if (value === null || value === undefined || atr <= 0) return null;

  const close = candles[end]!.close;
  const slope = slopePerBar(ema, end, config.trend.slopeLookback);
  const slopeAtr = slope === null ? 0 : (slope * config.trend.slopeLookback) / atr;
  const distance = close - value;
  const distanceAtr = Math.abs(distance) / atr;

  // A cross inside the window, measured on closes: an intrabar poke through
  // the EMA is not a reclaim.
  let reclaimed = false;
  let brokeDown = false;
  for (let i = Math.max(1, end - config.trend.reclaimWindow + 1); i <= end; i++) {
    const prevEma = ema[i - 1];
    const curEma = ema[i];
    if (prevEma === null || prevEma === undefined || curEma === null || curEma === undefined) continue;
    const prevClose = candles[i - 1]!.close;
    const curClose = candles[i]!.close;
    if (prevClose <= prevEma && curClose > curEma) reclaimed = true;
    if (prevClose >= prevEma && curClose < curEma) brokeDown = true;
  }

  return {
    value,
    slopeAtr,
    direction: slopeAtr > config.trend.slopeAtr ? 'rising' : slopeAtr < -config.trend.slopeAtr ? 'falling' : 'flat',
    side: distanceAtr <= 0.05 ? 'at' : distance > 0 ? 'above' : 'below',
    distanceAtr,
    atLevel: distanceAtr <= config.trend.emaProximityAtr,
    reclaimed,
    brokeDown,
    overextended: distanceAtr >= config.trend.overextendedAtr,
  };
}

export function readIchimoku(
  candles: readonly Candle[],
  series: IchimokuSeries,
  end: number,
  atr: number,
  config: EngineConfig,
): IchimokuRead | null {
  const close = candles[end]!.close;
  const side = kumoSide(series, end, close);
  if (side === null) return null;

  const tenkan = series.tenkan[end] ?? null;
  const kijun = series.kijun[end] ?? null;
  const thickness = kumoThickness(series, end);

  // The cloud as it will be `displacement` bars from now — this is the only
  // genuinely forward-looking thing Ichimoku offers, and it is computed from
  // data that already exists, so it is not a prediction.
  const shift = series.config.displacement;
  const futureA = series.senkouARaw[end] ?? null;
  const futureB = series.senkouBRaw[end] ?? null;
  const futureCloudBullish = futureA === null || futureB === null ? null : futureA > futureB;

  // Chikou is today's close plotted `displacement` bars back. "Free" means it
  // is clear of that bar's range — not merely near it.
  const back = candles[end - shift];
  const chikouFree = !back ? null : close > back.high ? 'bullish' : close < back.low ? 'bearish' : null;

  let brokeAbove = false;
  let brokeBelow = false;
  for (let i = Math.max(1, end - config.trend.reclaimWindow + 1); i <= end; i++) {
    const prev = kumoSide(series, i - 1, candles[i - 1]!.close);
    const cur = kumoSide(series, i, candles[i]!.close);
    if (prev === null || cur === null) continue;
    if (prev !== 'above' && cur === 'above') brokeAbove = true;
    if (prev !== 'below' && cur === 'below') brokeBelow = true;
  }

  return {
    side,
    cloudBullish: cloudIsBullish(series, end),
    tenkan,
    kijun,
    tenkanAboveKijun: tenkan === null || kijun === null ? null : tenkan > kijun,
    futureCloudBullish,
    chikouFree,
    thicknessAtr: thickness === null || atr <= 0 ? null : thickness / atr,
    brokeAbove,
    brokeBelow,
  };
}

/**
 * Momentum: is this move being driven, or is it drifting?
 *
 * Measured as the share of recent range that closed in the direction of the
 * move. Deliberately crude — it exists to separate "price is grinding sideways
 * upward" from "price is being bought", which is the difference between a
 * breakout that runs and one that fades.
 */
export function readMomentum(candles: readonly Candle[], end: number, atr: number, lookback = 10): number {
  if (atr <= 0) return 0;
  const from = Math.max(1, end - lookback + 1);
  let directional = 0;
  let total = 0;
  for (let i = from; i <= end; i++) {
    const c = candles[i]!;
    directional += c.close - c.open;
    total += Math.abs(c.high - c.low);
  }
  if (total === 0) return 0;
  // Normalised to roughly −1..1; clamped because a single gap bar can dominate.
  return Math.max(-1, Math.min(1, directional / (total * 0.5)));
}

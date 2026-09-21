/**
 * State classifiers: EMA50 slope, Kumo condition, and market regime.
 *
 * Each turns raw numbers into a graded category, because the scoring layer
 * needs "how bullish" rather than "bullish yes/no". A thin, barely-formed
 * cloud and a thick well-developed one are both "price above cloud"; treating
 * them identically is exactly the mistake the spec calls out.
 */
import type {
  CloudConfig,
  ConfluenceZoneConfig,
  RegimeConfig,
  SlopeConfig,
} from '../../../config/confluence';
import { cloudIsBullish, kumoSide, kumoThickness, type IchimokuSeries } from '../../../lib/indicators';
import type { OHLC } from '../../../lib/indicators/atr';
import type { MarketStructure } from '../../../lib/indicators/marketStructure';
import type {
  CloudStrength,
  Direction,
  IchimokuBlock,
  MarketCondition,
  SlopeGrade,
  ZoneStrength,
} from './types';

/**
 * Grade the EMA's slope.
 *
 * Measured over a lookback and divided by ATR, so the same thresholds hold on
 * USD/JPY and EUR/GBP. Comparing consecutive bars — the obvious approach —
 * measures the last tick, not the trend, and flips sign constantly.
 */
export function gradeSlope(
  emaSeries: readonly (number | null)[],
  index: number,
  atrValue: number,
  config: SlopeConfig,
): { slope: number; slopeAtr: number; grade: SlopeGrade } | null {
  const now = emaSeries[index];
  const then = emaSeries[index - config.lookback];
  if (now === null || now === undefined || then === null || then === undefined) return null;
  if (!(atrValue > 0)) return null;

  const slope = now - then;
  const slopeAtr = slope / atrValue;

  let grade: SlopeGrade = 'flat';
  if (slopeAtr >= config.strongAtr) grade = 'strong_bullish';
  else if (slopeAtr >= config.mildAtr) grade = 'mild_bullish';
  else if (slopeAtr <= -config.strongAtr) grade = 'strong_bearish';
  else if (slopeAtr <= -config.mildAtr) grade = 'mild_bearish';

  return { slope, slopeAtr, grade };
}

/**
 * Classify the Kumo.
 *
 * Combines colour, thickness and price's position. A bullish cloud that price
 * sits below is NOT a bullish condition — it is resistance overhead — so
 * position is part of the grade rather than a separate flag.
 */
export function classifyCloud(
  series: IchimokuSeries,
  candles: readonly OHLC[],
  index: number,
  atrValue: number,
  pip: number,
  config: CloudConfig,
): IchimokuBlock | null {
  const bar = candles[index];
  if (!bar || !(atrValue > 0)) return null;

  const side = kumoSide(series, index, bar.close);
  const bullish = cloudIsBullish(series, index);
  const thickness = kumoThickness(series, index);
  if (side === null || bullish === null || thickness === null) return null;

  const thicknessAtr = thickness / atrValue;
  const thin = thicknessAtr < config.thinAtr;
  const thick = thicknessAtr >= config.thickAtr;

  let strength: CloudStrength = 'neutral';
  if (side === 'above' && bullish) strength = thick ? 'strong_bullish' : thin ? 'neutral' : 'bullish';
  else if (side === 'below' && !bullish) strength = thick ? 'strong_bearish' : thin ? 'neutral' : 'bearish';
  else if (side === 'above' && !bullish) strength = 'bullish'; // above a bearish cloud: recovering
  else if (side === 'below' && bullish) strength = 'bearish'; // below a bullish cloud: breaking down
  else strength = 'neutral'; // inside the cloud — no edge either way

  // The leading cloud: senkouARaw/BRaw at this bar describe where the cloud
  // will be `displacement` bars from now, which is the forward-looking part of
  // Ichimoku and the reason it is drawn ahead at all.
  const rawA = series.senkouARaw[index] ?? null;
  const rawB = series.senkouBRaw[index] ?? null;
  let futureCloudDirection: 'bullish' | 'bearish' | 'flat' = 'flat';
  if (rawA !== null && rawB !== null) {
    const gap = Math.abs(rawA - rawB) / atrValue;
    if (gap >= config.thinAtr) futureCloudDirection = rawA > rawB ? 'bullish' : 'bearish';
  }

  const tenkan = series.tenkan[index] ?? null;
  const kijun = series.kijun[index] ?? null;
  const tenkanKijunRelation =
    tenkan === null || kijun === null ? 'equal' : tenkan > kijun ? 'tenkan_above' : tenkan < kijun ? 'tenkan_below' : 'equal';

  const back = candles[index - series.config.displacement];
  const chikouFree = back ? (bar.close > back.high ? true : bar.close < back.low ? true : false) : null;

  return {
    priceRelationToCloud: side,
    cloudDirection: bullish ? 'bullish' : 'bearish',
    cloudStrength: strength,
    cloudThicknessAtr: thicknessAtr,
    cloudThicknessPips: thickness / pip,
    tenkan,
    kijun,
    tenkanKijunRelation,
    futureCloudDirection,
    chikouFree,
  };
}

/** Grade how close two levels are, in ATRs. */
export function gradeZone(distanceAtr: number | null, config: ConfluenceZoneConfig): ZoneStrength {
  if (distanceAtr === null) return 'none';
  const d = Math.abs(distanceAtr);
  if (d <= config.strongAtr) return 'strong';
  if (d <= config.moderateAtr) return 'moderate';
  if (d <= config.weakAtr) return 'weak';
  return 'none';
}

export const ZONE_RANK: Record<ZoneStrength, number> = { none: 0, weak: 1, moderate: 2, strong: 3 };

/**
 * Classify the market regime.
 *
 * Order matters: INSUFFICIENT_DATA and the volatility extremes are checked
 * first because they invalidate everything downstream. A textbook indicator
 * alignment inside a CHOPPY market must not produce a strong signal, which is
 * only possible if regime is decided independently of the indicators.
 */
export function classifyRegime(
  candles: readonly OHLC[],
  index: number,
  emaSeries: readonly (number | null)[],
  atrSeries: readonly (number | null)[],
  slopeAtr: number | null,
  structure: MarketStructure | null,
  extensionAtr: number | null,
  config: RegimeConfig,
  overextendedAtr: number,
): MarketCondition {
  const start = index - config.lookback + 1;
  if (start < 0 || !candles[index]) return 'INSUFFICIENT_DATA';

  const atrNow = atrSeries[index];
  if (atrNow === null || atrNow === undefined || atrNow <= 0) return 'INSUFFICIENT_DATA';

  // Volatility extremes — a news spike and a dead market are both untradeable
  // by this strategy, for opposite reasons.
  const volStart = Math.max(0, index - config.volatilityLookback + 1);
  let volSum = 0;
  let volCount = 0;
  for (let i = volStart; i <= index; i++) {
    const a = atrSeries[i];
    if (a !== null && a !== undefined) {
      volSum += a;
      volCount++;
    }
  }
  if (volCount > 0) {
    const avg = volSum / volCount;
    if (avg > 0) {
      const ratio = atrNow / avg;
      if (ratio >= config.volatilitySpike) return 'CHOPPY';
      if (ratio <= config.volatilityDead) return 'RANGING';
    }
  }

  if (extensionAtr !== null && extensionAtr >= overextendedAtr) return 'OVEREXTENDED';

  // How often price flipped sides of the EMA. A trend crosses rarely; chop
  // crosses constantly. This is independent of any indicator's own opinion.
  let above = 0;
  let below = 0;
  let flips = 0;
  let prevSide: 'above' | 'below' | null = null;
  for (let i = start; i <= index; i++) {
    const c = candles[i];
    const e = emaSeries[i];
    if (!c || e === null || e === undefined) continue;
    const side = c.close >= e ? 'above' : 'below';
    if (side === 'above') above++;
    else below++;
    if (prevSide !== null && side !== prevSide) flips++;
    prevSide = side;
  }

  const total = above + below;
  if (total < config.lookback / 2) return 'INSUFFICIENT_DATA';

  const reversalRate = flips / total;
  if (reversalRate >= config.choppyReversalRate) return 'CHOPPY';

  const persistence = Math.max(above, below) / total;
  const trending = slopeAtr !== null && Math.abs(slopeAtr) >= config.trendSlopeAtr;
  const structureAgrees = structure !== null && (structure.direction === 'up' || structure.direction === 'down');

  if (trending && persistence >= config.trendPersistence) {
    const bullish = above > below;
    // Structure disagreeing with the EMA's direction is the signature of a
    // turn in progress, not of an established trend.
    if (structureAgrees && structure.direction !== (bullish ? 'up' : 'down')) return 'TRANSITION';
    return bullish ? 'TRENDING_BULLISH' : 'TRENDING_BEARISH';
  }

  if (trending && persistence < config.trendPersistence) return 'TRANSITION';
  if (structure !== null && structure.direction === 'range') return 'RANGING';
  return 'RANGING';
}

/** Directional bias implied by the regime alone. */
export function regimeBias(condition: MarketCondition): Direction {
  if (condition === 'TRENDING_BULLISH') return 'long';
  if (condition === 'TRENDING_BEARISH') return 'short';
  return 'none';
}

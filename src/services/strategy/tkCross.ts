/**
 * Tenkan/Kijun cross — the Ichimoku entry. Pure functions over candles.
 *
 * WHY THIS REPLACES THE EMA50 TOUCH AS THE TRIGGER
 * ────────────────────────────────────────────────
 * The previous design had it backwards: an EMA50 touch created every signal
 * and Ichimoku was attached afterwards as a 0–5 label that nothing read. The
 * backtest said what that was worth — the touch on its own averaged −0.13
 * pips a trade at a 35.7% win rate against a 36.0% break-even, i.e. nothing.
 * Gating the same touches on Ichimoku agreement moved them to +6…+8 pips.
 * All of the edge was in the part that was only ever a tooltip.
 *
 * So Ichimoku triggers and the EMA reinforces, which is the way round it was
 * always meant to be.
 *
 *          Tenkan (9)  ╱                      bullish cross
 *     ─────────────── ╳ ──────────────        tenkan was ≤ kijun, now >
 *          Kijun (26) ╱
 *
 * WHERE THE CROSS HAPPENS IS MOST OF WHAT IT MEANS
 * ────────────────────────────────────────────────
 * A bullish cross above the cloud is a trend continuing; the same cross below
 * the cloud is a downtrend pausing, and fails far more often. Classical
 * Ichimoku grades them strong / neutral / weak on exactly that, so `strength`
 * is part of the signal rather than something a caller re-derives.
 *
 *   price ABOVE cloud  + bullish cross → strong
 *   price INSIDE cloud + either        → neutral
 *   price BELOW cloud  + bullish cross → weak   (counter to the cloud)
 *
 * WHAT IS CONFIRMATION AND WHAT IS REINFORCEMENT
 * ──────────────────────────────────────────────
 * Confirmation is Ichimoku's own: price against the cloud, Chikou clear, the
 * cloud 26 bars AHEAD (which is known today and is what the trend is walking
 * into), and cloud thickness.
 *
 * Reinforcement is the EMA50, and it can only ever add weight — it cannot
 * create a signal and it cannot veto one. Kept because the measurements
 * showed the EMA50/Kijun relationship is real when both mark the same level,
 * and because the slope is a cheap second opinion on direction.
 *
 * Nothing here filters. Every cross is reported with its grade, exactly as
 * the touch detector did, so a weak signal stays visible and the decision of
 * what to trade is made once, downstream, where it can be measured.
 */
import type { Timeframe } from '../../config/timeframes';
import { EMA50_TOUCH, ICHIMOKU_CONFLUENCE } from '../../config/strategy';
import type { IchimokuConfluenceConfig } from '../../config/strategy';
import {
  atr,
  cloudIsBullish,
  emaOfCloses,
  ichimoku,
  kumoSide,
  kumoThickness,
  slopePerBar,
  type IchimokuSeries,
  type KumoSide,
} from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import type { Trend } from './types';

export type CrossDirection = 'LONG' | 'SHORT';

/** How much the cloud position endorses the cross. */
export type CrossStrength = 'strong' | 'neutral' | 'weak';

export interface TkCrossSignal {
  /** Stable per (symbol, timeframe, bar) — re-scanning never duplicates one. */
  id: string;
  strategy: 'tk-cross';
  symbol: string;
  timeframe: Timeframe;
  /** Open time of the bar the cross completed on, UNIX seconds. */
  barTime: number;
  detectedAt: number;
  direction: CrossDirection;

  /** Close of the cross bar — where a market order would go in. */
  price: number;
  tenkan: number;
  kijun: number;
  atr: number;

  // ── Ichimoku: where and how good ───────────────────────────────────────
  /** Cloud position of the CROSS itself, which sets `strength`. */
  kumo: KumoSide;
  strength: CrossStrength;
  /** Cloud in effect: Senkou A above Senkou B. */
  cloudBullish: boolean;
  /** The cloud 26 bars ahead — where price is heading, knowable today. */
  futureCloudBullish: boolean | null;
  /** Lagging line clear of the candles it is drawn over; null near the edge. */
  chikouFree: boolean | null;
  /** Cloud thickness in pips. Thin cloud = weak support/resistance. */
  cloudPips: number | null;
  /** Ichimoku checks agreeing with the direction, 0–4. */
  ichimokuScore: number;

  // ── EMA50: reinforcement only ──────────────────────────────────────────
  ema: number | null;
  /** Price on the direction's side of the EMA50. */
  emaAgrees: boolean;
  /** EMA50 slope, as a trend label. */
  emaTrend: Trend;
  /** |EMA50 − Kijun| in pips: small means both mark the same level. */
  emaKijunPips: number | null;
  /** Reinforcement points, 0–2. Never gates anything. */
  emaScore: number;
}

export const ICHIMOKU_CROSS_CHECKS = 4;
export const EMA_REINFORCEMENT_CHECKS = 2;

export const tkCrossId = (symbol: string, timeframe: Timeframe, barTime: number) =>
  `tk-cross|${symbol}|${timeframe}|${barTime}`;

export interface TkCrossAnalysis {
  ichimoku: IchimokuSeries;
  ema: (number | null)[];
  signals: TkCrossSignal[];
  reason: 'ok' | 'not-enough-bars';
}

/**
 * Cloud position + direction → grade.
 *
 * Separate and exported because this is the judgement the whole strategy
 * turns on, and it should be testable without building a candle series.
 */
export function strengthOf(direction: CrossDirection, kumo: KumoSide): CrossStrength {
  if (kumo === 'inside') return 'neutral';
  const withCloud = direction === 'LONG' ? kumo === 'above' : kumo === 'below';
  return withCloud ? 'strong' : 'weak';
}

/**
 * Did Tenkan cross Kijun on this bar?
 *
 * Uses `>=` on the previous bar so a cross out of equality counts once, on
 * the bar it resolves, rather than never (strict `<` would miss it) or twice.
 */
export function crossedOn(
  tenkan: (number | null)[],
  kijun: (number | null)[],
  i: number,
): CrossDirection | null {
  const t0 = tenkan[i - 1];
  const k0 = kijun[i - 1];
  const t1 = tenkan[i];
  const k1 = kijun[i];
  if (t0 == null || k0 == null || t1 == null || k1 == null) return null;
  if (t0 <= k0 && t1 > k1) return 'LONG';
  if (t0 >= k0 && t1 < k1) return 'SHORT';
  return null;
}

/**
 * Bars needed before anything is reported.
 *
 * Senkou B looks back 52 and the cloud in effect is displaced 26, so a cloud
 * exists at bar i only once i ≥ 52 + 26. Reporting a cross before that would
 * mean grading it against a cloud that is not there.
 */
export function minBarsFor(series: IchimokuSeries): number {
  return series.config.senkouB + series.config.displacement;
}

export function analyseTkCross(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: IchimokuConfluenceConfig = ICHIMOKU_CONFLUENCE,
  detectedAt = Date.now(),
): TkCrossAnalysis {
  const cloud = ichimoku(candles);
  const emaSeries = emaOfCloses(candles, EMA50_TOUCH.period);

  if (candles.length < minBarsFor(cloud)) {
    return { ichimoku: cloud, ema: emaSeries, signals: [], reason: 'not-enough-bars' };
  }

  const pip = pipSize(symbol);
  const atrSeries = atr(candles, EMA50_TOUCH.atrPeriod);
  const signals: TkCrossSignal[] = [];
  const shift = cloud.config.displacement;

  for (let i = 1; i < candles.length; i++) {
    const direction = crossedOn(cloud.tenkan, cloud.kijun, i);
    if (direction === null) continue;

    const bar = candles[i]!;
    const kumo = kumoSide(cloud, i, bar.close);
    const bullish = cloudIsBullish(cloud, i);
    // No cloud in effect yet — the grade would be meaningless.
    if (kumo === null || bullish === null) continue;

    const long = direction === 'LONG';

    /**
     * The cloud 26 bars ahead, from the raw (undisplaced) values at this bar.
     * This is the part of Ichimoku that is genuinely forward-looking: it is
     * already determined today and tells you what the trend is walking into.
     */
    const aheadA = cloud.senkouARaw[i] ?? null;
    const aheadB = cloud.senkouBRaw[i] ?? null;
    const futureCloudBullish = aheadA === null || aheadB === null ? null : aheadA > aheadB;

    // Chikou is this close drawn back over the candles of `shift` bars ago;
    // "free" means clear of that bar's range, not merely near it.
    const back = candles[i - shift];
    const chikouFree = back ? (long ? bar.close > back.high : bar.close < back.low) : null;

    const thickness = kumoThickness(cloud, i);

    const ichimokuChecks = [
      long ? kumo === 'above' : kumo === 'below',
      long ? bullish : !bullish,
      futureCloudBullish === null ? false : long ? futureCloudBullish : !futureCloudBullish,
      chikouFree === true,
    ];

    // ── EMA50: reinforcement, never a gate ───────────────────────────────
    const e = emaSeries[i] ?? null;
    const emaAgrees = e === null ? false : long ? bar.close > e : bar.close < e;
    const slope = e === null ? null : slopePerBar(emaSeries, i, EMA50_TOUCH.slopeLookback);
    const slopePips = slope === null ? null : slope / pip;
    const emaTrend: Trend =
      slopePips === null
        ? 'flat'
        : slopePips > EMA50_TOUCH.trendSlopePips
          ? 'up'
          : slopePips < -EMA50_TOUCH.trendSlopePips
            ? 'down'
            : 'flat';
    const kijun = cloud.kijun[i] ?? null;
    const emaKijunPips = e === null || kijun === null ? null : Math.abs(e - kijun) / pip;
    const emaChecks = [emaAgrees, emaKijunPips !== null && emaKijunPips <= config.kijunConfluencePips];

    signals.push({
      id: tkCrossId(symbol, timeframe, bar.time),
      strategy: 'tk-cross',
      symbol,
      timeframe,
      barTime: bar.time,
      detectedAt,
      direction,
      price: bar.close,
      tenkan: cloud.tenkan[i]!,
      kijun: kijun!,
      atr: atrSeries[i] ?? 0,
      kumo,
      strength: strengthOf(direction, kumo),
      cloudBullish: bullish,
      futureCloudBullish,
      chikouFree,
      cloudPips: thickness === null ? null : thickness / pip,
      ichimokuScore: ichimokuChecks.filter(Boolean).length,
      ema: e,
      emaAgrees,
      emaTrend,
      emaKijunPips,
      emaScore: emaChecks.filter(Boolean).length,
    });
  }

  return { ichimoku: cloud, ema: emaSeries, signals, reason: 'ok' };
}

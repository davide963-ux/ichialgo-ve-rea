/**
 * Ichimoku + EMA50 confluence — the analysis entry point.
 *
 * Pure: candles in, structured analysis out. No I/O, no state, no clock. That
 * is what lets the same function serve the live scanner, the backtest and the
 * UI without any of them disagreeing about what a signal is.
 *
 * THE HIERARCHY (evaluated in this order, and the order is the strategy)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. MARKET REGIME      is this market tradeable at all?
 *            │            CHOPPY/OVEREXTENDED short-circuits everything below.
 *            ▼
 *   2. TREND ALIGNMENT    which way, and do EMA50 + Kumo + structure agree?
 *            │
 *            ▼
 *   3. CONFLUENCE         do EMA50, Kijun and the cloud mark the SAME level?
 *            │
 *            ▼
 *   4. PULLBACK           has price retraced INTO that level, healthily?
 *            │
 *            ▼
 *   5. CONFIRMATION       has a CLOSED bar rejected the level?
 *            │
 *            ▼
 *   6. SIGNAL + RISK      score, grade, and where the stop belongs.
 *
 * A stage failing does not abort with an error — it produces a lower grade and
 * a recorded reason. The point of the engine is to say WHY it is not taking a
 * trade as clearly as why it is.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ──────────────────────────────────
 * It does not emit a signal because price crossed the EMA50, or because Tenkan
 * crossed Kijun, or because price entered the cloud. Those are context. The
 * entry is a price-action event at a confluence level inside a valid regime,
 * and nothing else qualifies.
 */
import { CONFLUENCE_STRATEGY, type ConfluenceStrategyConfig } from '../../../config/confluence';
import { atr, emaOfCloses, ichimoku } from '../../../lib/indicators';
import { analyseStructure } from '../../../lib/indicators/marketStructure';
import { pipSize } from '../../../lib/pips';
import type { Candle } from '../../marketData/types';
import { analysePullback, findConfirmation } from './pullback';
import { gradeSignal, isActionable, scoreSetup, type ScoreInput } from './scoring';
import { ZONE_RANK, classifyCloud, classifyRegime, gradeSlope, gradeZone } from './states';
import type {
  ConfluenceAnalysis,
  Direction,
  MultiTimeframeBlock,
  SetupStatus,
  SlopeGrade,
} from './types';

export interface AnalyseOptions {
  symbol: string;
  timeframe: string;
  /**
   * False when the newest candle is still forming. Confirmation then only
   * considers bars before it, so a CONFIRMED signal can never rest on a close
   * that has not happened.
   */
  lastBarClosed?: boolean;
  /** Bias from a higher timeframe, when one has been analysed. */
  higherTimeframeBias?: Direction | null;
  /** Bias from a lower timeframe, for entry timing. */
  lowerTimeframeBias?: Direction | null;
  config?: ConfluenceStrategyConfig;
  /** Analyse this bar instead of the last one — used by the backtest. */
  index?: number;
}

const BULLISH_SLOPES: SlopeGrade[] = ['strong_bullish', 'mild_bullish'];
const BEARISH_SLOPES: SlopeGrade[] = ['strong_bearish', 'mild_bearish'];

/** An analysis that says "not enough data" without pretending otherwise. */
function insufficient(symbol: string, timeframe: string, barTime: number, price: number, note: string): ConfluenceAnalysis {
  return {
    symbol,
    timeframe,
    barTime,
    barClosed: false,
    direction: 'none',
    signal: 'NO_TRADE',
    confidence: 0,
    marketCondition: 'INSUFFICIENT_DATA',
    price,
    atr: 0,
    ema50: null,
    ichimoku: null,
    confluence: null,
    marketStructure: null,
    setup: {
      status: 'FORMING',
      pullback: 'none',
      pullbackQuality: 0,
      retracementPct: null,
      confirmation: false,
      confirmationReason: null,
      entryCondition: null,
    },
    risk: {
      suggestedStopReference: null,
      stopDistanceAtr: null,
      stopPips: null,
      entry: null,
      targets: [],
      invalidationCondition: null,
    },
    multiTimeframe: null,
    scoreReasons: [],
    reasons: [],
    warnings: [note],
  };
}

export function analyseConfluence(candles: readonly Candle[], options: AnalyseOptions): ConfluenceAnalysis {
  const config = options.config ?? CONFLUENCE_STRATEGY;
  const { symbol, timeframe } = options;
  const lastBarClosed = options.lastBarClosed ?? false;
  const i = options.index ?? candles.length - 1;

  const bar = candles[i];
  if (!bar) return insufficient(symbol, timeframe, 0, 0, 'No candles available.');
  if (i + 1 < config.minBars) {
    return insufficient(symbol, timeframe, bar.time, bar.close, `Needs ${config.minBars} bars, has ${i + 1}.`);
  }

  const window = candles.slice(0, i + 1);
  const pip = pipSize(symbol);

  const emaSeries = emaOfCloses(window, config.emaPeriod);
  const atrSeries = atr(window, config.atrPeriod);
  const series = ichimoku(window);

  const emaValue = emaSeries[i];
  const atrValue = atrSeries[i];
  if (emaValue === null || emaValue === undefined || atrValue === null || atrValue === undefined || atrValue <= 0) {
    return insufficient(symbol, timeframe, bar.time, bar.close, 'EMA50 or ATR not yet defined.');
  }

  const reasons: string[] = [];
  const warnings: string[] = [];

  // ── EMA50 block ───────────────────────────────────────────────────────────
  const slope = gradeSlope(emaSeries, i, atrValue, config.slope);
  const extensionAtr = Math.abs(bar.close - emaValue) / atrValue;
  const ema50 = {
    value: emaValue,
    slope: slope?.slope ?? 0,
    slopeAtr: slope?.slopeAtr ?? 0,
    direction: slope?.grade ?? ('flat' as SlopeGrade),
    priceRelation: (bar.close > emaValue ? 'above' : bar.close < emaValue ? 'below' : 'at') as 'above' | 'below' | 'at',
    extensionAtr,
    distancePips: Math.abs(bar.close - emaValue) / pip,
  };

  // ── Ichimoku block ────────────────────────────────────────────────────────
  const ichi = classifyCloud(series, window, i, atrValue, pip, config.cloud);

  // ── Structure block ───────────────────────────────────────────────────────
  const structure = analyseStructure(window, i, config.structure, atrValue);

  // ── Regime ────────────────────────────────────────────────────────────────
  const marketCondition = classifyRegime(
    window,
    i,
    emaSeries,
    atrSeries,
    slope?.slopeAtr ?? null,
    structure,
    extensionAtr,
    config.regime,
    config.extension.overextendedAtr,
  );

  // ── Directional thesis ────────────────────────────────────────────────────
  // Taken from the EMA slope and confirmed (or contradicted) by everything
  // else. Nothing forces a direction: a flat EMA yields 'none' and the rest of
  // the pipeline reports why there is no trade rather than inventing one.
  let direction: Direction = 'none';
  if (BULLISH_SLOPES.includes(ema50.direction)) direction = 'long';
  else if (BEARISH_SLOPES.includes(ema50.direction)) direction = 'short';
  else if (marketCondition === 'TRENDING_BULLISH') direction = 'long';
  else if (marketCondition === 'TRENDING_BEARISH') direction = 'short';

  if (direction === 'none') {
    reasons.push('EMA50 is flat and no trend regime is established.');
  }

  // ── Confluence zone ───────────────────────────────────────────────────────
  const kijun = ichi?.kijun ?? null;
  const emaKijunAtr = kijun === null ? null : Math.abs(emaValue - kijun) / atrValue;
  const zoneStrength = gradeZone(emaKijunAtr, config.zone);
  const zoneRank = ZONE_RANK[zoneStrength];

  // The zone level is where a limit order belongs: the midpoint when both
  // methods agree, the EMA alone when they do not.
  const zoneLevel = kijun !== null && zoneRank > 0 ? (emaValue + kijun) / 2 : emaValue;

  const cloudEdgeA = series.senkouA[i] ?? null;
  const cloudEdgeB = series.senkouB[i] ?? null;
  let emaCloudAtr: number | null = null;
  if (cloudEdgeA !== null && cloudEdgeB !== null) {
    emaCloudAtr = Math.min(Math.abs(emaValue - cloudEdgeA), Math.abs(emaValue - cloudEdgeB)) / atrValue;
  }
  const cloudBacked = emaCloudAtr !== null && emaCloudAtr <= config.zone.cloudProximityAtr;

  const confluence = {
    ema50KijunDistanceAtr: emaKijunAtr,
    ema50KijunDistancePips: kijun === null ? null : Math.abs(emaValue - kijun) / pip,
    ema50CloudDistanceAtr: emaCloudAtr,
    zoneStrength,
    zoneLevel,
  };

  // ── Pullback + confirmation ───────────────────────────────────────────────
  const legDirection = direction === 'long' ? 'up' : 'down';
  const pullback =
    direction === 'none'
      ? { state: 'none' as const, retracementPct: null, quality: 0, impulse: null, inZone: false }
      : analysePullback(window, i, structure, legDirection, zoneLevel, atrValue, config.pullback);

  const confirmation =
    direction === 'none'
      ? { confirmed: false, reason: null, barIndex: null }
      : findConfirmation(window, i, legDirection, zoneLevel, atrValue, config.pullback.zoneTouchAtr, config.confirmation, lastBarClosed);

  // ── Scoring ───────────────────────────────────────────────────────────────
  const long = direction === 'long';
  const trendAligned = long ? BULLISH_SLOPES.includes(ema50.direction) : BEARISH_SLOPES.includes(ema50.direction);
  const cloudAligned =
    ichi !== null &&
    (long
      ? ichi.priceRelationToCloud === 'above' && ichi.cloudDirection === 'bullish'
      : ichi.priceRelationToCloud === 'below' && ichi.cloudDirection === 'bearish');
  const tenkanKijunAligned = ichi !== null && (long ? ichi.tenkanKijunRelation === 'tenkan_above' : ichi.tenkanKijunRelation === 'tenkan_below');
  const structureAligned = structure.direction === (long ? 'up' : 'down');
  const structureOpposed = structure.direction === (long ? 'down' : 'up');
  const thinCloud = ichi !== null && ichi.cloudThicknessAtr < config.cloud.thinAtr;
  const choppy = marketCondition === 'CHOPPY';
  const overextended = extensionAtr >= config.extension.stretchedAtr;

  // "Mixed" means the trend evidence disagrees with itself — some of the
  // correlated group pointing one way and some the other. That is a different
  // failure from simply being weak, and deserves its own penalty.
  const trendVotes = [trendAligned, cloudAligned, tenkanKijunAligned];
  const mixedConditions = trendVotes.some(Boolean) && trendVotes.some((v) => !v);

  const scoreInput: ScoreInput = {
    direction: long ? 'long' : 'short',
    trendAligned,
    cloudAligned,
    tenkanKijunAligned,
    chikouFree: ichi?.chikouFree ?? null,
    structureAligned,
    structureOpposed,
    zoneRank,
    cloudBacked,
    pullbackQuality: pullback.quality,
    confirmed: confirmation.confirmed,
    higherTimeframe: options.higherTimeframeBias ?? null,
    mixedConditions,
    overextended,
    choppy,
    thinCloud,
  };

  const score = direction === 'none' ? { confidence: 0, reasons: [], raw: 0, max: 1 } : scoreSetup(scoreInput, config.weights);

  // ── Hard blocks ───────────────────────────────────────────────────────────
  const blocked =
    direction === 'none' ||
    marketCondition === 'INSUFFICIENT_DATA' ||
    marketCondition === 'CHOPPY' ||
    marketCondition === 'OVEREXTENDED' ||
    pullback.state === 'invalidated' ||
    extensionAtr >= config.extension.overextendedAtr;

  if (marketCondition === 'CHOPPY') warnings.push('Choppy regime — indicator alignment here is noise.');
  if (marketCondition === 'OVEREXTENDED') warnings.push('Price overextended from EMA50; wait for a retracement.');
  if (pullback.state === 'invalidated') warnings.push('Retracement exceeded the impulse — the trend is broken, not pulling back.');
  if (thinCloud) warnings.push('Cloud is too thin to act as support or resistance.');
  if (mixedConditions) warnings.push('Ichimoku and EMA50 do not fully agree.');
  if (!confirmation.confirmed && direction !== 'none') warnings.push('No closed-bar rejection at the zone yet.');
  if (!lastBarClosed) warnings.push('Last candle is still forming — entry unconfirmed until it closes.');

  const signal = gradeSignal(
    {
      confidence: score.confidence,
      direction: long ? 'long' : 'short',
      trendStrength: structure.strength,
      zoneRank,
      pullbackQuality: pullback.quality,
      confirmed: confirmation.confirmed,
      blocked,
    },
    config.thresholds,
  );

  // ── Setup status ──────────────────────────────────────────────────────────
  const status: SetupStatus = deriveStatus(signal, pullback.state, confirmation.confirmed, lastBarClosed);

  // ── Risk ──────────────────────────────────────────────────────────────────
  // The stop is anchored to STRUCTURE (the swing that would be broken), not to
  // a round ATR multiple off the entry: what invalidates the idea is price
  // taking out the level the setup is built on.
  const swing = long ? structure.lastSwingLow : structure.lastSwingHigh;
  const anchorCandidates = [swing?.price ?? null, kijun, long ? Math.min(cloudEdgeA ?? Infinity, cloudEdgeB ?? Infinity) : Math.max(cloudEdgeA ?? -Infinity, cloudEdgeB ?? -Infinity)]
    .filter((v): v is number => v !== null && Number.isFinite(v));

  const entry = zoneLevel;
  let stopReference: number | null = null;
  if (anchorCandidates.length > 0) {
    stopReference = long ? Math.min(...anchorCandidates) : Math.max(...anchorCandidates);
  }

  let stop: number | null = null;
  let stopPips: number | null = null;
  let stopDistanceAtr: number | null = null;
  if (stopReference !== null) {
    stop = long ? stopReference - config.risk.stopAtrBuffer * atrValue : stopReference + config.risk.stopAtrBuffer * atrValue;
    const distance = Math.abs(entry - stop);
    const floored = Math.max(distance, config.risk.minStopPips * pip);
    stop = long ? entry - floored : entry + floored;
    stopPips = floored / pip;
    stopDistanceAtr = floored / atrValue;
  }

  const targets =
    stop === null
      ? []
      : config.risk.targetR.map((r) => {
          const distance = Math.abs(entry - stop!);
          return long ? entry + r * distance : entry - r * distance;
        });

  if (trendAligned) reasons.push(`EMA50 ${ema50.direction.replace('_', ' ')} (${ema50.slopeAtr.toFixed(2)} ATR over ${config.slope.lookback} bars).`);
  if (cloudAligned && ichi) reasons.push(`Price ${ichi.priceRelationToCloud} a ${ichi.cloudStrength.replace('_', ' ')} Kumo.`);
  if (structureAligned) reasons.push(`Structure ${structure.direction} (${(structure.strength * 100).toFixed(0)}% clean).`);
  if (zoneRank > 0) reasons.push(`EMA50 and Kijun ${zoneStrength} confluence at ${zoneLevel.toFixed(5)}.`);
  if (pullback.quality > 0 && pullback.retracementPct !== null) {
    reasons.push(`${pullback.state} pullback, ${(pullback.retracementPct * 100).toFixed(0)}% of the impulse retraced.`);
  }
  if (confirmation.reason) reasons.push(confirmation.reason);

  const multiTimeframe: MultiTimeframeBlock | null =
    options.higherTimeframeBias === undefined && options.lowerTimeframeBias === undefined
      ? null
      : buildMtf(direction, options.higherTimeframeBias ?? null, options.lowerTimeframeBias ?? null);

  return {
    symbol,
    timeframe,
    barTime: bar.time,
    barClosed: lastBarClosed,
    direction,
    signal,
    confidence: score.confidence,
    marketCondition,
    price: bar.close,
    atr: atrValue,
    ema50,
    ichimoku: ichi,
    confluence,
    marketStructure: { ...structure, trendStrength: structure.strength },
    setup: {
      status,
      pullback: pullback.state,
      pullbackQuality: pullback.quality,
      retracementPct: pullback.retracementPct,
      confirmation: confirmation.confirmed,
      confirmationReason: confirmation.reason,
      entryCondition: isActionable(signal) ? `Limit at ${entry.toFixed(5)} (EMA50/Kijun zone)` : null,
    },
    risk: {
      suggestedStopReference: stopReference,
      stopDistanceAtr,
      stopPips,
      entry: stop === null ? null : entry,
      targets,
      invalidationCondition:
        stop === null
          ? null
          : `Close beyond ${stop.toFixed(5)}, or retracement past the impulse origin at ${pullback.impulse?.originPrice.toFixed(5) ?? 'n/a'}`,
    },
    multiTimeframe,
    scoreReasons: score.reasons,
    reasons,
    warnings,
  };
}

/**
 * Map the graded signal onto the lifecycle.
 *
 * The state machine's job is anti-duplication: the caller emits only on a
 * TRANSITION, so a setup sitting at CONFIRMED for six bars produces one signal
 * rather than six. Deciding the state here keeps that logic out of the caller.
 */
function deriveStatus(
  signal: ConfluenceAnalysis['signal'],
  pullback: ConfluenceAnalysis['setup']['pullback'],
  confirmed: boolean,
  lastBarClosed: boolean,
): SetupStatus {
  if (pullback === 'invalidated') return 'INVALIDATED';
  if (isActionable(signal)) return confirmed && lastBarClosed ? 'CONFIRMED' : 'CONFIRMING';
  if (signal === 'WATCH_LONG' || signal === 'WATCH_SHORT') return 'FORMING';
  return 'FORMING';
}

function buildMtf(current: Direction, higher: Direction | null, lower: Direction | null): MultiTimeframeBlock {
  let alignment: MultiTimeframeBlock['alignment'] = 'unknown';
  if (higher !== null && current !== 'none') {
    if (higher === 'none') alignment = 'partial';
    else if (higher === current) alignment = lower === null || lower === current ? 'aligned' : 'partial';
    else alignment = 'conflicting';
  }
  return {
    higherTimeframeBias: higher ?? 'none',
    currentTimeframeBias: current,
    lowerTimeframeConfirmation: lower,
    alignment,
  };
}

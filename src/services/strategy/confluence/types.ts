/**
 * The structured analysis object the confluence engine returns.
 *
 * The spec's transparency requirement drives the whole shape of this: every
 * field is a CALCULATED value, not a rendered sentence, so the UI, the
 * backtest and the database all read the same numbers and the explanation is
 * derived from them rather than written alongside them. A signal that cannot
 * be traced back to specific fields here is a bug.
 */
import type { MarketStructure } from '../../../lib/indicators/marketStructure';
import type { KumoSide } from '../../../lib/indicators';

/** Final signal. NO_TRADE and NEUTRAL are first-class answers, not failures. */
export type ConfluenceSignal =
  | 'STRONG_LONG'
  | 'LONG'
  | 'WATCH_LONG'
  | 'NEUTRAL'
  | 'WATCH_SHORT'
  | 'SHORT'
  | 'STRONG_SHORT'
  | 'NO_TRADE';

export type Direction = 'long' | 'short' | 'none';

export type MarketCondition =
  | 'TRENDING_BULLISH'
  | 'TRENDING_BEARISH'
  | 'RANGING'
  | 'CHOPPY'
  | 'TRANSITION'
  | 'OVEREXTENDED'
  | 'INSUFFICIENT_DATA';

export type SlopeGrade = 'strong_bullish' | 'mild_bullish' | 'flat' | 'mild_bearish' | 'strong_bearish';

export type CloudStrength = 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';

export type ZoneStrength = 'none' | 'weak' | 'moderate' | 'strong';

export type PullbackState = 'none' | 'continuation' | 'healthy' | 'deep' | 'invalidated';

/**
 * Setup lifecycle. A signal is emitted on ENTERING a state, never while
 * sitting in one — that is what stops the same setup printing every candle.
 *
 *   FORMING ──▶ CONFIRMING ──▶ CONFIRMED ──▶ ACTIVE ──┬─▶ COMPLETED
 *      ▲                                              └─▶ INVALIDATED
 *      └──────────────── reset ────────────────────────────┘
 */
export type SetupStatus = 'FORMING' | 'CONFIRMING' | 'CONFIRMED' | 'ACTIVE' | 'INVALIDATED' | 'COMPLETED';

export interface Ema50Block {
  value: number;
  /** EMA change over the slope lookback, in price units. */
  slope: number;
  /** That change divided by ATR — comparable across pairs. */
  slopeAtr: number;
  direction: SlopeGrade;
  priceRelation: 'above' | 'below' | 'at';
  /** |close − EMA| / ATR. The overextension measure. */
  extensionAtr: number;
  distancePips: number;
}

export interface IchimokuBlock {
  priceRelationToCloud: KumoSide;
  cloudDirection: 'bullish' | 'bearish' | 'flat';
  cloudStrength: CloudStrength;
  /** Thickness / ATR. */
  cloudThicknessAtr: number;
  cloudThicknessPips: number;
  tenkan: number | null;
  kijun: number | null;
  tenkanKijunRelation: 'tenkan_above' | 'tenkan_below' | 'equal';
  /** Where the leading cloud is heading, read `futureLookahead` bars out. */
  futureCloudDirection: 'bullish' | 'bearish' | 'flat';
  chikouFree: boolean | null;
}

export interface ConfluenceBlock {
  ema50KijunDistanceAtr: number | null;
  ema50KijunDistancePips: number | null;
  ema50CloudDistanceAtr: number | null;
  zoneStrength: ZoneStrength;
  /** The price level the zone is centred on — where a limit order belongs. */
  zoneLevel: number | null;
}

export interface StructureBlock extends MarketStructure {
  trendStrength: number;
}

export interface SetupBlock {
  status: SetupStatus;
  pullback: PullbackState;
  /** 0–1. Depth, location and structure quality of the retracement. */
  pullbackQuality: number;
  /** Retracement of the impulse leg, 0–1+. */
  retracementPct: number | null;
  confirmation: boolean;
  confirmationReason: string | null;
  entryCondition: string | null;
}

export interface RiskBlock {
  /** Structural level the stop is anchored to (swing, Kijun or cloud edge). */
  suggestedStopReference: number | null;
  stopDistanceAtr: number | null;
  stopPips: number | null;
  entry: number | null;
  targets: number[];
  invalidationCondition: string | null;
}

export interface MultiTimeframeBlock {
  higherTimeframeBias: Direction;
  currentTimeframeBias: Direction;
  lowerTimeframeConfirmation: Direction | null;
  alignment: 'aligned' | 'conflicting' | 'partial' | 'unknown';
}

/** One scored condition, with the points it moved confidence by. */
export interface ScoreReason {
  key: string;
  label: string;
  points: number;
  /** Correlated conditions share a group and are capped together. */
  group: string | null;
}

export interface ConfluenceAnalysis {
  symbol: string;
  timeframe: string;
  /** Open time of the analysed bar, UNIX seconds. */
  barTime: number;
  /** False when the last candle is still forming — no CONFIRMED signal then. */
  barClosed: boolean;

  direction: Direction;
  signal: ConfluenceSignal;
  /** 0–100. */
  confidence: number;
  marketCondition: MarketCondition;

  price: number;
  atr: number;

  ema50: Ema50Block | null;
  ichimoku: IchimokuBlock | null;
  confluence: ConfluenceBlock | null;
  marketStructure: StructureBlock | null;
  setup: SetupBlock;
  risk: RiskBlock;
  multiTimeframe: MultiTimeframeBlock | null;

  /** Every condition that moved the score, positive and negative. */
  scoreReasons: ScoreReason[];
  reasons: string[];
  warnings: string[];
}

/**
 * Ichimoku + EMA50 confluence strategy — every tunable number, in one place.
 *
 * NOTHING in the analysis layer hardcodes a threshold. Each module takes its
 * slice of this object as a parameter (defaulted to the export below), so the
 * whole strategy can be re-tuned, A/B'd or swept in a backtest without editing
 * logic. That is a hard rule: a magic number in a detector is a bug.
 *
 * WHY DISTANCES ARE IN ATR, NOT PIPS
 * ──────────────────────────────────
 * "Price is 15 pips from the EMA" means something completely different on
 * USD/JPY in a news hour than on EUR/CHF overnight. Every distance below is
 * expressed as a MULTIPLE OF ATR(14), so one threshold works across pairs,
 * timeframes and volatility regimes:
 *
 *      distanceAtr = |price − level| / atr
 *
 *   0.0 ─────── 0.5 ─────────── 1.5 ─────────── 3.0 ───────▶
 *     at the level   near      moderate     far    overextended
 *
 * The only pip-denominated values left are display helpers and the stop floor,
 * where an absolute broker-imposed minimum genuinely applies.
 */

/** How the EMA50's slope is graded. */
export interface SlopeConfig {
  /**
   * Bars the slope is measured over. Comparing an EMA to the bar immediately
   * before it measures noise, not direction — one tick of a forming candle can
   * flip the sign. A lookback smooths that out.
   */
  lookback: number;
  /**
   * Slope thresholds, as (EMA change over the lookback) / ATR. Normalising by
   * ATR is what makes a single threshold valid on both USD/JPY and AUD/NZD.
   */
  strongAtr: number;
  mildAtr: number;
}

/** How the Kumo's condition is graded. */
export interface CloudConfig {
  /**
   * Cloud thickness / ATR. A cloud thinner than this is cosmetic: price walks
   * through it without noticing, so it must not be read as support.
   */
  thinAtr: number;
  /** Thickness / ATR at which the cloud counts as a substantial barrier. */
  thickAtr: number;
  /** Bars ahead used to read where the leading cloud is heading. */
  futureLookahead: number;
}

/** When two independent methods are marking the same level. */
export interface ConfluenceZoneConfig {
  /** |EMA50 − Kijun| / ATR below this = the strongest form of agreement. */
  strongAtr: number;
  moderateAtr: number;
  weakAtr: number;
  /** |EMA50 − nearest cloud edge| / ATR for the EMA to count as cloud-backed. */
  cloudProximityAtr: number;
}

/** Swing detection and the highs/lows read that follows from it. */
export interface StructureConfig {
  /**
   * Bars either side of a candidate swing that must be lower (for a high) or
   * higher (for a low). Larger = fewer, more meaningful pivots.
   */
  fractalWings: number;
  /** Swings considered when reading the sequence of highs and lows. */
  swingLookback: number;
  /** Bars scanned back for swings at all. */
  maxBars: number;
  /**
   * Minimum swing size / ATR. Filters pivots that are really just noise on
   * an otherwise straight move.
   */
  minSwingAtr: number;
}

/** What separates a healthy pullback from a broken trend. */
export interface PullbackConfig {
  /** Retracement of the last impulse below this is not yet a pullback. */
  shallowPct: number;
  /** Retracement above this is deep — still valid, but lower quality. */
  deepPct: number;
  /** Beyond this the move is not a pullback, it is a reversal. */
  invalidationPct: number;
  /** Bars an impulse leg may span and still be "the current move". */
  maxImpulseBars: number;
  /** Price within this many ATRs of EMA50/Kijun counts as reaching the zone. */
  zoneTouchAtr: number;
}

/** Price-action confirmation, required before any actionable signal. */
export interface ConfirmationConfig {
  /**
   * Close must recover this fraction of the confirming bar's range, measured
   * from the extreme that tagged the zone. A long needs a bar that was pushed
   * down into the zone and closed back up.
   */
  minCloseRecovery: number;
  /** Rejection wick / total range needed for a bar to count as a rejection. */
  minWickRatio: number;
  /** Bars after the zone touch within which confirmation must arrive. */
  window: number;
}

/** Overextension guard — a good setup entered too late is a bad trade. */
export interface ExtensionConfig {
  /** |close − EMA50| / ATR above this reduces confidence. */
  stretchedAtr: number;
  /** Above this the setup is rejected outright. */
  overextendedAtr: number;
}

/** Market regime classification inputs. */
export interface RegimeConfig {
  /** ADX-free trend test: |EMA50 slope| / ATR above this reads as trending. */
  trendSlopeAtr: number;
  /**
   * Fraction of recent bars whose close sits on one side of the EMA50 for the
   * market to count as directional rather than ranging.
   */
  trendPersistence: number;
  /** Bars examined when classifying the regime. */
  lookback: number;
  /** ATR / average ATR above this = volatility spike (news). */
  volatilitySpike: number;
  /** ATR / average ATR below this = dead market, targets unreachable. */
  volatilityDead: number;
  /** Bars the average ATR is taken over. */
  volatilityLookback: number;
  /**
   * Fraction of recent bars that change direction, above which the market is
   * choppy — indicator alignment there is noise, not a trend.
   */
  choppyReversalRate: number;
}

/**
 * Score weights. Every one of these is a REASON attached to the result, so a
 * confidence number can always be traced back to the conditions that produced
 * it. Positives and negatives are symmetric for long and short.
 *
 * CORRELATION DISCIPLINE: "price above cloud", "cloud is bullish" and "Tenkan
 * above Kijun" are not independent — in a strong uptrend all three are true by
 * construction. Scoring each at full weight would triple-count one fact and
 * manufacture false confidence. They are therefore grouped, and a group is
 * capped at `maxGroupContribution` no matter how many of its members agree.
 */
export interface ScoreWeights {
  trendAlignment: number;
  cloudAlignment: number;
  tenkanKijun: number;
  chikouFree: number;
  marketStructure: number;
  emaKijunConfluence: number;
  cloudConfluence: number;
  pullbackQuality: number;
  entryConfirmation: number;
  higherTimeframeAgrees: number;

  mixedConditions: number;
  overextension: number;
  choppyMarket: number;
  thinCloud: number;
  counterStructure: number;
  higherTimeframeConflicts: number;

  /** Cap on any one correlated group's total contribution. */
  maxGroupContribution: number;
}

/** Confidence gates, on the 0–100 scale the score is normalised to. */
export interface ThresholdConfig {
  /** Below this nothing is emitted beyond NEUTRAL. */
  watch: number;
  /** Actionable LONG / SHORT. */
  actionable: number;
  /** STRONG_LONG / STRONG_SHORT. */
  strong: number;
  /** Minimum trend strength (0–1) for an actionable directional signal. */
  minTrendStrength: number;
  /** Minimum confluence zone grade required: 0 none, 1 weak, 2 moderate, 3 strong. */
  minZoneStrength: number;
  /** Pullback quality (0–1) below which no actionable signal is produced. */
  minPullbackQuality: number;
  /** Entry confirmation is mandatory for an actionable signal. */
  requireConfirmation: boolean;
}

/** Stop placement reference for the risk block. */
export interface RiskConfig {
  /** Stop sits this many ATRs beyond the structural reference level. */
  stopAtrBuffer: number;
  /** Never tighter than this, whatever ATR says. */
  minStopPips: number;
  /** Take-profit multiples of the stop distance. */
  targetR: readonly number[];
}

export interface ConfluenceStrategyConfig {
  emaPeriod: number;
  atrPeriod: number;
  /** Bars required before the engine will say anything at all. */
  minBars: number;
  slope: SlopeConfig;
  cloud: CloudConfig;
  zone: ConfluenceZoneConfig;
  structure: StructureConfig;
  pullback: PullbackConfig;
  confirmation: ConfirmationConfig;
  extension: ExtensionConfig;
  regime: RegimeConfig;
  weights: ScoreWeights;
  thresholds: ThresholdConfig;
  risk: RiskConfig;
}

export const CONFLUENCE_STRATEGY: ConfluenceStrategyConfig = {
  emaPeriod: 50,
  atrPeriod: 14,
  // 52 (Senkou B) + 26 (displacement) before a cloud is even in effect, plus
  // room for structure and slope on top.
  minBars: 120,

  slope: {
    lookback: 10,
    strongAtr: 0.8,
    mildAtr: 0.25,
  },

  cloud: {
    thinAtr: 0.5,
    thickAtr: 1.5,
    futureLookahead: 26,
  },

  zone: {
    strongAtr: 0.3,
    moderateAtr: 0.7,
    weakAtr: 1.2,
    cloudProximityAtr: 1.0,
  },

  structure: {
    fractalWings: 2,
    swingLookback: 6,
    maxBars: 120,
    minSwingAtr: 0.5,
  },

  pullback: {
    shallowPct: 0.15,
    deepPct: 0.618,
    invalidationPct: 1.0,
    maxImpulseBars: 60,
    zoneTouchAtr: 0.75,
  },

  confirmation: {
    minCloseRecovery: 0.5,
    minWickRatio: 0.35,
    window: 3,
  },

  extension: {
    stretchedAtr: 1.5,
    overextendedAtr: 3.0,
  },

  regime: {
    trendSlopeAtr: 0.25,
    trendPersistence: 0.7,
    lookback: 30,
    volatilitySpike: 2.0,
    volatilityDead: 0.5,
    volatilityLookback: 50,
    choppyReversalRate: 0.55,
  },

  weights: {
    trendAlignment: 14,
    cloudAlignment: 10,
    tenkanKijun: 8,
    chikouFree: 7,
    marketStructure: 14,
    emaKijunConfluence: 12,
    cloudConfluence: 6,
    pullbackQuality: 14,
    entryConfirmation: 18,
    higherTimeframeAgrees: 10,

    mixedConditions: -10,
    overextension: -15,
    choppyMarket: -20,
    thinCloud: -6,
    counterStructure: -18,
    higherTimeframeConflicts: -20,

    // Trend+cloud+Tenkan/Kijun sum to 32 raw; capped here so one underlying
    // fact cannot be counted three times.
    maxGroupContribution: 24,
  },

  thresholds: {
    watch: 45,
    actionable: 62,
    strong: 78,
    minTrendStrength: 0.35,
    minZoneStrength: 1,
    minPullbackQuality: 0.3,
    requireConfirmation: true,
  },

  risk: {
    stopAtrBuffer: 0.5,
    minStopPips: 8,
    targetR: [1.5, 2.5, 3.5],
  },
};

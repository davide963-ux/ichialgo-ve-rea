/**
 * Every tunable the engine has, in one file.
 *
 * WHY ATR-NORMALISED
 * ──────────────────
 * Almost every threshold here is expressed in ATR multiples rather than pips
 * or percentages. A 15-pip zone is loose on GBP/JPY and absurdly tight on
 * EUR/CHF; the same number in ATR means the same thing on both, and on 15M as
 * well as 4H. Hard-coded pip thresholds are why scanners work on the pair they
 * were tuned on and nowhere else.
 *
 * THE SCORING PHILOSOPHY
 * ──────────────────────
 * The weights below sum to 100 and are deliberately spread across eight
 * independent families of evidence. No single family can, on its own, reach
 * the 72 needed for a tradeable signal — and none is mandatory. That is the
 * whole design: the engine weighs total evidence instead of running an AND
 * chain, because an AND chain over nine conditions produces a signal roughly
 * never.
 */

export interface EngineConfig {
  /** Bars of history required before the engine will say anything. */
  minBars: number;
  emaPeriod: number;
  atrPeriod: number;

  structure: {
    /** Bars either side of a pivot for it to count as a swing. */
    fractalWings: number;
    /** Swings considered when reading the trend. */
    swingLookback: number;
    /** How far back to look for swings at all. */
    maxBars: number;
    /** A swing must stand this far clear of its neighbours, in ATR. */
    minSwingAtr: number;
    /** A break must clear the level by this much of ATR to count. */
    breakBufferAtr: number;
    /** A BOS/CHoCH older than this is history, not a live event. */
    freshnessBars: number;
  };

  levels: {
    /** Touches within this ATR distance are treated as the same level. */
    clusterAtr: number;
    /** A level needs at least this many touches to be a zone. */
    minTouches: number;
    /** How far back to gather levels. */
    lookback: number;
    /** Price is "at" a level within this ATR distance. */
    proximityAtr: number;
    /** Bars after a break in which a retest still counts as a retest. */
    retestWindow: number;
  };

  candles: {
    /** Body smaller than this fraction of range is a doji. */
    dojiBodyRatio: number;
    /** Wick longer than this multiple of the body makes a pin bar. */
    pinWickRatio: number;
    /** The opposite wick must be no longer than this fraction of the range. */
    pinOppositeMax: number;
    /** A candle must be at least this fraction of recent average range. */
    minRangeRatio: number;
    /** Only patterns completing within this many bars are live. */
    freshnessBars: number;
  };

  patterns: {
    /** Bars to search for chart patterns. */
    lookback: number;
    /** Two swings are "equal" within this ATR distance. */
    equalityAtr: number;
    /** Minimum height of a pattern, in ATR, to be worth trading. */
    minHeightAtr: number;
    /** A pattern completing more than this many bars ago is stale. */
    freshnessBars: number;
  };

  trend: {
    /** EMA slope over this lookback. */
    slopeLookback: number;
    /** Slope beyond this many ATR counts as a real trend, not drift. */
    slopeAtr: number;
    /** Price within this ATR of the EMA counts as a retest. */
    emaProximityAtr: number;
    /** Bars to look back for an EMA reclaim or breakdown. */
    reclaimWindow: number;
    /** Cloud thinner than this in ATR is weak support/resistance. */
    thinCloudAtr: number;
    /** Price beyond this ATR from the EMA is overextended. */
    overextendedAtr: number;
  };

  /**
   * Points available per family of evidence. They sum to 100.
   *
   * The split matters more than the exact numbers: structure and the
   * break/level context together carry half the weight, because that is what
   * actually defines a setup. Indicators confirm; they do not create.
   */
  weights: {
    marketStructure: number;
    breakEvent: number;
    supportResistance: number;
    chartPattern: number;
    candlePattern: number;
    ema: number;
    ichimoku: number;
    momentum: number;
  };

  risk: {
    /** Stop placed this far beyond the structural level, in ATR. */
    stopBufferAtr: number;
    /** Never risk less than this, in ATR — a stop inside noise is not a stop. */
    minStopAtr: number;
    /** Nor more than this: a huge stop makes any RR arithmetic meaningless. */
    maxStopAtr: number;
    /** Fallback targets when no structural level is available, in R. */
    fallbackTargetR: number[];
    /**
     * Reject a signal whose first target pays less than this.
     *
     * The spec's "avoid signals where the stop is too large compared with the
     * available take profit" — enforced as a hard gate rather than a scoring
     * penalty, because no amount of confluence makes a 0.4R trade worth taking.
     */
    minRewardRisk: number;
  };

  /** Points added or removed by cross-timeframe agreement. */
  mtf: {
    /** Higher timeframe agrees with the setup. */
    aligned: number;
    /** Higher timeframe is neutral — no help, no harm. */
    neutral: number;
    /** Higher timeframe disagrees. Negative. */
    conflicting: number;
    /** Entry timeframe confirms the turn. */
    entryConfirmed: number;
  };
}

export const ENGINE: EngineConfig = {
  // 200 bars: Senkou B alone needs 52 and the cloud is displaced 26 further,
  // so a shorter series has no cloud in effect and no room for structure.
  minBars: 200,
  emaPeriod: 50,
  atrPeriod: 14,

  structure: {
    fractalWings: 2,
    swingLookback: 6,
    maxBars: 150,
    minSwingAtr: 0.4,
    breakBufferAtr: 0.12,
    freshnessBars: 12,
  },

  levels: {
    clusterAtr: 0.45,
    minTouches: 2,
    lookback: 150,
    proximityAtr: 0.6,
    retestWindow: 15,
  },

  candles: {
    dojiBodyRatio: 0.1,
    pinWickRatio: 2.0,
    pinOppositeMax: 0.25,
    minRangeRatio: 0.6,
    freshnessBars: 3,
  },

  patterns: {
    lookback: 120,
    equalityAtr: 0.5,
    minHeightAtr: 1.2,
    freshnessBars: 15,
  },

  trend: {
    slopeLookback: 10,
    slopeAtr: 0.2,
    emaProximityAtr: 0.5,
    reclaimWindow: 10,
    thinCloudAtr: 0.4,
    overextendedAtr: 3.0,
  },

  weights: {
    marketStructure: 20,
    breakEvent: 15,
    supportResistance: 15,
    chartPattern: 10,
    candlePattern: 10,
    ema: 10,
    ichimoku: 10,
    momentum: 10,
  },

  risk: {
    stopBufferAtr: 0.35,
    minStopAtr: 0.8,
    maxStopAtr: 4.0,
    fallbackTargetR: [1.5, 2.5, 3.5],
    minRewardRisk: 1.2,
  },

  mtf: {
    aligned: 10,
    neutral: 0,
    conflicting: -14,
    entryConfirmed: 7,
  },
};

/**
 * Every tunable the engine has, in one file.
 *
 * WHY typical range-NORMALISED
 * ──────────────────
 * Almost every threshold here is expressed in typical range multiples rather than pips
 * or percentages. A 15-pip zone is loose on GBP/JPY and absurdly tight on
 * EUR/CHF; the same number in typical range means the same thing on both, and on 15M as
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
  /** Bars averaged to get the typical candle range every threshold is scaled by. */
  rangeLookback: number;

  structure: {
    /** Bars either side of a pivot for it to count as a swing. */
    fractalWings: number;
    /** Swings considered when reading the trend. */
    swingLookback: number;
    /** How far back to look for swings at all. */
    maxBars: number;
    /** A swing must stand this far clear of its neighbours, in typical range. */
    minSwingRange: number;
    /** A break must clear the level by this much of typical range to count. */
    breakBufferRange: number;
    /** A BOS/CHoCH older than this is history, not a live event. */
    freshnessBars: number;
  };

  levels: {
    /** Touches within this typical range distance are treated as the same level. */
    clusterRange: number;
    /** A level needs at least this many touches to be a zone. */
    minTouches: number;
    /** How far back to gather levels. */
    lookback: number;
    /** Price is "at" a level within this typical range distance. */
    proximityRange: number;
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
    /** Two swings are "equal" within this typical range distance. */
    equalityRange: number;
    /** Minimum height of a pattern, in typical range, to be worth trading. */
    minHeightRange: number;
    /** A pattern completing more than this many bars ago is stale. */
    freshnessBars: number;
  };

  /**
   * Refusing to trade a market that is going nowhere.
   *
   * The strategy is trend-following: it earns in trends and bleeds in ranges.
   * Measured across generated markets it returned +0.23R a trade in trending
   * conditions and −0.30R in mean-reverting ones, which is exactly why a live
   * backtest over an arbitrary window came back negative on every pair —
   * real intraday forex spends most of its time ranging.
   *
   * Swing structure alone cannot see this, so efficiency gates it.
   */
  chop: {
    /** Bars over which directional efficiency is measured. */
    lookback: number;
    /**
     * Below this, no signal may be actionable however good it looks.
     *
     * Swept rather than guessed. Blended expectancy across trending,
     * mean-reverting and random-walk markets, in R per trade:
     *
     *   0.00 (off) −0.061    0.18  +0.103
     *   0.10       +0.003    0.22  +0.154
     *   0.15       +0.073    0.28  +0.206  ← here
     *                        0.35  +0.204
     *
     * It improves monotonically to 0.28 and then flattens, so this is a knee
     * rather than a fitted peak. The cost is roughly a third of the trades;
     * the benefit is that the system stops paying to be in markets that were
     * never going to move.
     */
    minEfficiency: number;
    /** Below this, efficiency is additionally penalised in the score. */
    weakEfficiency: number;
  };

  trend: {
    /** EMA slope over this lookback. */
    slopeLookback: number;
    /** Slope beyond this many typical range counts as a real trend, not drift. */
    slopeRatio: number;
    /** Price within this typical range of the EMA counts as a retest. */
    emaProximityRange: number;
    /** Bars to look back for an EMA reclaim or breakdown. */
    reclaimWindow: number;
    /** Cloud thinner than this in typical range is weak support/resistance. */
    thinCloudRange: number;
    /** Price beyond this typical range from the EMA is overextended. */
    overextendedRange: number;
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
    /**
     * Wick allowance beyond the structural level, in typical candle ranges.
     *
     * A stop sitting exactly on an obvious swing low is the most reliably
     * hunted price in the market. This is the only place volatility enters
     * the stop at all — it moves the stop a little further out, and never
     * closer.
     */
    stopBufferRange: number;
    /** Fallback target when no structural level is available, in R. */
    fallbackTargetR: number;
    /**
     * Fraction of the way to the obstacle the target is placed.
     *
     * The obstacle is where the opposing orders are, so price often turns a
     * few pips short of it. Aiming at the level exactly turns moves that went
     * the right way into full losses.
     */
    targetHaircut: number;
    /**
     * Reject a signal whose first target pays less than this.
     *
     * The spec's "avoid signals where the stop is too large compared with the
     * available take profit" — enforced as a hard gate rather than a scoring
     * penalty, because no amount of confluence makes a 0.4R trade worth taking.
     */
    minRewardRisk: number;
    /**
     * Reward/risk above which the STOP is treated as wrong, not the trade.
     *
     * A ticket showing 8R is not a wonderful opportunity; it is a stop so
     * close to entry that it is inside ordinary movement. Price is already
     * standing on the level, so the level is not "where the idea is wrong" —
     * it is where the idea is happening.
     *
     * Measured: with no ceiling, the 3R-and-above bucket won 10% of the time
     * where geometry demands roughly 25%, and returned −0.49R a trade on a
     * random walk that must return zero. Rather than impose a volatility
     * minimum — which is what created the problem in the first place — the
     * risk module steps OUT to the next structural level and re-checks.
     */
    maxRewardRisk: number;
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
  rangeLookback: 14,

  structure: {
    fractalWings: 2,
    swingLookback: 6,
    maxBars: 150,
    minSwingRange: 0.4,
    breakBufferRange: 0.12,
    freshnessBars: 12,
  },

  levels: {
    clusterRange: 0.45,
    minTouches: 2,
    lookback: 150,
    proximityRange: 0.6,
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
    equalityRange: 0.5,
    minHeightRange: 1.2,
    freshnessBars: 15,
  },

  chop: {
    lookback: 30,
    minEfficiency: 0.28,
    weakEfficiency: 0.35,
  },

  trend: {
    slopeLookback: 10,
    slopeRatio: 0.2,
    emaProximityRange: 0.5,
    reclaimWindow: 10,
    thinCloudRange: 0.4,
    overextendedRange: 3.0,
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
    stopBufferRange: 0.35,
    fallbackTargetR: 2.0,
    targetHaircut: 0.9,
    minRewardRisk: 1.2,
    maxRewardRisk: 5,
  },

  mtf: {
    aligned: 10,
    neutral: 0,
    conflicting: -14,
    entryConfirmed: 7,
  },
};

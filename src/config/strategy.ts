/**
 * EMA-50 touch strategy configuration.
 *
 * Everything the detector needs to decide "did this pair touch the EMA50?"
 * lives here, so the behaviour can be tuned without editing the logic.
 */
export interface Ema50TouchConfig {
  /** Period of the moving average being touched. */
  period: number;
  /**
   * Touch tolerance. Price rarely prints the EMA to the 5th decimal, so a
   * touch is "price entered a band around the EMA". The band is
   *   max(atr * atrMultiple, minPips)
   * — volatility-aware, with a floor so a dead market still needs a real move.
   */
  atrPeriod: number;
  atrMultiple: number;
  minTolerancePips: number;
  /**
   * Re-arm distance, in tolerance bands. After a touch the pair stops
   * signalling until price closes this far away from the EMA again — without
   * it, a market riding the EMA emits a signal on every single bar.
   */
  rearmBands: number;
  /** Bars used to measure the EMA's slope (trend context). */
  slopeLookback: number;
  /** Slope, in pips per bar, above which the EMA counts as trending. */
  trendSlopePips: number;
  /** Bars of history the detector needs before it reports anything. */
  get minBars(): number;
}

export const EMA50_TOUCH: Ema50TouchConfig = {
  period: 50,
  atrPeriod: 14,
  atrMultiple: 0.15,
  minTolerancePips: 1.5,
  rearmBands: 1.5,
  slopeLookback: 10,
  trendSlopePips: 0.15,
  get minBars() {
    return this.period + this.slopeLookback;
  },
};

/**
 * How a touch becomes a trade plan. The stop sits an ATR multiple beyond the
 * EMA — far enough that the wick that made the touch does not take it out —
 * and the target is a fixed multiple of that risk.
 */
export interface TradePlanConfig {
  /** Stop distance from the entry, in ATRs. */
  stopAtrMultiple: number;
  /** Take profit = this many times the stop distance (the R multiple). */
  rewardMultiple: number;
  /** Floor on the stop, so a dead-calm ATR cannot produce a 2-pip stop. */
  minStopPips: number;
}

export const TRADE_PLAN: TradePlanConfig = {
  stopAtrMultiple: 1.5,
  rewardMultiple: 2,
  minStopPips: 8,
};

export const STRATEGY_CONFIG = {
  /** Newest-first cap on the in-memory signal log. */
  maxSignals: 200,
  /** A live (intrabar) touch stays "active" this long without a new tick. */
  liveSignalTtlMs: 15 * 60_000,
  ema50Touch: EMA50_TOUCH,
  tradePlan: TRADE_PLAN,
} as const;

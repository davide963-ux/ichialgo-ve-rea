/**
 * The pure-Ichimoku strategy's configuration.
 *
 * Nothing here refers to an EMA or an ATR, and nothing in the detector that
 * reads it does either. Every distance is derived from Ichimoku's own
 * geometry — see `rangePeriod` below for how, since "Ichimoku with no
 * volatility measure" is the problem this configuration exists to solve.
 */

export interface IchimokuStrategyConfig {
  /**
   * The lookback whose high-low range stands in for volatility.
   *
   * ATR used to size the touch band and the stop. Removing it leaves the
   * strategy with no sense of distance at all — but Ichimoku already contains
   * one, because Kijun-sen IS the midpoint of this range:
   *
   *     Kijun = (highest high + lowest low) / 2   over `rangePeriod` bars
   *
   * So `highest high - lowest low` over the same window is a volatility
   * measure that needs no new indicator and no new parameter. It is the
   * Kijun's own width. Matching it to the Kijun period is deliberate: the
   * level being traded and the distance around it then describe the same
   * stretch of market.
   */
  rangePeriod: number;

  /**
   * Half-width of the pullback zone around Kijun, as a fraction of the range.
   *
   * Price rarely prints the Kijun exactly, so a "touch" is entry into a band
   * around it. 0.08 of a 26-bar range is roughly a tenth of recent travel —
   * wide enough to catch a genuine retest, tight enough that drifting near
   * the line does not count.
   */
  touchBand: number;

  /**
   * How far price must close from Kijun before the pair can signal again.
   * In multiples of `touchBand`. Without it, price tracking the Kijun would
   * fire on every bar.
   */
  rearmBands: number;

  /** Stop distance, as a fraction of the range. */
  stopRange: number;

  /** Take profit = this many times the stop distance. */
  rewardMultiple: number;

  /**
   * Confirmations required, out of 4, before a signal is tradeable.
   *
   * Measured on the fixtures, raising this is the only knob that reliably
   * improves the result: on the harder half of the data the same setup goes
   * from −4.60 pips at 2 to +0.33 at 4. It is a gate, not a label — which is
   * the mistake the previous strategy made with its Ichimoku score.
   */
  minScore: number;
}

export const ICHIMOKU_STRATEGY: IchimokuStrategyConfig = {
  rangePeriod: 26,
  touchBand: 0.08,
  rearmBands: 1.5,
  stopRange: 0.4,
  rewardMultiple: 2,
  minScore: 4,
};

/** Confirmations the score is out of. */
export const ICHIMOKU_SIGNAL_CHECKS = 4;

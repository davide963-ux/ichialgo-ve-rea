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
   * A GATE, not a label. The previous strategy produced a setup and scored it
   * afterwards, which meant the score decided nothing; here a pullback below
   * this threshold is not emitted at all.
   *
   * It is the one setting with measured evidence behind it, and the evidence
   * is narrower than it looks. Over the whole fixture set at one pip of cost
   * the result improves monotonically with the gate — +0.33, +1.15, +1.43,
   * +3.89 pips at 1, 2, 3 and 4 — but the gain sits almost entirely in the
   * HARD half of the data: on the older 60% it turns −4.00 into +0.66, while
   * on the kinder last 40% it is a wash and slightly negative (+11.26 at 2,
   * +10.68 at 4). Four is chosen for the first of those, not the second.
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

/**
 * The strategies, and their settings. Ichimoku only, in all three.
 *
 * Nothing here refers to a moving average or an average true range, and
 * nothing in the detectors that read it does either — a test reads the source
 * of every strategy file and fails if one appears. Every distance comes from
 * Ichimoku's own geometry; see `rangePeriod` below for how, since "Ichimoku
 * with no volatility measure" is the problem this file exists to solve.
 *
 * THREE STRATEGIES, TWO AUTHORS
 * ─────────────────────────────
 * `ICHIMOKU_STRATEGY` is ours. `OANDA_PULLBACK` and `OANDA_BREAKOUT` are
 * OANDA's published rules, implemented to the letter from their Ichimoku
 * Cloud trading guide. Where the article specifies a condition, the code
 * matches it exactly; where the article is silent, the gap is marked OURS in
 * a comment, because the difference between "OANDA says this" and "we chose
 * this" is the whole value of having both.
 */

export interface IchimokuStrategyConfig {
  /**
   * The lookback whose high-low range stands in for volatility.
   *
   * Removing the average true range left the strategy with no sense of
   * distance at all — but Ichimoku already contains one, because Kijun-sen IS
   * the midpoint of this range:
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

/** Confirmations our own strategy's score is out of. */
export const ICHIMOKU_SIGNAL_CHECKS = 4;

/**
 * Where the ticket comes from, for EVERY strategy.
 *
 * OANDA's article gives no stop, no target and no position sizing — not one
 * sentence on any of them. So these are OURS, and they are deliberately
 * shared across all three strategies: comparing two entry rules is only
 * meaningful if the exit is held constant, otherwise the comparison measures
 * the exits instead.
 */
export interface TicketConfig {
  /** Stop distance as a fraction of the 26-bar range. */
  stopRange: number;
  /** Take profit = this many times the stop distance. */
  rewardMultiple: number;
}

export const TICKET: TicketConfig = { stopRange: 0.4, rewardMultiple: 2 };

/**
 * OANDA: "Tenkan/Kijun trend continuation pullback".
 *
 * Their bullish set-up, quoted:
 *
 *   Price above the Cloud (green coloured).
 *     - Tenkan-sen (Conversion line) is above Kijun-sen (Base line).
 *     - Pullback touches or dips slightly below Tenkan-sen (Conversion line)
 *       or Kijun-sen (Base line).
 *     - Price closes above Kijun-sen (Base line) with a bullish candlestick.
 *
 * Bearish is the mirror: price below the Cloud, Tenkan below Kijun, pullback
 * touches or rebounds slightly above either line, price closes below Kijun
 * with a bearish candlestick.
 *
 * Note what is NOT in it: the cloud's own colour, the forward cloud, and
 * Chikou. All three gate our strategy and none of them gates theirs — in the
 * article Chikou is a separate filter, attached to the breakout.
 *
 * THE TWO-BAR SHAPE THAT MATTERS
 * ──────────────────────────────
 * The pullback and the confirming close are different events on different
 * bars. In the article's USD/JPY example the dip below the base line happens
 * in the morning and the hourly close back above it at 1pm SGT, hours later.
 * So this is a state machine, not a single-bar test: a touch arms the setup,
 * and the first qualifying close fires it.
 */
export interface OandaPullbackConfig {
  /**
   * How long a pullback stays live waiting for its confirming close, in bars.
   *
   * OURS. The article gives no limit, and without one a touch from a hundred
   * bars ago could fire a trade the moment an unrelated bullish candle closed
   * above Kijun. 26 bars is one Kijun period — the same window the line being
   * traded is built from. The setup also expires early whenever its own
   * conditions break (price enters the cloud, or Tenkan crosses back).
   */
  confirmWithinBars: number;
  /** The lookback whose high-low range sizes the stop. Ichimoku's own 26. */
  rangePeriod: number;
}

export const OANDA_PULLBACK: OandaPullbackConfig = {
  confirmWithinBars: 26,
  rangePeriod: 26,
};

/**
 * OANDA: "Kumo (Cloud) breakout".
 *
 * Their bullish set-up, quoted: "Price breaks above the cloud. Cloud is
 * turning bullish (Span A crossing above span B)". Bearish is the mirror.
 *
 * The article describes the strategy as being "utilized for early trend
 * identification after consolidation", and then:
 *
 *   "To increase the probability of this bullish trend change, we can wait
 *    for the Span A to cross above the Span B ... to establish a bullish
 *    set-up."
 *
 * WHY THE TWIST IS ALLOWED TO ARRIVE LATE
 * ───────────────────────────────────────
 * In both of the article's examples the span cross came AFTER the break —
 * AUD/USD broke the cloud at 1am SGT and Span A crossed at 4am; NZD/USD broke
 * down on 18 Nov at 2am and Span A crossed on 19 Nov at 4am, twenty-six hours
 * later. Requiring both on one bar would reject both of the article's own
 * illustrations. So the break arms the setup and the twist completes it, and
 * the signal is dated to whichever came second.
 */
export interface OandaBreakoutConfig {
  /**
   * How long a cloud break stays live waiting for the span twist, in bars.
   *
   * OURS. The article gives no limit; its own worst example is 26 hourly
   * bars, so 52 leaves room without letting a break from a different market
   * regime pair up with a twist weeks later.
   */
  twistWithinBars: number;
  /**
   * Require the Chikou filter.
   *
   * OANDA: "the lagging span is being used as a trend confirmation tool to
   * filter out false breakouts from prior consolidation/sideways ranges.
   * Hence, it can be used in conjunction with the Kumo (Cloud) breakout
   * strategy." Bullish needs Chikou above its prior 26-period price, bearish
   * below it.
   *
   * The article says "can be", so this is a switch rather than a hard rule.
   * It defaults ON because filtering false breakouts out of consolidation is
   * the entire reason the section exists.
   */
  requireChikou: boolean;
  /** The lookback whose high-low range sizes the stop. Ichimoku's own 26. */
  rangePeriod: number;
}

export const OANDA_BREAKOUT: OandaBreakoutConfig = {
  twistWithinBars: 52,
  requireChikou: true,
  rangePeriod: 26,
};

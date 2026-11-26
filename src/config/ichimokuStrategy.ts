/**
 * The strategy. One system, from OANDA's Ichimoku Cloud trading guide.
 *
 * WHY ONE AND NOT THREE
 * ─────────────────────
 * Their article does not present a menu. It says:
 *
 *   "The Ichimoku Cloud supports four core trading approaches: the Kumo
 *    breakout, the Tenkan-Kijun trend-continuation pullback, the Chikou span
 *    confirmation filter, and future support and resistance zones
 *    identification. THESE STRATEGIES WORK TOGETHER to help traders identify
 *    breakouts, trend resumption setups, and signal validation."
 *
 * So they are parts of one system, not rivals:
 *
 *   two entries   a breakout catches a trend CHANGE after consolidation;
 *                 a pullback catches a trend CONTINUATION. One system needs
 *                 both, because a trend has to start before it can resume.
 *   one filter    Chikou, validating either of them.
 *   one geometry  the Kumo and Kijun as support and resistance — which is
 *                 where the stop goes.
 *
 * An earlier version of this file had them as three selectable strategies
 * competing in a backtest. Each rule was faithful and the arrangement was
 * not: it measured the parts against each other instead of running the
 * system the article describes.
 *
 * Nothing here refers to a moving average or an average true range, and
 * nothing in the detector that reads it does either — a test reads every
 * strategy file and fails if one appears.
 */

export interface IchimokuConfig {
  // ── entry A: the Kumo breakout ─────────────────────────────────────────
  /**
   * How long a cloud break stays live waiting for the span twist, in bars.
   *
   * OURS. The article gives no limit, but it does require both:
   *
   *   "Price breaks above the cloud. Cloud is turning bullish (Span A
   *    crossing above span B)"
   *
   * and in both of its worked examples the twist arrived AFTER the break —
   * three hours later on AUD/USD, twenty-six on NZD/USD. Demanding both on
   * one bar would reject the article's own illustrations, so the break arms
   * the setup and the twist completes it. 52 bars leaves room for their worst
   * example without letting a break pair with a twist weeks later.
   */
  twistWithinBars: number;

  // ── entry B: the Tenkan/Kijun pullback ─────────────────────────────────
  /**
   * How long a pullback stays live waiting for its confirming close, in bars.
   *
   * OURS. Their rules are:
   *
   *   "Pullback touches or dips slightly below Tenkan-sen or Kijun-sen."
   *   "Price closes above Kijun-sen with a bullish candlestick."
   *
   * Two events on two bars — their USD/JPY example has the dip in the morning
   * and the confirming 1pm close — with no stated limit between them. 26 bars
   * is one Kijun period, the same window the line being traded is built from.
   * The setup also expires early when its own conditions break.
   */
  confirmWithinBars: number;

  // ── the filter ─────────────────────────────────────────────────────────
  /**
   * Require Chikou on the pullback as well as the breakout.
   *
   * The article attaches the filter explicitly to the breakout — "it can be
   * used in conjunction with the Kumo (Cloud) breakout strategy" — while
   * describing the four approaches as working together. Applying it to both
   * is the "work together" reading, and it is a flag rather than a hard rule
   * so the literal reading can be measured against it.
   */
  chikouFiltersPullback: boolean;

  // ── the exit ───────────────────────────────────────────────────────────
  /**
   * How far beyond the structure the stop sits, as a fraction of the 26-bar
   * range.
   *
   * The LEVEL is the article's; the buffer is ours. A stop exactly on the
   * line gets taken out by the wick that retests it, and the buffer has to
   * scale with the market, so it is expressed in the only Ichimoku-native
   * measure of distance there is — the 26-bar high-low range, which is the
   * Kijun's own width.
   */
  stopBuffer: number;
  /**
   * Take profit = this many times the stop distance.
   *
   * OURS, entirely. The article gives no target anywhere, and no position
   * sizing either. It is the one part of the ticket with nothing behind it.
   */
  rewardMultiple: number;
  /**
   * The lookback whose high-low range sizes the buffer. Ichimoku's own 26 —
   * Kijun-sen is this range's midpoint, so it is not a new indicator.
   */
  rangePeriod: number;
}

export const ICHIMOKU: IchimokuConfig = {
  twistWithinBars: 52,
  confirmWithinBars: 26,
  chikouFiltersPullback: true,
  stopBuffer: 0.1,
  rewardMultiple: 2,
  rangePeriod: 26,
};

/**
 * WHERE THE STOP GOES, AND WHY THE ARTICLE DOES DECIDE IT
 * ──────────────────────────────────────────────────────
 * I said earlier that OANDA specifies no stop. That was too quick. They do
 * not give a stop RULE, but they name the support and resistance twice, and
 * the system has only one place a stop can honestly go — beyond whatever the
 * entry was relying on:
 *
 *   Kijun-sen   "Purpose: Stronger trend confirmation and acts as dynamic
 *                support/resistance."
 *   The Kumo    "...act as a potential future support zone if price is above
 *                the Cloud, and as a potential future resistance zone if
 *                price is below the Cloud."
 *
 * So each entry's stop sits beyond its own structure:
 *
 *   pullback  -> beyond KIJUN. The trade is a bet that the base line holds;
 *                if it does not, the reason for the trade is gone.
 *   breakout  -> beyond the FAR CLOUD EDGE. The trade is a bet that price
 *                has left the zone; a stop inside the cloud would be stopped
 *                out by the zone it just crossed.
 *
 * That makes the stop a consequence of the rule rather than a number bolted
 * on, and it is why the breakout's stop is wider: a thick cloud is the
 * article's own measure of a more significant break, and it needs the room.
 */
export type EntryType = 'breakout' | 'pullback';

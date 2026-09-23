/**
 * The volatility scale every threshold is measured in.
 *
 * WHY A SCALE IS NEEDED AT ALL
 * ────────────────────────────
 * "A swing must stand 15 pips clear" is meaningless as a portable rule: 15
 * pips is nothing on GBP/JPY and a whole session's range on EUR/CHF, and it
 * means different things on 15M and 4H. Every threshold in this engine is
 * therefore expressed as a multiple of what a NORMAL CANDLE looks like on the
 * pair and timeframe being analysed.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ─────────────────────────────────────────────
 * It is the mean high-to-low range of the recent candles. Nothing more.
 *
 * It is NOT ATR: there is no true-range gap handling and no Wilder smoothing,
 * because neither is wanted here. This value is only ever used to answer "is
 * this distance big relative to normal movement?", and for that question a
 * plain mean of the last N ranges is both sufficient and easier to reason
 * about than a recursively smoothed one.
 *
 * It is also NOT used to place stops. Stops come from structure — the swing
 * the setup was built on, the zone it rejected, the pattern's invalidation —
 * exactly as the strategy calls for. An earlier version enforced a minimum
 * stop distance in ATR, which quietly manufactured very tight stops with very
 * distant targets: those trades showed a high reward/risk and were stopped out
 * by ordinary noise far more often than their geometry implied. On a random
 * walk the 3R-and-above bucket returned −0.42R a trade where arithmetic says
 * it must return zero. Removing the volatility floor removes that whole class
 * of trade.
 */
import type { Candle } from '../../marketData/types';

/**
 * Mean candle range over the `lookback` bars ending at `end`.
 *
 * Returns 0 when there is nothing to measure, and every caller treats 0 as
 * "cannot analyse" rather than dividing by it.
 */
export function typicalRange(candles: readonly Candle[], end: number, lookback: number): number {
  const from = Math.max(0, end - lookback + 1);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= end; i++) {
    const c = candles[i];
    if (!c) continue;
    sum += c.high - c.low;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * How directly price travelled — the trend/chop discriminator.
 *
 * Net displacement divided by total path length over the same bars:
 *
 *   |close[end] − close[start]|  ÷  Σ |close[i] − close[i−1]|
 *
 * A market that moved 100 pips in a straight line scores near 1. One that
 * moved 100 pips up and 100 back scores near 0, even though both travelled
 * the same distance and both can print higher highs on the way.
 *
 * WHY THIS IS NEEDED ON TOP OF SWING STRUCTURE
 * ───────────────────────────────────────────
 * Swing analysis answers "are the highs and lows rising?", which a ranging
 * market satisfies constantly — every bounce off the bottom of a range makes
 * a higher low, and a range wide enough will print a higher high too. Measured
 * on deliberately mean-reverting data the engine labelled 118 setups
 * TRENDING_BULLISH and lost 0.41R on every one of them.
 *
 * Efficiency cannot be fooled that way: it is blind to swing shape and only
 * asks whether the travelling got anywhere. It is also pure price — no
 * volatility average, no smoothing constant, nothing to tune per pair.
 */
export function efficiency(candles: readonly Candle[], end: number, lookback: number): number {
  const start = Math.max(0, end - lookback);
  if (end - start < 2) return 0;

  let path = 0;
  for (let i = start + 1; i <= end; i++) {
    path += Math.abs(candles[i]!.close - candles[i - 1]!.close);
  }
  if (path === 0) return 0;

  return Math.abs(candles[end]!.close - candles[start]!.close) / path;
}

/**
 * How often the strategy is run, and on what.
 *
 * The RULES live in config/ichimokuStrategy.ts; this file is scheduling only.
 * The split matters: everything here is about polling providers politely and
 * nothing here can change a trading decision, so tuning one cannot silently
 * alter the other.
 *
 * It used to hold EMA50_TOUCH, TRADE_PLAN and ICHIMOKU_CONFLUENCE — the period
 * of a moving average, an ATR stop multiple, and a threshold for "does
 * Ichimoku agree with the EMA". All three are gone. The strategy is Ichimoku
 * and the levels come out of Ichimoku's own geometry, so there is no second
 * indicator left to configure.
 */
import { ICHIMOKU } from './ichimokuStrategy';
import type { Timeframe } from './timeframes';

export const STRATEGY_CONFIG = {
  /**
   * Timeframe the engine scans.
   *
   * Ichimoku needs 52 + 26 bars before a cloud is in effect and 26 more for
   * the range around Kijun, so 104 bars of warm-up. On a fast chart that is
   * mostly noise and a pullback resolves before anyone could act on it. 30M
   * is the smallest the app serves.
   */
  scanTimeframe: '30M' as Timeframe,
  /**
   * How often the engine re-checks which pairs need new candles.
   *
   * This is NOT how often it fetches. The check is arithmetic — compare each
   * pair's newest bar against the clock — and costs nothing; the fetch only
   * happens for pairs whose bar has actually closed. See `candlesAreDue`.
   */
  scanTickMs: 30_000,
  /**
   * Grace period after a bar's close before asking for it. Providers publish
   * a closed bar with some delay, and asking too early just returns the same
   * data and burns the request.
   */
  barCloseLagMs: 60_000,
  /**
   * Floor on how often one pair may be refetched, whatever else is true.
   *
   * This is the backoff for a provider that is LATE: if its newest bar has not
   * advanced, the bar stays past its close forever, so the bar-boundary rule
   * would say "due" on every single tick. The floor turns that into a retry
   * every two minutes instead of every thirty seconds, and it clears itself
   * the moment the provider catches up.
   */
  minRefetchMs: 120_000,
  /** Newest-first cap on the in-memory signal log. */
  maxSignals: 200,
  /** A live (intrabar) signal stays "active" this long without a new tick. */
  liveSignalTtlMs: 15 * 60_000,
  /** The rules. One object, so nothing can read half of them. */
  ichimoku: ICHIMOKU,
} as const;

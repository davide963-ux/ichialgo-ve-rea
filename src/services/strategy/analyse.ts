/**
 * ════════════════════════════════════════════════════════════════════════════
 *  THE SEAM. This is where the strategy goes.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Right now there is no strategy. This file returns NO_TRADE for every pair,
 * on purpose, and it is the ONLY place that has to change to put one back.
 *
 * WHAT IS ALREADY BUILT AND WAITING
 * ─────────────────────────────────
 *   candles ──▶ analyse() ──▶ StrategyAnalysis ──┬──▶ SetupTracker  (is it news?)
 *                  ▲                             ├──▶ scanner       (record it)
 *                  │                             ├──▶ backtest      (replay it)
 *                  └── you write this            └──▶ UI            (show it)
 *
 * Everything to the right of `analyse()` is finished and tested: the lifecycle
 * tracker, the 24/7 scanner, the Supabase schema, the R-multiple performance
 * maths, and the backtest harness that replays candles through this exact
 * function so a backtested trade and a live signal cannot diverge.
 *
 * Everything to the left is finished too: Ichimoku, EMA, ATR and market
 * structure are in `src/lib/indicators/`, tested, with no strategy opinion
 * baked into them.
 *
 * HOW TO PLUG ONE IN
 * ──────────────────
 * Replace the body below. The rules:
 *
 *   1. Return a `StrategyAnalysis` on every path, including refusals — a
 *      refusal carrying a `reason` is far more useful than a thrown error,
 *      because the dry-run endpoint prints it.
 *   2. Never report CONFIRMED when `barClosed` is false. The rejection you
 *      think you see can still be erased before the candle closes.
 *   3. Put anything strategy-specific in `detail`. It is stored verbatim as
 *      the `analysis` JSON column and nothing outside here reads it, so it
 *      costs nothing and makes every decision auditable afterwards.
 *   4. Set `anchor` to whatever identifies THIS setup — usually the price the
 *      move started from. The tracker uses it to tell a genuinely new
 *      opportunity from the same one still developing.
 *
 * WHY IT REFUSES RATHER THAN THROWS
 * ─────────────────────────────────
 * The scanner runs unattended every fifteen minutes. A throw here would be an
 * error in a log nobody reads; a NO_TRADE with a stated reason shows up in the
 * dry-run output and on the dashboard, which is where someone will actually
 * see it.
 */
import type { Candle } from '../marketData/types';
import type { AnalyseOptions, StrategyAnalysis } from './contract';

/** Bars of history to fetch. Raise this to whatever the new rules need. */
export const MIN_BARS = 120;

/** Shown wherever a signal would be. Says what is true rather than pretending. */
export const NO_STRATEGY_REASON = 'No strategy is configured yet.';

export function analyse(candles: readonly Candle[], options: AnalyseOptions): StrategyAnalysis {
  const i = options.index ?? candles.length - 1;
  const last = candles[i];

  return {
    symbol: options.symbol,
    timeframe: options.timeframe,
    barTime: last?.time ?? 0,
    barClosed: options.lastBarClosed ?? true,

    direction: 'none',
    signal: 'NO_TRADE',
    confidence: 0,
    marketCondition: 'NO_STRATEGY',
    status: 'FORMING',

    price: last?.close ?? 0,
    risk: { entry: null, stop: null, targets: [], stopPips: null, invalidation: null },
    anchor: null,

    reasons: [],
    warnings: [NO_STRATEGY_REASON],
    detail: { bars: candles.length },
  };
}

/** True once there is enough history for `analyse` to say anything. */
export const hasEnoughBars = (candles: readonly Candle[]): boolean => candles.length >= MIN_BARS;

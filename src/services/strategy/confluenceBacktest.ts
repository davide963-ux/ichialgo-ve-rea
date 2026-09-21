/**
 * Backtest for the Ichimoku + EMA50 confluence strategy.
 *
 * It calls the SAME `analyseConfluence` the live scanner calls, bar by bar,
 * and feeds the results through the SAME `SetupTracker`. A backtested trade
 * and a live signal therefore come from one implementation; there is no
 * "backtest version" of the strategy that could quietly diverge from the one
 * actually trading.
 *
 *   for each bar i:
 *     analyseConfluence(candles, { index: i })   ← sees bars 0..i and no more
 *            │
 *            ├─ tracker.update()  ← same anti-duplication as live
 *            │
 *            └─ emit + actionable ─▶ open a trade at the zone level
 *                                     └─ walk bars i+1.. for the exit
 *
 * NO LOOKAHEAD, AND WHY IT IS BELIEVABLE
 * ──────────────────────────────────────
 * `analyseConfluence` slices the candles at `index` and every indicator it
 * uses is causal: EMA, ATR, Tenkan/Kijun, the DISPLACED Senkou spans (drawn
 * from bars 26 back), and structure pivots which are only confirmed once their
 * right wing exists. The engine's own test tampers with every bar after the
 * analysed one and asserts the answer does not change.
 *
 * THE ENTRY BAR IS NOT AN EXIT BAR
 * ────────────────────────────────
 * Exits are searched from the bar AFTER entry. The confirming bar's range
 * mostly happened before price rejected the zone — its high sits where the
 * pullback began — so counting it would book a target the trade never had a
 * chance to reach.
 *
 * SAME-BAR AMBIGUITY: THE STOP WINS
 * ─────────────────────────────────
 * When one bar's range covers both the stop and a target, OHLC cannot say
 * which came first, so the stop is taken. Every such choice makes the result
 * worse than reality might have been, which is the only safe direction for a
 * number you are going to risk money on.
 *
 * WHERE THIS AND THE LIVE SCANNER DIVERGE
 * ───────────────────────────────────────
 * The backtest sees each bar's HIGH and LOW, so it catches a spike through the
 * stop. The live scanner polls the current price every ~15 minutes and cannot,
 * so live results are OPTIMISTIC relative to this by however much the market
 * whipsaws. The backtest is the conservative of the two — which is the right
 * way round, but it means a live win rate above the backtested one is a reason
 * to check the plumbing, not to celebrate.
 */
import { CONFLUENCE_STRATEGY, type ConfluenceStrategyConfig } from '../../config/confluence';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData/types';
import { analyseConfluence } from './confluence/analyse';
import { isActionable } from './confluence/scoring';
import { SetupTracker } from './confluence/setupTracker';
import type { ConfluenceAnalysis } from './confluence/types';
import { buildReport, type MeasuredTrade, type PerformanceReport } from './performance';

export type BacktestExit = 'tp1' | 'tp2' | 'tp3' | 'sl' | 'be' | 'open';

export interface ConfluenceTrade {
  id: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  signal: string;
  confidence: number;
  marketCondition: string;
  /** Bar the setup confirmed on (UNIX seconds). */
  entryTime: number;
  entryIndex: number;
  entry: number;
  /**
   * The stop as it stands now — moved to entry once TP1 is hit.
   */
  stop: number;
  /**
   * The stop the trade was SIZED against, never moved.
   *
   * R must be measured against the risk actually taken. Once a breakeven move
   * overwrites `stop` with `entry`, the original distance is gone and the
   * division has a zero denominator, which silently turns every runner into an
   * unscored trade.
   */
  initialStop: number;
  targets: number[];
  exitTime: number | null;
  exitPrice: number | null;
  exit: BacktestExit;
  barsHeld: number;
  /** True once a target moved the stop to entry. */
  tp1Hit: boolean;
  /** Result in multiples of the risk taken. Null while open. */
  rMultiple: number | null;
  stopPips: number;
  reasons: string[];
  warnings: string[];
}

export interface ConfluenceBacktestOptions {
  symbol: string;
  timeframe: string;
  config?: ConfluenceStrategyConfig;
  /** Bars a trade may stay open before it is abandoned as 'open'. */
  maxBarsHeld?: number;
  /** Only analyse bars at or after this time (UNIX seconds). */
  from?: number;
  to?: number;
}

export interface ConfluenceBacktestResult {
  symbol: string;
  timeframe: string;
  trades: ConfluenceTrade[];
  report: PerformanceReport;
  /** Bars actually analysed — the warm-up is excluded. */
  barsAnalysed: number;
  /** Setups that confirmed but were suppressed by an open position. */
  skippedWhileInTrade: number;
  /** Why nothing was produced, when that is the case. */
  note: string | null;
}

const DEFAULT_MAX_BARS_HELD = 240;

/**
 * Resolve an open trade against one bar.
 *
 * Returns the exit, or null when the bar leaves the trade open. TP1 does not
 * exit: it reports `breakeven`, and the caller moves the stop to entry so the
 * worst remaining case is zero.
 */
export function resolveBar(
  bar: Candle,
  direction: 'long' | 'short',
  stop: number,
  targets: readonly number[],
  tp1Hit: boolean,
): { exit: BacktestExit | null; price: number; breakeven: boolean } {
  const long = direction === 'long';
  const hitStop = long ? bar.low <= stop : bar.high >= stop;

  // Pessimistic: a bar covering both is read as the stop, because OHLC cannot
  // order the two and the alternative invents wins.
  if (hitStop) return { exit: tp1Hit ? 'be' : 'sl', price: stop, breakeven: false };

  const reached = (t: number | undefined) => t !== undefined && (long ? bar.high >= t : bar.low <= t);

  if (reached(targets[2])) return { exit: 'tp3', price: targets[2]!, breakeven: false };
  if (reached(targets[1])) return { exit: 'tp2', price: targets[1]!, breakeven: false };
  if (!tp1Hit && reached(targets[0])) return { exit: null, price: targets[0]!, breakeven: true };

  return { exit: null, price: bar.close, breakeven: false };
}

/** R from the levels actually recorded — the same arithmetic close_signal uses. */
export function rMultipleOf(direction: 'long' | 'short', entry: number, stop: number, exitPrice: number): number | null {
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  return (direction === 'long' ? exitPrice - entry : entry - exitPrice) / risk;
}

export function runConfluenceBacktest(
  candles: readonly Candle[],
  options: ConfluenceBacktestOptions,
): ConfluenceBacktestResult {
  const config = options.config ?? CONFLUENCE_STRATEGY;
  const { symbol, timeframe } = options;
  const maxBarsHeld = options.maxBarsHeld ?? DEFAULT_MAX_BARS_HELD;
  const pip = pipSize(symbol);

  const empty = (note: string): ConfluenceBacktestResult => ({
    symbol,
    timeframe,
    trades: [],
    report: buildReport([]),
    barsAnalysed: 0,
    skippedWhileInTrade: 0,
    note,
  });

  if (candles.length < config.minBars + 2) {
    return empty(`Needs at least ${config.minBars + 2} candles, has ${candles.length}.`);
  }

  // A synthetic clock so the tracker's staleness eviction is driven by BAR
  // time rather than by how long the test took to run. Wall-clock time has no
  // meaning inside a backtest.
  let clock = (candles[0]?.time ?? 0) * 1000;
  const tracker = new SetupTracker({ now: () => clock });

  const trades: ConfluenceTrade[] = [];
  let open: ConfluenceTrade | null = null;
  let barsAnalysed = 0;
  let skippedWhileInTrade = 0;

  const start = config.minBars - 1;

  for (let i = start; i < candles.length; i++) {
    const bar = candles[i]!;
    clock = bar.time * 1000;

    if (options.from !== undefined && bar.time < options.from) continue;
    if (options.to !== undefined && bar.time > options.to) break;

    // ── Manage an open position first, on THIS bar ──────────────────────
    // Ordering matters: a trade must be given the chance to exit on a bar
    // before that same bar is allowed to open a new one, or a stop-out and an
    // entry could both be booked from one candle.
    if (open !== null) {
      const held = i - open.entryIndex;
      if (held >= 1) {
        const { exit, price, breakeven } = resolveBar(bar, open.direction, open.stop, open.targets, open.tp1Hit);
        if (breakeven) {
          open.tp1Hit = true;
          open.stop = open.entry;
        } else if (exit !== null) {
          open.exit = exit;
          open.exitPrice = price;
          open.exitTime = bar.time;
          open.barsHeld = held;
          // Always against the ORIGINAL stop: that is the risk that was taken.
          open.rMultiple = rMultipleOf(open.direction, open.entry, open.initialStop, price);
          // A breakeven stop is exactly zero, whatever floating point says.
          if (exit === 'be') open.rMultiple = 0;
          tracker.complete(symbol, timeframe);
          open = null;
        } else if (held >= maxBarsHeld) {
          // Abandoned rather than scored: it never resolved, so it is not a
          // measured result and must not count toward any statistic.
          open.exit = 'open';
          open.barsHeld = held;
          open.rMultiple = null;
          tracker.complete(symbol, timeframe);
          open = null;
        }
      }
    }

    // ── Look for a setup ────────────────────────────────────────────────
    barsAnalysed++;
    const analysis = analyseConfluence(candles, {
      symbol,
      timeframe,
      index: i,
      // Every bar in history is closed. The forming-bar guard exists for live
      // data; here it would suppress every signal.
      lastBarClosed: true,
      config,
    });

    const decision = tracker.update(analysis);
    if (!decision.emit || !isActionable(analysis.signal)) continue;

    if (open !== null) {
      skippedWhileInTrade++;
      continue;
    }

    const trade = toTrade(analysis, i, pip);
    if (trade === null) continue;

    trades.push(trade);
    open = trade;
    tracker.activate(symbol, timeframe);
  }

  // Anything still running at the end of the data is open, not a result.
  if (open !== null) {
    open.exit = 'open';
    open.barsHeld = candles.length - 1 - open.entryIndex;
    open.rMultiple = null;
  }

  const measured: MeasuredTrade[] = trades.map((t) => ({
    direction: t.direction,
    timeframe: t.timeframe,
    marketCondition: t.marketCondition,
    signal: t.signal,
    outcome: t.exit === 'open' ? 'pending' : t.exit,
    rMultiple: t.rMultiple,
    confidence: t.confidence,
    symbol: t.symbol,
  }));

  return {
    symbol,
    timeframe,
    trades,
    report: buildReport(measured),
    barsAnalysed,
    skippedWhileInTrade,
    note: trades.length === 0 ? 'No setup confirmed over this range. The strategy is meant to be selective.' : null,
  };
}

function toTrade(analysis: ConfluenceAnalysis, index: number, pip: number): ConfluenceTrade | null {
  const { entry, targets, stopPips } = analysis.risk;
  if (entry === null || stopPips === null || targets.length === 0) return null;
  if (analysis.direction === 'none') return null;

  const distance = stopPips * pip;
  const stop = analysis.direction === 'long' ? entry - distance : entry + distance;

  return {
    id: `${analysis.symbol}|${analysis.timeframe}|${analysis.barTime}`,
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    direction: analysis.direction,
    signal: analysis.signal,
    confidence: analysis.confidence,
    marketCondition: analysis.marketCondition,
    entryTime: analysis.barTime,
    entryIndex: index,
    entry,
    stop,
    initialStop: stop,
    targets: [...targets],
    exitTime: null,
    exitPrice: null,
    exit: 'open',
    barsHeld: 0,
    tp1Hit: false,
    rMultiple: null,
    stopPips,
    reasons: analysis.reasons,
    warnings: analysis.warnings,
  };
}

/**
 * Backtest harness — plumbing, not strategy.
 *
 * It replays candles through the SAME `analyse()` the live scanner calls, bar
 * by bar, and feeds the results through the SAME `SetupTracker`. A backtested
 * trade and a live signal therefore come from one implementation; there is no
 * "backtest version" of the rules that could quietly diverge from the ones
 * actually trading.
 *
 *   for each bar i:
 *     analyse(candles, { index: i })     ← sees bars 0..i and no more
 *            │
 *            ├─ tracker.update()          ← same anti-duplication as live
 *            │
 *            └─ emit + actionable ─▶ open a trade at the ticket's entry
 *                                     └─ walk bars i+1.. for the exit
 *
 * NO LOOKAHEAD
 * ────────────
 * `analyse` is passed an index and must read nothing beyond it. That is a
 * contract the strategy has to honour; a strategy whose answer changes when
 * later bars are edited has a lookahead bug, and is worth testing for
 * explicitly.
 *
 * THE ENTRY BAR IS NOT AN EXIT BAR
 * ────────────────────────────────
 * Exits are searched from the bar AFTER entry. The confirming bar's range
 * mostly happened before the entry condition was met — its extremes sit where
 * the move began — so counting it would book a target the trade never had a
 * chance to reach.
 *
 * SAME-BAR AMBIGUITY: THE STOP WINS
 * ─────────────────────────────────
 * When one bar's range covers both the stop and a target, OHLC cannot say
 * which came first, so the stop is taken. Every such choice makes the result
 * worse than reality might have been, which is the only safe direction for a
 * number someone is going to risk money on.
 *
 * WHERE THIS AND THE LIVE SCANNER DIVERGE
 * ───────────────────────────────────────
 * The backtest sees each bar's HIGH and LOW, so it catches a spike through the
 * stop. The live scanner polls the current price every ~15 minutes and cannot,
 * so live results are OPTIMISTIC relative to this by however much the market
 * whipsaws. The backtest is the conservative of the two — which is the right
 * way round, but it means a live win rate ABOVE the backtested one is a reason
 * to check the plumbing, not to celebrate.
 */
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData/types';
import { analyse, MIN_BARS } from './analyse';
import { isActionable } from './contract';
import { SetupTracker } from './lifecycle';
import type { StrategyAnalysis } from './contract';
import { buildReport, type MeasuredTrade, type PerformanceReport } from './performance';

export type BacktestExit = 'tp1' | 'tp2' | 'tp3' | 'sl' | 'be' | 'open';

export interface BacktestTrade {
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
  /** The stop as it stands now — moved to entry once TP1 is hit. */
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

export interface BacktestOptions {
  symbol: string;
  timeframe: string;
  /** Bars a trade may stay open before it is abandoned as 'open'. */
  maxBarsHeld?: number;
  /** Only analyse bars at or after this time (UNIX seconds). */
  from?: number;
  to?: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  trades: BacktestTrade[];
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

/** R from the levels actually recorded — the same arithmetic `close_signal` uses. */
export function rMultipleOf(direction: 'long' | 'short', entry: number, stop: number, exitPrice: number): number | null {
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  return (direction === 'long' ? exitPrice - entry : entry - exitPrice) / risk;
}

export function runBacktest(candles: readonly Candle[], options: BacktestOptions): BacktestResult {
  const { symbol, timeframe } = options;
  const maxBarsHeld = options.maxBarsHeld ?? DEFAULT_MAX_BARS_HELD;
  const pip = pipSize(symbol);

  const empty = (note: string): BacktestResult => ({
    symbol,
    timeframe,
    trades: [],
    report: buildReport([]),
    barsAnalysed: 0,
    skippedWhileInTrade: 0,
    note,
  });

  if (candles.length < MIN_BARS + 2) {
    return empty(`Needs at least ${MIN_BARS + 2} candles, has ${candles.length}.`);
  }

  // A synthetic clock so the tracker's staleness eviction is driven by BAR
  // time rather than by how long the run took. Wall-clock time has no meaning
  // inside a backtest.
  let clock = (candles[0]?.time ?? 0) * 1000;
  const tracker = new SetupTracker({ now: () => clock });

  const trades: BacktestTrade[] = [];
  let open: BacktestTrade | null = null;
  let barsAnalysed = 0;
  let skippedWhileInTrade = 0;

  for (let i = MIN_BARS - 1; i < candles.length; i++) {
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
    const analysis = analyse(candles, {
      symbol,
      timeframe,
      index: i,
      // Every bar in history is closed. The forming-bar guard exists for live
      // data; here it would suppress every signal.
      lastBarClosed: true,
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
    note: trades.length === 0 ? 'No setup confirmed over this range.' : null,
  };
}

/**
 * Turn a confirmed analysis into a trade ticket.
 *
 * Returns null rather than guessing when the ticket is incomplete: a strategy
 * that says LONG without an entry, a stop and at least one target has not
 * produced something tradeable, and inventing the missing level here would put
 * a number in the results that no rule ever chose.
 */
function toTrade(analysis: StrategyAnalysis, index: number, pip: number): BacktestTrade | null {
  const { entry, stop, targets } = analysis.risk;
  if (entry === null || stop === null || targets.length === 0) return null;
  if (analysis.direction === 'none') return null;
  if (Math.abs(entry - stop) === 0) return null;

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
    stopPips: analysis.risk.stopPips ?? Math.abs(entry - stop) / pip,
    reasons: analysis.reasons,
    warnings: analysis.warnings,
  };
}

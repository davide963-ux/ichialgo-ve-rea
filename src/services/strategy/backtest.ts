/**
 * Backtest harness for the EMA50 touch strategy — plumbing, not strategy.
 *
 * It replays candles through the SAME `analyseEma50Touch` the live engine
 * calls and the SAME `ticketLevels` the trade-plan card shows, so a
 * backtested trade and a live signal come from one implementation. There is
 * no "backtest version" of the rules that could quietly diverge from the ones
 * actually being traded.
 *
 *   touch at bar i ──▶ ticketLevels() ──▶ open at the EMA
 *                                          │
 *                        bars i+1, i+2, … ─┴─▶ stop hit?  ──▶ −1R
 *                                             target hit? ──▶ +2R
 *                                             neither     ──▶ keep holding
 *
 * THE DECISIONS THAT DECIDE THE NUMBER
 * ────────────────────────────────────
 * Every one of these is taken in the pessimistic direction. A backtest is a
 * number somebody may risk money on, and the only safe way to be wrong about
 * it is downwards.
 *
 *  1. THE ENTRY MUST BE A PRICE THAT TRADED. Entry is a resting limit at the
 *     EMA, so it fills only if the bar actually reached the EMA — `low <=
 *     entry` for a long, `high >= entry` for a short. A touch is the bar's
 *     range entering the BAND, which is wider than the line, so a bar can
 *     touch without ever trading at the EMA; and a bar that gapped clean past
 *     the level never printed that price either. Both are no-fills, not
 *     trades, so the rule is simply `low <= entry <= high`.
 *
 *     This is not a detail. Filling them anyway was worth +0.23R a trade
 *     across 1105 trades, and it was fiction: on GBP/JPY the fillable trades
 *     totalled −9R while the unfillable ones "made" +34R, with entries up to
 *     4.8 pips better than the bar's own extreme. A backtest that buys below
 *     the low prints an edge out of nothing.
 *
 *  2. THE ENTRY BAR CAN STOP YOU OUT. The fill happens at the EMA *inside*
 *     the touch bar, so the rest of that bar is live: if its range also
 *     covers the stop, the trade is stopped on the bar it opened. Skipping
 *     that was worth another +0.04R a trade and hid a third of the drawdown.
 *
 *     The entry bar can only LOSE here, never win: OHLC cannot say whether
 *     the high came before or after the fill, so the target is not credited
 *     until the next bar.
 *
 *  3. SAME-BAR AMBIGUITY: THE STOP WINS. When one bar's range covers both the
 *     stop and the target, OHLC cannot say which came first, so the stop is
 *     taken. The alternative invents wins.
 *
 *  4. ONE POSITION AT A TIME, and a bar is given the chance to CLOSE a trade
 *     before it is allowed to open one. Otherwise a stop-out and an entry
 *     could both be booked from a single candle.
 *
 *  5. A TRADE STILL OPEN at the end of the data is not counted. It has no
 *     result yet, and assuming one either way is how a losing run gets hidden.
 *
 * WHERE THIS AND THE LIVE ENGINE DIVERGE
 * ──────────────────────────────────────
 * The backtest sees each bar's HIGH and LOW, so it catches a spike through
 * the stop. The live engine watches the quote stream and polls, so it can
 * miss one. Live results are therefore OPTIMISTIC relative to this, which
 * means a live win rate ABOVE the backtested one is a reason to check the
 * plumbing rather than to celebrate.
 */
import type { Timeframe } from '../../config/timeframes';
import type { Candle } from '../marketData/types';
import { pipSize } from '../../lib/pips';
import { analyseEma50Touch } from './ema50Touch';
import { ticketLevels } from './tradePlan';
import type { TouchOutcome, TouchSignal } from './types';

export type BacktestExit = 'tp' | 'sl' | 'open';

export interface BacktestTrade {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 'LONG' | 'SHORT';
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  exit: BacktestExit;
  /** Null while the trade never closed. */
  exitTime: number | null;
  exitPrice: number | null;
  barsHeld: number;
  /** Result in multiples of risk. Null for a trade still open at the end. */
  rMultiple: number | null;
  // ── context, so results can be sliced without re-running ──
  ichimokuScore: number | null;
  counterTrend: boolean;
  touchOutcome: TouchOutcome;
}

export interface BacktestFilters {
  /**
   * Round-trip cost in pips — spread, and commission if any.
   *
   * It is charged against the RISK, not the price, which is what makes it
   * comparable across pairs: `cost / |entry − stop|`. That matters more here
   * than it looks. The stop is roughly 10 pips, so a 1-pip spread is 0.10R
   * off every single trade — enough on its own to turn a small edge into
   * nothing, and it is the commonest reason a backtest does not survive
   * contact with a broker.
   */
  costPips?: number;
  /** Skip a touch whose Ichimoku score is below this (0 = take everything). */
  minIchimoku?: number;
  /** Skip touches against the EMA's own trend. */
  skipCounterTrend?: boolean;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Mean R across closed trades — the headline number. */
  averageR: number | null;
  totalR: number;
  /** Gross R won ÷ gross R lost. Above 1 is profitable. */
  profitFactor: number | null;
  /** Deepest peak-to-trough fall of the cumulative R curve. */
  maxDrawdownR: number;
  /**
   * Standard error of the mean R, and the 95% interval around it.
   *
   * These are here because the headline number alone has misled this project
   * before. An average of −0.1R over 170 trades and an average of −0.1R over
   * 5000 are different claims, and only the interval says which one you have.
   */
  standardError: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** True when the 95% interval excludes zero — i.e. the sign is meaningful. */
  significant: boolean;
  /** Win rate this payoff needs just to break even. */
  breakEvenWinRatePct: number;
  /** Trades that were still open when the data ran out. */
  stillOpen: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  /** Touches the detector found, before filters. */
  touches: number;
  /** Touches skipped by the filters. */
  filtered: number;
  /**
   * Touches whose limit at the EMA was never reached by the touch bar.
   * Reported rather than swallowed: it is a big number, and a reader who
   * does not know it would think the strategy trades far more often.
   */
  noFill: number;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  /** Cumulative R after each closed trade, for the equity curve. */
  equity: { time: number; r: number }[];
}

/** Does this bar close the position, and at what price? Stop checked first. */
function resolveBar(
  bar: Candle,
  direction: 'LONG' | 'SHORT',
  stop: number,
  target: number,
): { exit: 'tp' | 'sl' | null; price: number } {
  const long = direction === 'LONG';
  // Pessimistic: a bar covering both is read as the stop, because OHLC cannot
  // order the two.
  if (long ? bar.low <= stop : bar.high >= stop) return { exit: 'sl', price: stop };
  if (long ? bar.high >= target : bar.low <= target) return { exit: 'tp', price: target };
  return { exit: null, price: bar.close };
}

/** R from the levels actually recorded, less the cost of doing the trade. */
export function rMultipleOf(
  direction: 'LONG' | 'SHORT',
  entry: number,
  stop: number,
  exitPrice: number,
  costPrice = 0,
): number | null {
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk === 0) return null;
  const move = direction === 'LONG' ? exitPrice - entry : entry - exitPrice;
  return (move - costPrice) / risk;
}

const passesFilters = (s: TouchSignal, f: BacktestFilters): boolean => {
  if (f.skipCounterTrend && s.counterTrend) return false;
  const min = f.minIchimoku ?? 0;
  if (min > 0 && (s.ichimoku?.score ?? 0) < min) return false;
  return true;
};

export function backtestTouches(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  filters: BacktestFilters = {},
): BacktestResult {
  const analysis = analyseEma50Touch(candles, symbol, timeframe);
  const cost = (filters.costPips ?? 0) * pipSize(symbol);

  // Touch bar index, so the walk-forward can start from the next bar. The
  // detector reports bar TIMES; this maps them back without assuming the
  // signals and the candles share an index.
  const indexOfTime = new Map<number, number>();
  candles.forEach((c, i) => indexOfTime.set(c.time, i));

  const eligible = analysis.signals.filter((s) => passesFilters(s, filters));
  const trades: BacktestTrade[] = [];
  let noFill = 0;

  let open: (BacktestTrade & { entryIndex: number }) | null = null;
  let next = 0; // index into `eligible`

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;

    // ── Manage an open position FIRST, on this bar ───────────────────────
    // A bar must be allowed to close a trade before it is allowed to open
    // one, or a stop-out and an entry get booked from one candle.
    if (open !== null && i > open.entryIndex) {
      const { exit, price } = resolveBar(bar, open.direction, open.stop, open.target);
      if (exit !== null) {
        open.exit = exit;
        open.exitTime = bar.time;
        open.exitPrice = price;
        open.barsHeld = i - open.entryIndex;
        open.rMultiple = rMultipleOf(open.direction, open.entry, open.stop, price, cost);
        trades.push(open);
        open = null;
      }
    }

    // ── Then let it open a new one ───────────────────────────────────────
    while (next < eligible.length && (indexOfTime.get(eligible[next]!.barTime) ?? -1) < i) next++;
    if (open === null && next < eligible.length) {
      const signal = eligible[next]!;
      if (indexOfTime.get(signal.barTime) === i) {
        const levels = ticketLevels(signal);
        next++;
        // A resting limit at the EMA fills only if the bar TRADED there. The
        // touch band is wider than the line, so many touches never reach it;
        // and a bar that gapped clean past the level never printed that price
        // either, whichever side it came from. Both are no-fills.
        const filled = levels !== null && bar.low <= levels.entry && levels.entry <= bar.high;
        if (!filled) noFill++;
        if (levels && filled) {
          open = {
            id: signal.id,
            symbol,
            timeframe,
            direction: levels.direction,
            entryTime: bar.time,
            entryIndex: i,
            entry: levels.entry,
            stop: levels.stop,
            target: levels.target,
            exit: 'open',
            exitTime: null,
            exitPrice: null,
            barsHeld: 0,
            rMultiple: null,
            ichimokuScore: signal.ichimoku?.score ?? null,
            counterTrend: signal.counterTrend,
            touchOutcome: signal.outcome,
          };

          // The rest of the entry bar is live — see rule 2. Stop only.
          const onEntryBar = resolveBar(bar, open.direction, open.stop, open.target);
          if (onEntryBar.exit === 'sl') {
            open.exit = 'sl';
            open.exitTime = bar.time;
            open.exitPrice = onEntryBar.price;
            open.barsHeld = 0;
            open.rMultiple = rMultipleOf(open.direction, open.entry, open.stop, onEntryBar.price, cost);
            trades.push(open);
            open = null;
          }
        }
      }
    }
  }

  // A trade still open when the data ends is recorded but never counted.
  if (open !== null) {
    open.barsHeld = candles.length - 1 - open.entryIndex;
    trades.push(open);
  }

  return {
    symbol,
    timeframe,
    bars: candles.length,
    touches: analysis.signals.length,
    filtered: analysis.signals.length - eligible.length,
    noFill,
    trades,
    metrics: measure(trades),
    equity: equityCurve(trades),
  };
}

/** Cumulative R after each CLOSED trade, oldest first. */
export function equityCurve(trades: readonly BacktestTrade[]): { time: number; r: number }[] {
  const out: { time: number; r: number }[] = [];
  let cum = 0;
  for (const t of trades) {
    if (t.rMultiple === null || t.exitTime === null) continue;
    cum += t.rMultiple;
    out.push({ time: t.exitTime, r: cum });
  }
  return out;
}

export function measure(trades: readonly BacktestTrade[]): BacktestMetrics {
  const closed = trades.filter((t) => t.rMultiple !== null);
  const rs = closed.map((t) => t.rMultiple!);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const n = rs.length;

  const totalR = rs.reduce((a, b) => a + b, 0);
  const averageR = n > 0 ? totalR / n : null;

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Sample standard deviation, then the standard error of the mean. With
  // fewer than two trades neither exists, and pretending otherwise would put
  // a confidence interval on a single coin flip.
  let standardError: number | null = null;
  if (n > 1 && averageR !== null) {
    const variance = rs.reduce((acc, r) => acc + (r - averageR) ** 2, 0) / (n - 1);
    standardError = Math.sqrt(variance / n);
  }
  const ciLow = averageR !== null && standardError !== null ? averageR - 1.96 * standardError : null;
  const ciHigh = averageR !== null && standardError !== null ? averageR + 1.96 * standardError : null;

  // Break-even win rate for the payoff actually observed. With no losses
  // there is nothing to break even against.
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const breakEvenWinRatePct = avgWin + avgLoss > 0 ? (avgLoss / (avgWin + avgLoss)) * 100 : 0;

  let peak = 0;
  let cum = 0;
  let maxDrawdownR = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cum);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n > 0 ? (wins.length / n) * 100 : null,
    averageR,
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    maxDrawdownR,
    standardError,
    ciLow,
    ciHigh,
    significant: ciLow !== null && ciHigh !== null && (ciLow > 0 || ciHigh < 0),
    breakEvenWinRatePct,
    stillOpen: trades.length - n,
  };
}

/** Merge per-pair runs into one portfolio view, trades ordered by exit. */
export function combine(results: readonly BacktestResult[]): { trades: BacktestTrade[]; metrics: BacktestMetrics; equity: { time: number; r: number }[] } {
  const trades = results
    .flatMap((r) => r.trades)
    .sort((a, b) => (a.exitTime ?? a.entryTime) - (b.exitTime ?? b.entryTime));
  return { trades, metrics: measure(trades), equity: equityCurve(trades) };
}

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
 *                        bars i+1, i+2, … ─┴─▶ stop hit?  ──▶ −stopPips
 *                                             target hit? ──▶ +2 × stopPips
 *                                             neither     ──▶ keep holding
 *
 * EVERYTHING IS MEASURED IN PIPS
 * ─────────────────────────────
 * A pip is the unit the levels are actually quoted in, so a pip result can be
 * checked against the chart by hand: entry 1.0850, stop 1.0840, stopped out
 * ⇒ −10 pips, and nothing has been divided by anything.
 *
 * The cost of that choice is worth stating, because the page states it too.
 * The stop is ATR-based, so each trade risks a DIFFERENT number of pips — a
 * quiet EUR/USD touch might risk 8, a volatile one 22. Averaging their pip
 * results therefore averages outcomes of unequal bets. And a JPY pip is a
 * different amount of money from a EUR/USD pip, and typically travels further,
 * so a total that adds the two mixes units outright.
 *
 * `stopPips` is recorded on every trade for exactly that reason: it is the
 * size of the bet, and the pip result means little without it.
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
  /**
   * Net result in pips, after cost. Null for a trade still open at the end.
   * Signed: positive is a gain in the trade's own direction.
   */
  pips: number | null;
  /** |entry − stop| in pips: the risk taken. The pip result's denominator. */
  stopPips: number;
  // ── context, so results can be sliced without re-running ──
  ichimokuScore: number | null;
  counterTrend: boolean;
  touchOutcome: TouchOutcome;
}

export interface BacktestFilters {
  /**
   * Round-trip cost in pips — spread, and commission if any.
   *
   * Charged against the price, so it comes straight off the pip result: a
   * 1-pip spread turns a +20-pip winner into +19 and a −10-pip loser into
   * −11. On a ~10-pip stop that is a tenth of the bet given away on every
   * single trade, which is the commonest reason a backtest does not survive
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
  /** Mean pips across closed trades — the headline number. */
  averagePips: number | null;
  totalPips: number;
  /** Gross pips won ÷ gross pips lost. Above 1 is profitable. */
  profitFactor: number | null;
  /** Deepest peak-to-trough fall of the cumulative pip curve, in pips. */
  maxDrawdownPips: number;
  /**
   * Mean stop distance in pips — the average size of the bet.
   *
   * Reported next to `averagePips` because the headline is meaningless without
   * it. "+2 pips a trade" is a good result against an 8-pip stop and a poor
   * one against a 40-pip stop, and nothing else on the page says which.
   */
  averageStopPips: number | null;
  /**
   * Standard error of the mean, and the 95% interval around it, in pips.
   *
   * These are here because the headline number alone has misled this project
   * before. An average of −1 pip over 170 trades and an average of −1 pip over
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
  /** Cumulative pips after each closed trade, for the equity curve. */
  equity: { time: number; pips: number }[];
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

/**
 * Net pips from the levels actually recorded, less the cost of doing the trade.
 *
 * `costPrice` is in price units, so it is subtracted BEFORE the pip division —
 * a 1-pip spread on EUR/USD and on USD/JPY is a different price distance, and
 * dividing first would charge the wrong amount on one of them.
 *
 * Returns null when the levels are unusable (a zero or non-finite stop
 * distance), which is the same thing `ticketLevels` guards against upstream.
 */
export function pipsOf(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  entry: number,
  stop: number,
  exitPrice: number,
  costPrice = 0,
): number | null {
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk === 0) return null;
  const move = direction === 'LONG' ? exitPrice - entry : entry - exitPrice;
  if (!Number.isFinite(move)) return null;
  return (move - costPrice) / pipSize(symbol);
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
        open.pips = pipsOf(symbol, open.direction, open.entry, open.stop, price, cost);
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
            pips: null,
            stopPips: Math.abs(levels.entry - levels.stop) / pipSize(symbol),
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
            open.pips = pipsOf(symbol, open.direction, open.entry, open.stop, onEntryBar.price, cost);
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

/** Cumulative pips after each CLOSED trade, oldest first. */
export function equityCurve(trades: readonly BacktestTrade[]): { time: number; pips: number }[] {
  const out: { time: number; pips: number }[] = [];
  let cum = 0;
  for (const t of trades) {
    if (t.pips === null || t.exitTime === null) continue;
    cum += t.pips;
    out.push({ time: t.exitTime, pips: cum });
  }
  return out;
}

export function measure(trades: readonly BacktestTrade[]): BacktestMetrics {
  const closed = trades.filter((t) => t.pips !== null);
  const ps = closed.map((t) => t.pips!);
  const wins = ps.filter((p) => p > 0);
  const losses = ps.filter((p) => p < 0);
  const n = ps.length;

  const totalPips = ps.reduce((a, b) => a + b, 0);
  const averagePips = n > 0 ? totalPips / n : null;

  // The size of the average bet. Taken over CLOSED trades only, so it is the
  // denominator of the same population the headline describes.
  const averageStopPips = n > 0 ? closed.reduce((a, t) => a + t.stopPips, 0) / n : null;

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Sample standard deviation, then the standard error of the mean. With
  // fewer than two trades neither exists, and pretending otherwise would put
  // a confidence interval on a single coin flip.
  let standardError: number | null = null;
  if (n > 1 && averagePips !== null) {
    const variance = ps.reduce((acc, p) => acc + (p - averagePips) ** 2, 0) / (n - 1);
    standardError = Math.sqrt(variance / n);
  }
  const ciLow = averagePips !== null && standardError !== null ? averagePips - 1.96 * standardError : null;
  const ciHigh = averagePips !== null && standardError !== null ? averagePips + 1.96 * standardError : null;

  // Break-even win rate for the payoff actually observed. With no losses
  // there is nothing to break even against.
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const breakEvenWinRatePct = avgWin + avgLoss > 0 ? (avgLoss / (avgWin + avgLoss)) * 100 : 0;

  let peak = 0;
  let cum = 0;
  let maxDrawdownPips = 0;
  for (const p of ps) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDrawdownPips = Math.max(maxDrawdownPips, peak - cum);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n > 0 ? (wins.length / n) * 100 : null,
    averagePips,
    totalPips,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    maxDrawdownPips,
    averageStopPips,
    standardError,
    ciLow,
    ciHigh,
    significant: ciLow !== null && ciHigh !== null && (ciLow > 0 || ciHigh < 0),
    breakEvenWinRatePct,
    stillOpen: trades.length - n,
  };
}

export interface Portfolio {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equity: { time: number; pips: number }[];
  /**
   * True when the merged trades span both JPY-quoted and non-JPY-quoted pairs.
   *
   * Pips are only addable within one pip size. A USD/JPY pip is 0.01 and a
   * EUR/USD pip is 0.0001; in money they are different amounts, and JPY pairs
   * routinely travel two to three times as far in pips for the same risk. So
   * a total that spans both is a sum of unlike things, and the page has to say
   * so rather than print it as a plain number.
   *
   * Computed here, next to the trades, so no caller has to re-derive it and
   * get it wrong.
   */
  mixesPipValues: boolean;
}

/** Merge per-pair runs into one portfolio view, trades ordered by exit. */
export function combine(results: readonly BacktestResult[]): Portfolio {
  const trades = results
    .flatMap((r) => r.trades)
    .sort((a, b) => (a.exitTime ?? a.entryTime) - (b.exitTime ?? b.entryTime));

  const sizes = new Set(trades.map((t) => pipSize(t.symbol)));
  return {
    trades,
    metrics: measure(trades),
    equity: equityCurve(trades),
    mixesPipValues: sizes.size > 1,
  };
}

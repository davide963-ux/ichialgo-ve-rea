/**
 * Backtest harness — plumbing, not strategy.
 *
 * It replays candles through whichever DETECTOR it is handed — the same ones
 * the live engine and the server-side scanner call — and through the SAME
 * `ticketLevels` the trade-plan card shows. So a backtested trade and a live
 * signal come from one implementation, and there is no "backtest version" of
 * any rule that could quietly diverge from the one being traded.
 *
 * The system has two entries — a Kumo breakout and a Tenkan/Kijun pullback —
 * and they are measured together because that is how the article describes
 * them working. `entryType` is recorded on every trade so the two can still
 * be read apart afterwards without being run apart.
 *
 *   signal at bar i ──▶ ticketLevels() ──▶ buy the close of bar i
 *                                           │
 *                         bars i+1, i+2, … ─┴─▶ stop hit?  ──▶ −stopPips
 *                                              target hit? ──▶ +2 × stopPips
 *                                              neither     ──▶ keep holding
 *
 * EVERYTHING IS MEASURED IN PIPS
 * ─────────────────────────────
 * A pip is the unit the levels are actually quoted in, so a pip result can be
 * checked against the chart by hand: entry 1.0850, stop 1.0840, stopped out
 * ⇒ −10 pips, and nothing has been divided by anything.
 *
 * The cost of that choice is worth stating, because the page states it too.
 * The stop is a fraction of the 26-bar range, so each trade risks a DIFFERENT
 * number of pips — a quiet EUR/USD pullback might risk 8, a volatile one 22.
 * Averaging their pip results therefore averages outcomes of unequal bets.
 * And a JPY pip is a different amount of money from a EUR/USD pip, and
 * typically travels further, so a total that adds the two mixes units outright.
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
 *  1. THE ENTRY IS THE CLOSE OF THE SIGNAL BAR, which is a price that traded
 *     by definition — so there is no fill rule here and no no-fill count.
 *
 *     That is a change from the previous strategy, and it is the honest
 *     version rather than a kinder one. Entry used to be a resting limit at
 *     the EMA, which meant deciding whether each touch bar had actually
 *     reached the line: a third of them had not, and filling them anyway was
 *     worth +0.23R a trade of pure fiction (on GBP/JPY the fillable trades
 *     totalled −9R while the unfillable ones "made" +34R, with entries up to
 *     4.8 pips better than the bar's own extreme). A market order at the
 *     close cannot be flattered that way, because the close is in the bar.
 *
 *  2. THE TRADE IS LIVE FROM THE NEXT BAR. Nothing about the signal bar can
 *     close the trade, in either direction: the fill happens at its close, so
 *     its high and low both belong to the past.
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
import { ICHIMOKU, type IchimokuConfig } from '../../config/ichimokuStrategy';
import { analyseIchimoku } from './ichimokuSystem';
import { ticketLevels } from './tradePlan';
import type { Direction, EntryType, IchimokuSignal } from './types';

export type BacktestExit = 'tp' | 'sl' | 'open';

export interface BacktestTrade {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
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
  /** Checks that passed. Every required one did, or there would be no trade. */
  score: number;
  /** How many there were — the two entries do not have the same number. */
  checksTotal: number;
  /** Which of the system's two entries opened it. */
  entryType: EntryType;
  /** The 26-bar range in pips — the volatility the stop was drawn from. */
  rangePips: number;
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
  /**
   * Run the detector with non-default settings.
   *
   * The rules live INSIDE the detector, so a filter applied afterwards could
   * only ever remove signals. Answering "what would the literal reading of
   * the Chikou filter have done?" needs the detector itself re-run, which is
   * what this is for.
   */
  config?: IchimokuConfig;
  /**
   * An arbitrary extra rule, applied after the two above.
   *
   * Exists so a proposed entry rule can be measured through the SAME
   * walk-forward — with the same fill rule, the same one-position-at-a-time
   * accounting and the same pessimistic exits — instead of by filtering the
   * finished trade list. Those are not the same thing: rejecting a trade
   * frees the position for a later touch that the unfiltered run never took,
   * so post-hoc filtering answers a question nobody asked.
   */
  accept?: (signal: IchimokuSignal) => boolean;
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
  /** Signals the detector produced, before the page's own filters. */
  signals: number;
  /** Signals skipped by the filters. */
  filtered: number;
  /**
   * Signals that arrived while a position was already open, and were
   * therefore never traded. Reported rather than swallowed: it is the
   * difference between "the rule fired this often" and "you could have taken
   * this many", and on this strategy it is most of them.
   */
  skippedWhileOpen: number;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  /** Cumulative pips after each closed trade, for the equity curve. */
  equity: { time: number; pips: number }[];
}

/**
 * Does this bar close the position, and at what price? Stop checked first.
 *
 * Exported because the LIVE trade resolver calls this exact function. A
 * separate "did it hit TP or SL" check written for live trades would be a
 * second set of rules, and the first thing to diverge would be the same-bar
 * ambiguity below — which is precisely the decision that flatters a backtest.
 * One function, one answer, both places.
 */
export function resolveBar(
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

const passesFilters = (s: IchimokuSignal, f: BacktestFilters): boolean => !f.accept || f.accept(s);

export function backtest(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  filters: BacktestFilters = {},
): BacktestResult {
  const analysis = analyseIchimoku(candles, symbol, timeframe, filters.config ?? ICHIMOKU, 0);
  const cost = (filters.costPips ?? 0) * pipSize(symbol);
  const pip = pipSize(symbol);

  // Signal bar index, so the walk-forward can start from the next bar. The
  // detector reports bar TIMES; this maps them back without assuming the
  // signals and the candles share an index.
  const indexOfTime = new Map<number, number>();
  candles.forEach((c, i) => indexOfTime.set(c.time, i));

  const eligible = analysis.signals.filter((s) => passesFilters(s, filters));
  const trades: BacktestTrade[] = [];
  let skippedWhileOpen = 0;

  let open: (BacktestTrade & { entryIndex: number }) | null = null;
  let next = 0; // index into `eligible`

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;

    // ── Manage an open position FIRST, on this bar ───────────────────────
    // A bar must be allowed to close a trade before it is allowed to open
    // one, or a stop-out and an entry get booked from one candle. Rule 2:
    // the entry bar itself is never offered, so `i > entryIndex`.
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
    // Signals on bars already behind us are counted as skipped, not dropped
    // silently: they fired while a position was open, which is a property of
    // the rule the reader should see.
    while (next < eligible.length && (indexOfTime.get(eligible[next]!.barTime) ?? -1) < i) {
      skippedWhileOpen++;
      next++;
    }
    if (next < eligible.length && indexOfTime.get(eligible[next]!.barTime) === i) {
      if (open !== null) {
        skippedWhileOpen++;
        next++;
      } else {
        const signal = eligible[next]!;
        next++;
        const levels = ticketLevels(signal);
        // A market order at the close always fills — the close is a price the
        // bar traded at, by definition. The only way to get nothing here is
        // levels that round to an unusable ticket.
        if (levels) {
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
            stopPips: Math.abs(levels.entry - levels.stop) / pip,
            score: signal.score,
            checksTotal: signal.checksTotal,
            entryType: signal.entryType,
            rangePips: signal.rangePips,
          };
        }
      }
    }
  }

  // Signals left unconsumed at the end were all behind an open position too.
  skippedWhileOpen += eligible.length - next;

  // A trade still open when the data ends is recorded but never counted.
  if (open !== null) {
    open.barsHeld = candles.length - 1 - open.entryIndex;
    trades.push(open);
  }

  return {
    symbol,
    timeframe,
    bars: candles.length,
    signals: analysis.signals.length,
    filtered: analysis.signals.length - eligible.length,
    skippedWhileOpen,
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

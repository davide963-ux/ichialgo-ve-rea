/**
 * Assembling a signal once a detector has decided one exists.
 *
 * WHY THE STOP IS PASSED IN RATHER THAN COMPUTED HERE
 * ───────────────────────────────────────────────────
 * It used to be computed here, as a fixed fraction of the 26-bar range, and
 * that was a number bolted onto the strategy rather than a consequence of it.
 * The article names the support and resistance twice — Kijun "acts as dynamic
 * support/resistance", the Kumo is "a potential future support zone" — so the
 * stop belongs beyond whichever of those the entry relied on, which only the
 * detector knows. See `stopFor` in ichimokuSystem.ts.
 *
 * What is left here is assembly: the id, the lines, the pip conversions and
 * the score. No decision.
 */
import type { EntryType } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { Candle } from '../marketData/types';
import type { BarFacts } from './ichimokuBars';
import type { Direction, IchimokuSignal, SignalCheck, StrategyId } from './types';

export const signalId = (strategy: StrategyId, symbol: string, timeframe: Timeframe, barTime: number) =>
  `${strategy}|${symbol}|${timeframe}|${barTime}`;

/**
 * When a signal happened, in ms.
 *
 * A live signal happened when the tick arrived; a closed-bar one happened on
 * its bar. Sorting the log by `detectedAt` alone would put a bar that closed
 * an hour ago above a tick from a second ago whenever a scan ran in between.
 */
export const signalTimeMs = (s: Pick<IchimokuSignal, 'source' | 'barTime' | 'detectedAt'>): number =>
  s.source === 'live' ? s.detectedAt : s.barTime * 1000;

export interface SignalDraft {
  strategy: StrategyId;
  symbol: string;
  timeframe: Timeframe;
  /** The bar the signal is dated to — for a two-stage setup, the one that completed it. */
  facts: BarFacts;
  detectedAt: number;
  source: 'candle' | 'live';
  direction: Direction;
  /** Where a market order fills: the signal bar's close. */
  entry: number;
  checks: SignalCheck[];
}

export interface Ticket {
  stop: number;
  target: number;
  /** The structure the stop sits beyond: Kijun-sen, or the far cloud edge. */
  stopLevel: number;
  entryType: EntryType;
  /** Price that triggers the break-even move, or null when the rule is off. */
  breakEven: number | null;
  /** Price the stop moves TO — a pip the profitable side of the entry. */
  breakEvenStop: number | null;
}

export function buildSignal(d: SignalDraft, ticket: Ticket): IchimokuSignal {
  const { facts, direction, entry } = d;
  const long = direction === 'LONG';
  const pip = facts.pip;

  return {
    id: signalId(d.strategy, d.symbol, d.timeframe, facts.bar.time),
    strategy: d.strategy,
    symbol: d.symbol,
    timeframe: d.timeframe,
    barTime: facts.bar.time,
    detectedAt: d.detectedAt,
    source: d.source,

    direction,
    kumo: long ? 'above' : 'below',
    entryType: ticket.entryType,

    entry,
    stop: ticket.stop,
    target: ticket.target,
    stopPips: Math.abs(entry - ticket.stop) / pip,
    stopLevel: ticket.stopLevel,
    breakEven: ticket.breakEven,
    breakEvenStop: ticket.breakEvenStop,
    rangePips: facts.range / pip,

    tenkan: facts.tenkan,
    kijun: facts.kijun,
    senkouA: facts.senkouA,
    senkouB: facts.senkouB,
    senkouAheadA: facts.aheadA,
    senkouAheadB: facts.aheadB,
    distancePips: Math.abs(entry - facts.kijun) / pip,
    cloudPips: facts.cloudPips,

    checks: d.checks,
    score: d.checks.filter((c) => c.pass === true).length,
    checksTotal: d.checks.length,
  };
}

/** True when every check the strategy marked `required` passed. */
export const requiredPassed = (checks: readonly SignalCheck[]): boolean =>
  checks.every((c) => !c.required || c.pass === true);

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
 * A position's exit rules, fixed at entry.
 *
 * `breakEven` holds both halves of that rule, or null when it is off: the
 * price that TRIGGERS the move and the price the stop moves TO. One object
 * rather than two nullable fields, so a trigger can never exist without a
 * destination — which would otherwise be a silent way to move a stop to
 * zero.
 *
 * Both are prices, not pip counts, so the pair's pip size is converted once
 * where the ticket is built rather than in each of the three places that
 * walk bars.
 */
export interface ExitRules {
  direction: Direction;
  entry: number;
  /** The stop the trade opened with. */
  stop: number;
  target: number;
  breakEven: { trigger: number; stop: number } | null;
}

/** What changes bar by bar while the position is open. */
export interface ExitState {
  /** The stop actually working: the original, or `entry` once armed. */
  stop: number;
  /** Whether the break-even move has happened. */
  movedToBreakEven: boolean;
}

export const openExit = (rules: ExitRules): ExitState => ({ stop: rules.stop, movedToBreakEven: false });

/**
 * Advance one bar of an open position.
 *
 * WHY THE BREAK-EVEN MOVE TAKES EFFECT ON THE *NEXT* BAR
 * ─────────────────────────────────────────────────────
 * OHLC does not say in which order a bar reached its high and its low. On the
 * bar that first trades 10 pips in profit, the same bar may also trade down
 * through the original stop — and whether the stop moved before or after that
 * happened is exactly the information a candle does not contain.
 *
 * So the trigger bar is still resolved against the ORIGINAL stop, and the
 * tighter stop applies from the following bar. The destination is a pip the
 * far side of the entry rather than the entry itself, so a scratch covers
 * the spread instead of paying it. That is the conservative
 * reading of the rule the user asked for: it refuses the scratch and books
 * the full loss whenever the ambiguity exists, which means the measured
 * benefit of break-even is an UNDERSTATEMENT rather than a flattering
 * number. Arming within the trigger bar would let the backtest decide an
 * intrabar path in the rule's favour, which is the same class of mistake as
 * filling a limit order the bar never reached.
 *
 * The stop is still checked before the target, for the same reason it always
 * was: a bar covering both cannot be ordered either.
 */
export function stepExit(
  bar: Candle,
  rules: ExitRules,
  state: ExitState,
): { exit: 'tp' | 'sl' | 'be' | null; price: number; state: ExitState } {
  const long = rules.direction === 'LONG';

  if (long ? bar.low <= state.stop : bar.high >= state.stop) {
    // Scratched at the locked-in price, or stopped out for a real loss. They
    // are different outcomes and the history records them apart, because
    // "how many losses did break-even avoid" cannot be answered otherwise.
    return { exit: state.movedToBreakEven ? 'be' : 'sl', price: state.stop, state };
  }
  if (long ? bar.high >= rules.target : bar.low <= rules.target) {
    return { exit: 'tp', price: rules.target, state };
  }

  if (
    !state.movedToBreakEven &&
    rules.breakEven !== null &&
    (long ? bar.high >= rules.breakEven.trigger : bar.low <= rules.breakEven.trigger)
  ) {
    return { exit: null, price: bar.close, state: { stop: rules.breakEven.stop, movedToBreakEven: true } };
  }

  return { exit: null, price: bar.close, state };
}

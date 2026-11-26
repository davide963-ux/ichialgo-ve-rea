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

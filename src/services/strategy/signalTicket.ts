/**
 * Assembling a signal from a strategy's verdict.
 *
 * WHY EVERY STRATEGY GETS THE SAME EXIT
 * ─────────────────────────────────────
 * OANDA's article specifies entries in detail and says nothing whatever about
 * stops, targets or sizing. So the exit here is ours, and it is deliberately
 * IDENTICAL for all three strategies: comparing two entry rules is only
 * meaningful when the exit is held constant, or the comparison quietly
 * measures the exits instead. If their pullback beats ours on this page, it
 * beat it on the entry, which is the only thing either author specified.
 *
 *   stop   = entry -/+ stopRange * the 26-bar range
 *   target = entry +/- rewardMultiple * the stop distance
 *
 * The range is Ichimoku's own: Kijun-sen is its midpoint, so sizing from it
 * introduces no indicator the strategies do not already contain.
 */
import { TICKET, type TicketConfig } from '../../config/ichimokuStrategy';
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
  /** Where a market order fills. Normally `facts.bar.close`; a live quote otherwise. */
  entry: number;
  checks: SignalCheck[];
  /** Overrides the bar time, for a live signal fired inside a forming bar. */
  barTime?: number;
  /** Overrides the range, for a live signal inheriting the last closed bar's. */
  range?: number;
}

export function buildSignal(d: SignalDraft, config: TicketConfig = TICKET): IchimokuSignal {
  const { facts, direction, entry } = d;
  const long = direction === 'LONG';
  const range = d.range ?? facts.range;
  const risk = range * config.stopRange;
  const pip = facts.pip;

  return {
    id: signalId(d.strategy, d.symbol, d.timeframe, d.barTime ?? facts.bar.time),
    strategy: d.strategy,
    symbol: d.symbol,
    timeframe: d.timeframe,
    barTime: d.barTime ?? facts.bar.time,
    detectedAt: d.detectedAt,
    source: d.source,

    direction,
    kumo: long ? 'above' : 'below',

    entry,
    stop: long ? entry - risk : entry + risk,
    target: long ? entry + risk * config.rewardMultiple : entry - risk * config.rewardMultiple,
    stopPips: risk / pip,
    rangePips: range / pip,

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

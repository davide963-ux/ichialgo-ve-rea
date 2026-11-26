/**
 * Turns a signal into an order ticket.
 *
 * The three prices are NOT computed here. They come off the signal, where the
 * detector put them, because they are Ichimoku's own numbers:
 *
 *   entry  = the close that completed the pullback (where a market order fills)
 *   stop   = entry ∓ stopRange × the 26-bar range
 *   target = entry ± rewardMultiple × (stop distance)
 *
 *                        ┌──── target  (entry + 2 × risk)
 *          LONG          │
 *          (price above  │
 *           the Kumo,    ●──── entry = the pullback close
 *           caught at    │
 *           Kijun)       └──── stop   (entry − 0.4 × the 26-bar range)
 *
 * This file does two things to them and nothing else: rounds them to prices a
 * broker will accept, and sizes the position. The stop used to be built here
 * from an average true range, with a pip floor underneath it; both are gone,
 * and with them the possibility of the ticket and the backtest disagreeing
 * about what was risked.
 *
 * Sizing is delegated to lib/positionSize.ts — the same tested math the
 * calculator uses. Prices are rounded BEFORE sizing: you cannot place an
 * order at 1.1015183, and sizing off the raw float would make the plan
 * disagree with the calculator it prefills.
 */
import { getPair } from '../../config/pairs';
import { pipSize } from '../../lib/pips';
import { calculatePosition, type RateLookup } from '../../lib/positionSize';
import type { AccountState } from '../../state/accountStore';
import type { Direction, IchimokuSignal } from './types';

export interface TradePlan {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  stopPips: number;
  targetPips: number;
  /** Target distance ÷ stop distance, from the rounded prices actually used. */
  riskReward: number;
  /** The 26-bar range in pips — what the stop is a fraction of. */
  rangePips: number;
  /** Null when the position cannot be sized (missing USD rate, sub-minimum lot). */
  lots: number | null;
  units: number | null;
  riskAmount: number | null;
  potentialLoss: number | null;
  potentialProfit: number | null;
  /** Reasons to hesitate: sizing warnings, a confirmation that is unknown. */
  warnings: string[];
}

/**
 * The three prices a broker would accept, rounded to the pair's precision.
 *
 * Split out because the server-side scanner uses this and nothing of its own,
 * so a recorded trade and a displayed ticket come from one implementation.
 * Returns null when the levels are unusable — a zero stop distance after
 * rounding, which a pair with 2 digits and a very quiet range can produce.
 */
export interface TicketLevels {
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
}

export function ticketLevels(signal: IchimokuSignal): TicketLevels | null {
  const digits = getPair(signal.symbol).digits;
  const round = (v: number) => Number(v.toFixed(digits));
  if (![signal.entry, signal.stop, signal.target].every((v) => Number.isFinite(v) && v > 0)) return null;

  const entry = round(signal.entry);
  const stop = round(signal.stop);
  const target = round(signal.target);
  if (stop <= 0 || stop === entry || target === entry) return null;

  return { direction: signal.direction, entry, stop, target };
}

export function planFromSignal(
  signal: IchimokuSignal,
  account: AccountState,
  lookup: RateLookup = () => null,
): TradePlan | null {
  const levels = ticketLevels(signal);
  if (!levels) return null;

  const pip = pipSize(signal.symbol);
  const { direction, entry, stop, target } = levels;
  const stopDistance = Math.abs(entry - stop);
  const targetDistance = Math.abs(target - entry);

  const sized = calculatePosition(
    { balance: account.balance, riskPct: account.riskPct, symbol: signal.symbol, entry, stopLoss: stop, takeProfit: target },
    lookup,
  );

  const warnings = [...sized.warnings, ...sized.errors];

  /**
   * Warnings come off the signal's own checks rather than from named fields,
   * because the three strategies do not share a set of conditions. A check
   * that could not be answered is worth saying out loud; one that simply
   * failed and was not required is the strategy working as designed.
   */
  if (signal.score < signal.checksTotal) {
    warnings.unshift(
      `${signal.score} of ${signal.checksTotal} checks passed — enough to trade, but not unanimous.`,
    );
  }
  for (const c of signal.checks) {
    if (c.pass === null) warnings.push(`${c.label} could not be checked: ${c.detail}.`);
  }
  if (signal.source === 'live') {
    warnings.push('Fired from a live tick inside an unfinished bar — the cloud is read from the last closed one.');
  }

  return {
    direction,
    entry,
    stop,
    target,
    stopPips: stopDistance / pip,
    targetPips: targetDistance / pip,
    riskReward: stopDistance > 0 ? targetDistance / stopDistance : 0,
    rangePips: signal.rangePips,
    lots: sized.ok ? sized.lots : null,
    units: sized.ok ? sized.units : null,
    riskAmount: sized.riskAmount,
    potentialLoss: sized.ok ? sized.potentialLoss : null,
    potentialProfit: sized.ok ? sized.potentialProfit : null,
    warnings,
  };
}

/** Prefill link for the calculator, so a plan can be reviewed and edited. */
export function calculatorLink(symbol: string, plan: TradePlan): string {
  const digits = getPair(symbol).digits;
  const params = new URLSearchParams({
    symbol,
    entry: plan.entry.toFixed(digits),
    sl: plan.stop.toFixed(digits),
    tp: plan.target.toFixed(digits),
  });
  return `/calculator?${params}`;
}

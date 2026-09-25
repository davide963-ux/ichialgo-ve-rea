/**
 * Turns an EMA50 touch into an order ticket.
 *
 *   entry = the EMA itself (the level a limit order would fill at)
 *   stop  = entry ∓ stopAtrMultiple × ATR, floored at minStopPips
 *   target= entry ± rewardMultiple × (stop distance)
 *
 *                        ┌──── target  (entry + 2R)
 *          LONG          │
 *          (touch from   │
 *           above, EMA   ●──── entry = EMA50
 *           rising)      │
 *                        └──── stop   (entry − 1.5 × ATR)
 *
 * The stop is ATR-based rather than a fixed pip count for the same reason the
 * touch band is: the wick that tagged the EMA is itself roughly one ATR long,
 * so a fixed stop would be taken out by ordinary noise in a fast market and
 * be needlessly wide in a quiet one.
 *
 * Sizing is delegated to lib/positionSize.ts — the same tested math the
 * calculator uses. Prices are rounded to the pair's own precision BEFORE
 * sizing: you cannot place an order at 1.1015183, and sizing off the raw
 * float would make the plan disagree with the calculator it prefills.
 */
import { getPair } from '../../config/pairs';
import { TRADE_PLAN, type TradePlanConfig } from '../../config/strategy';
import { pipSize } from '../../lib/pips';
import { calculatePosition, type RateLookup } from '../../lib/positionSize';
import type { AccountState } from '../../state/accountStore';
import type { TouchSignal } from './types';

export interface TradePlan {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  stopPips: number;
  targetPips: number;
  riskReward: number;
  atrPips: number;
  /** Null when the position cannot be sized (missing USD rate, sub-minimum lot). */
  lots: number | null;
  units: number | null;
  riskAmount: number | null;
  potentialLoss: number | null;
  potentialProfit: number | null;
  /** Reasons to hesitate: counter-trend touch, sizing warnings, stop at the floor. */
  warnings: string[];
}

/**
 * Direction implied by a touch.
 *
 * A touch from ABOVE is a pullback — the trade is a long off the level.
 * A touch from BELOW is a rally into resistance — the trade is a short.
 * `bias` is not used here: it encodes trend AGREEMENT, and a counter-trend
 * touch still has a direction, it is just a worse trade (and is flagged).
 */
export const directionOf = (signal: Pick<TouchSignal, 'approach'>): 'LONG' | 'SHORT' =>
  signal.approach === 'above' ? 'LONG' : 'SHORT';

export function planFromTouch(
  signal: TouchSignal,
  account: AccountState,
  lookup: RateLookup = () => null,
  config: TradePlanConfig = TRADE_PLAN,
): TradePlan | null {
  if (!Number.isFinite(signal.ema) || signal.ema <= 0) return null;

  const pip = pipSize(signal.symbol);
  const round = (v: number) => Number(v.toFixed(getPair(signal.symbol).digits));
  const direction = directionOf(signal);
  const entry = round(signal.ema);

  const rawStopDistance = Math.max(signal.atr * config.stopAtrMultiple, config.minStopPips * pip);
  const stop = round(direction === 'LONG' ? entry - rawStopDistance : entry + rawStopDistance);
  if (stop <= 0 || stop === entry) return null;
  const stopDistance = Math.abs(entry - stop);
  const target = round(
    direction === 'LONG' ? entry + stopDistance * config.rewardMultiple : entry - stopDistance * config.rewardMultiple,
  );

  const sized = calculatePosition(
    { balance: account.balance, riskPct: account.riskPct, symbol: signal.symbol, entry, stopLoss: stop, takeProfit: target },
    lookup,
  );

  const warnings = [...sized.warnings, ...sized.errors];
  if (signal.counterTrend) warnings.unshift('Touch is against the EMA trend — the weaker case.');
  if (rawStopDistance <= config.minStopPips * pip) {
    warnings.push(`ATR is small: the stop is at the ${config.minStopPips}-pip floor, not ${config.stopAtrMultiple}×ATR.`);
  }

  return {
    direction,
    entry,
    stop,
    target,
    stopPips: stopDistance / pip,
    targetPips: Math.abs(target - entry) / pip,
    riskReward: config.rewardMultiple,
    atrPips: signal.atr / pip,
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

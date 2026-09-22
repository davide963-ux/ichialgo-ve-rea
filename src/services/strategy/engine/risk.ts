/**
 * Entry, stop, targets and reward/risk.
 *
 * STOPS COME FROM STRUCTURE, NOT FROM A FIXED ATR MULTIPLE
 * ────────────────────────────────────────────────────────
 * A stop exists to say "the idea was wrong". The idea is wrong when price
 * takes out the swing the setup was built on, or reclaims the level it
 * rejected — not when it has moved 1.5 ATR. So the stop is anchored to the
 * nearest structural level BEYOND entry, with an ATR buffer so a wick through
 * the exact level does not close the trade.
 *
 * The buffer matters more than it looks: stops sitting exactly on an obvious
 * swing low are the most reliably hunted price in the market.
 *
 * TARGETS COME FROM WHERE PRICE ACTUALLY STOPS
 * ────────────────────────────────────────────
 * The first target is the next real obstacle — an opposing zone, a prior swing
 * or a pattern's measured move — because that is where the move is likely to
 * stall. Only when nothing structural is in range does it fall back to R
 * multiples, and that fallback is recorded so the explanation can say so.
 *
 * THE REWARD/RISK GATE IS HARD
 * ────────────────────────────
 * The spec asks to avoid signals whose stop is large relative to the available
 * target. That is enforced here as a rejection, not as a scoring penalty: no
 * amount of confluence makes a 0.4R trade worth taking, and letting a 90-score
 * setup through with a terrible ticket is how a good engine loses money.
 */
import type { EngineConfig } from './config';
import type { ChartPattern } from './chartPatterns';
import type { LevelRead } from './levels';
import type { StructureRead } from './structure';

export interface RiskTicketDraft {
  entry: number;
  stop: number;
  targets: number[];
  stopDistance: number;
  /** Reward/risk of the FIRST target — the one that must clear the gate. */
  rewardRisk: number;
  /** What the stop was anchored to, for the explanation. */
  stopBasis: string;
  /** What the first target was anchored to. */
  targetBasis: string;
}

export interface RiskInput {
  side: 'bullish' | 'bearish';
  price: number;
  atr: number;
  structure: StructureRead;
  levels: LevelRead;
  pattern: ChartPattern | null;
  config: EngineConfig;
}

/**
 * Build a ticket, or explain why there isn't one.
 *
 * Returns null when the geometry does not work — an unreachable target, a stop
 * that would have to be absurdly wide, or a reward/risk below the floor.
 */
export function buildTicket(input: RiskInput): { ticket: RiskTicketDraft | null; reject: string | null } {
  const { side, price, atr, config } = input;
  if (atr <= 0) return { ticket: null, reject: 'No ATR available.' };

  const long = side === 'bullish';
  const buffer = atr * config.risk.stopBufferAtr;

  // ── Stop: nearest structural level beyond entry ────────────────────────
  const candidates: { price: number; basis: string }[] = [];

  const swing = long ? input.structure.lastSwingLow : input.structure.lastSwingHigh;
  if (swing) candidates.push({ price: swing.price, basis: long ? 'below the last swing low' : 'above the last swing high' });

  const zone = long ? input.levels.support : input.levels.resistance;
  if (zone) candidates.push({ price: zone.price, basis: long ? 'below support' : 'above resistance' });

  if (input.pattern?.invalidation !== null && input.pattern?.invalidation !== undefined) {
    candidates.push({ price: input.pattern.invalidation, basis: `beyond ${input.pattern.name} invalidation` });
  }

  // Only levels on the correct side of entry can serve as a stop.
  const valid = candidates.filter((c) => (long ? c.price < price : c.price > price));

  // Nearest valid level keeps the risk smallest; a further one only widens the
  // stop without making the idea any more wrong.
  const anchor = valid.length === 0
    ? null
    : valid.reduce((a, b) => (Math.abs(price - b.price) < Math.abs(price - a.price) ? b : a));

  let stop: number;
  let stopBasis: string;
  if (anchor === null) {
    stop = long ? price - atr * 1.5 : price + atr * 1.5;
    stopBasis = 'ATR-based (no structure in range)';
  } else {
    stop = long ? anchor.price - buffer : anchor.price + buffer;
    stopBasis = anchor.basis;
  }

  let stopDistance = Math.abs(price - stop);

  // Too tight is noise, too wide makes the arithmetic meaningless. Clamp
  // rather than reject: the level is right, the distance just needs sanity.
  const minStop = atr * config.risk.minStopAtr;
  const maxStop = atr * config.risk.maxStopAtr;
  if (stopDistance < minStop) {
    stopDistance = minStop;
    stop = long ? price - minStop : price + minStop;
    stopBasis += ' (widened to ATR floor)';
  }
  if (stopDistance > maxStop) {
    return { ticket: null, reject: `Structural stop is ${(stopDistance / atr).toFixed(1)} ATR away — too wide to size.` };
  }

  // ── Targets: the next real obstacles ───────────────────────────────────
  const obstacles: { price: number; basis: string }[] = [];

  for (const z of input.levels.zones) {
    if (long ? z.price > price : z.price < price) {
      obstacles.push({ price: z.price, basis: long ? 'next resistance' : 'next support' });
    }
  }

  const extreme = long ? input.levels.previousHigh : input.levels.previousLow;
  if (extreme !== null && (long ? extreme > price : extreme < price)) {
    obstacles.push({ price: extreme, basis: long ? 'previous high' : 'previous low' });
  }

  if (input.pattern?.target !== null && input.pattern?.target !== undefined) {
    if (long ? input.pattern.target > price : input.pattern.target < price) {
      obstacles.push({ price: input.pattern.target, basis: `${input.pattern.name} measured move` });
    }
  }

  obstacles.sort((a, b) => (long ? a.price - b.price : b.price - a.price));

  let targets: number[];
  let targetBasis: string;

  if (obstacles.length === 0) {
    // Genuinely clear air ahead. R multiples are the only honest answer, and
    // the basis records that no level chose them.
    targets = config.risk.fallbackTargetR.map((r) => (long ? price + stopDistance * r : price - stopDistance * r));
    targetBasis = 'R multiples (no structural target in range)';
  } else {
    // The nearest obstacle decides whether there is a trade here at all.
    //
    // An earlier version DISCARDED obstacles closer than the stop distance as
    // "inside the noise" and then fell back to R multiples — which meant a
    // setup with resistance 0.3R away was handed a 1.5R target straight
    // through it, and the reward/risk gate below could essentially never
    // fire. A level too close to pay for the stop is not noise to be ignored;
    // it is the reason not to take the trade.
    const nearest = obstacles[0]!;
    const available = Math.abs(nearest.price - price) / stopDistance;
    if (available < config.risk.minRewardRisk) {
      return {
        ticket: null,
        reject: `Only ${available.toFixed(2)}R to the ${nearest.basis} against a ${(stopDistance / atr).toFixed(1)} ATR stop — below the ${config.risk.minRewardRisk}R floor.`,
      };
    }

    targets = obstacles.slice(0, 3).map((o) => o.price);
    targetBasis = nearest.basis;
    // Always offer three: a runner beyond the last known obstacle is still a
    // plan, whereas exiting everything at the first zone caps every winner.
    while (targets.length < 3) {
      const last = targets[targets.length - 1]!;
      targets.push(long ? last + stopDistance : last - stopDistance);
    }
  }

  const rewardRisk = Math.abs(targets[0]! - price) / stopDistance;

  return {
    ticket: { entry: price, stop, targets, stopDistance, rewardRisk, stopBasis, targetBasis },
    reject: null,
  };
}

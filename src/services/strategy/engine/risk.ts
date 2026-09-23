/**
 * Entry, stop, target and reward/risk.
 *
 * STOPS COME FROM STRUCTURE, AND ONLY FROM STRUCTURE
 * ──────────────────────────────────────────────────
 * A stop exists to say "the idea was wrong". The idea is wrong when price
 * takes out the swing the setup was built on, or reclaims the level it
 * rejected — not when it has moved some multiple of a volatility average. So
 * the stop is anchored to the nearest structural level beyond entry, plus a
 * small wick allowance, and nothing else touches it.
 *
 * The allowance matters more than it looks: a stop sitting exactly on an
 * obvious swing low is the most reliably hunted price in the market.
 *
 * WHY THERE IS NO MINIMUM OR MAXIMUM STOP DISTANCE
 * ────────────────────────────────────────────────
 * There used to be both, expressed in ATR. The floor was the more damaging:
 * where structure gave a tight stop it was widened to a volatility minimum,
 * which manufactured trades with a very tight stop and a very distant target.
 * Those showed a flattering reward/risk and were taken out by ordinary noise
 * far more often than their geometry implied — on a random walk the 3R-and-up
 * bucket returned −0.42R a trade where the arithmetic says it must return
 * zero.
 *
 * If structure puts the stop close, the stop is close and the reward/risk is
 * large. If structure puts it far, the reward/risk is small and the gate at
 * the bottom of this file refuses the trade. Either way the level comes from
 * the chart, not from a volatility constant.
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
  target: number;
  stopDistance: number;
  /** Reward/risk of the target. Must clear the configured floor. */
  rewardRisk: number;
  /** What the stop was anchored to, for the explanation. */
  stopBasis: string;
  /** What the first target was anchored to. */
  targetBasis: string;
}

export interface RiskInput {
  side: 'bullish' | 'bearish';
  price: number;
  scale: number;
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
/**
 * Distance to the nearest thing that could serve as a target.
 *
 * Computed before the stop is chosen, because the stop choice depends on what
 * reward is actually available — a level is only "too close" relative to how
 * far the trade could run.
 */
function nearestObstacleDistance(input: RiskInput, price: number, long: boolean): number | null {
  let best: number | null = null;
  const consider = (p: number | null | undefined) => {
    if (p === null || p === undefined) return;
    if (long ? p <= price : p >= price) return;
    const d = Math.abs(p - price);
    if (best === null || d < best) best = d;
  };
  for (const z of input.levels.zones) consider(z.price);
  consider(long ? input.levels.previousHigh : input.levels.previousLow);
  consider(input.pattern?.target);
  return best;
}

export function buildTicket(input: RiskInput): { ticket: RiskTicketDraft | null; reject: string | null } {
  const { side, price, scale, config } = input;
  if (scale <= 0) return { ticket: null, reject: 'Not enough price history to measure a typical candle range.' };

  const long = side === 'bullish';
  const buffer = scale * config.risk.stopBufferRange;

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

  // Nearest first — the smallest risk that still has a level behind it.
  const ordered = [...valid].sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price));

  // …but skip levels so close that price is already standing on them.
  //
  // Such a stop is not an invalidation: it sits inside ordinary movement, and
  // pairing it with a distant target produces a ticket showing 6R or 8R that
  // gets taken out by noise. Stepping OUT to the next structural level keeps
  // the answer on the chart, where a volatility floor would not.
  const anchor =
    ordered.find((c) => {
      const distance = Math.abs(price - c.price) + scale * config.risk.stopBufferRange;
      const room = nearestObstacleDistance(input, price, long);
      return room === null || room / distance <= config.risk.maxRewardRisk;
    }) ?? ordered[ordered.length - 1] ?? null;

  let stop: number;
  let stopBasis: string;
  if (anchor === null) {
    // Nothing structural to hang a stop on. Rather than invent a distance,
    // refuse: a stop that no level chose is not an invalidation, it is a
    // guess, and the whole point of the ticket is that being wrong is defined.
    return { ticket: null, reject: 'No swing, zone or pattern level below entry to anchor a stop to.' };
  } else {
    stop = long ? anchor.price - buffer : anchor.price + buffer;
    stopBasis = anchor.basis;
  }

  const stopDistance = Math.abs(price - stop);

  // The only thing that can make a structural stop unusable is having no
  // distance at all — entry sitting exactly on the level. Everything else is
  // a matter of reward against risk, which the gate below decides.
  if (stopDistance <= 0) {
    return { ticket: null, reject: 'Entry sits on its own stop level — no risk to measure.' };
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

  let target: number;
  let targetBasis: string;

  if (obstacles.length === 0) {
    // Genuinely clear air ahead. An R multiple is the only honest answer, and
    // the basis records that no level chose it.
    target = long ? price + stopDistance * config.risk.fallbackTargetR : price - stopDistance * config.risk.fallbackTargetR;
    targetBasis = 'R multiple (no structural target in range)';
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

    // Just SHORT of the level, not on it.
    //
    // The obstacle is where the opposing orders sit, so price routinely turns
    // a few pips before reaching it. Targeting the level exactly converts a
    // move that went the right way into a full loss often enough to matter.
    //
    // The haircut is applied BEFORE the gate, not after: gating on the
    // obstacle and then shaving the target lets a ticket pass at 1.2R and
    // ship at 1.19R, which is precisely the ticket the gate exists to refuse.
    target = price + (nearest.price - price) * config.risk.targetHaircut;
    targetBasis = nearest.basis;

    const available = Math.abs(target - price) / stopDistance;
    if (available < config.risk.minRewardRisk) {
      return {
        ticket: null,
        reject: `Only ${available.toFixed(2)}R to the ${nearest.basis} — below the ${config.risk.minRewardRisk}R floor.`,
      };
    }
  }

  const rewardRisk = Math.abs(target - price) / stopDistance;

  return {
    ticket: { entry: price, stop, target, stopDistance, rewardRisk, stopBasis, targetBasis },
    reject: null,
  };
}

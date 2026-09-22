/**
 * Support and resistance, built from swings that actually got respected.
 *
 * WHY CLUSTERING, NOT INDIVIDUAL SWINGS
 * ─────────────────────────────────────
 * A single swing high is a fact, not a level. What traders act on is a PRICE
 * AREA that turned the market more than once — so swings within a cluster
 * distance are merged, and the number of touches becomes the zone's strength.
 * A zone touched four times is a different object from one touched once, and
 * scoring them the same is how a scanner ends up calling every minor pivot
 * "resistance".
 *
 * ROLE IS NOT FIXED
 * ─────────────────
 * A zone is support or resistance depending on where price is NOW, not on
 * whether it was built from highs or lows. That is the whole point of the
 * flip: broken resistance becomes support, and a zone that keeps its original
 * label after a break gives exactly the wrong reading at the retest — the
 * moment the setup is most tradeable.
 */
import type { Candle } from '../../marketData/types';
import type { Swing } from '../../../lib/indicators/marketStructure';
import type { EngineConfig } from './config';

export interface Zone {
  /** Centre of the cluster. */
  price: number;
  /** How many swings formed it. More touches, more respected. */
  touches: number;
  /** Bars since the most recent touch. */
  barsSinceTouch: number;
  /** Where price sits relative to it right now. */
  role: 'support' | 'resistance';
  /** Half-width of the zone, in price. */
  halfWidth: number;
}

export interface Breakout {
  direction: 'bullish' | 'bearish';
  /** The zone that was broken. */
  level: number;
  /** Bars since the breaking close. */
  barsAgo: number;
  /** True once price has come back and held the broken level. */
  retested: boolean;
  /** Bars since the retest, when there was one. */
  retestBarsAgo: number | null;
}

export interface LevelRead {
  zones: Zone[];
  /** Nearest zone below price. */
  support: Zone | null;
  /** Nearest zone above price. */
  resistance: Zone | null;
  /** True when price is sitting in a zone right now. */
  atSupport: boolean;
  atResistance: boolean;
  /** Distance to the nearest zone in each direction, in ATR. */
  supportDistanceAtr: number | null;
  resistanceDistanceAtr: number | null;
  /** Most recent breakout of a zone, with its retest state. */
  breakout: Breakout | null;
  /** Extreme of the whole lookback — the levels everyone can see. */
  previousHigh: number | null;
  previousLow: number | null;
}

/** Merge nearby swings into zones, strongest (most touched) first. */
function cluster(swings: readonly Swing[], candles: readonly Candle[], end: number, atr: number, config: EngineConfig): Zone[] {
  const tolerance = atr * config.levels.clusterAtr;
  const groups: { prices: number[]; lastIndex: number }[] = [];

  for (const s of swings) {
    const g = groups.find((x) => Math.abs(x.prices[0]! - s.price) <= tolerance);
    if (g) {
      g.prices.push(s.price);
      g.lastIndex = Math.max(g.lastIndex, s.index);
    } else {
      groups.push({ prices: [s.price], lastIndex: s.index });
    }
  }

  const price = candles[end]!.close;

  return groups
    .filter((g) => g.prices.length >= config.levels.minTouches)
    .map((g) => {
      const centre = g.prices.reduce((a, b) => a + b, 0) / g.prices.length;
      return {
        price: centre,
        touches: g.prices.length,
        barsSinceTouch: end - g.lastIndex,
        // Role from where price is NOW, not from what built the zone.
        role: centre < price ? ('support' as const) : ('resistance' as const),
        halfWidth: tolerance,
      };
    })
    .sort((a, b) => b.touches - a.touches || a.barsSinceTouch - b.barsSinceTouch);
}

/**
 * Find the most recent zone break, and whether price came back to test it.
 *
 * A retest is what turns a breakout from a chase into a setup: price returns
 * to the broken level and HOLDS, which gives a defined invalidation. Without
 * one, entry is wherever the candle happened to close.
 */
function findBreakout(
  zones: readonly Zone[],
  candles: readonly Candle[],
  end: number,
  atr: number,
  config: EngineConfig,
): Breakout | null {
  const buffer = atr * config.structure.breakBufferAtr;
  const window = Math.min(config.levels.retestWindow * 3, end);
  const from = Math.max(1, end - window);
  let best: Breakout | null = null;

  for (const z of zones) {
    // Crossings grouped into EPISODES, and the last episode is the breakout.
    //
    // Neither "first crossing" nor "last crossing" works. The classic
    // break → pull back → recover sequence crosses the same level twice in
    // the same direction: taking the LAST one relabels the recovery as a
    // fresh breakout and then searches for a retest in the bars after it,
    // where by construction there is none — so the most tradeable pattern in
    // this module would report `retested: false` every time. Taking the FIRST
    // one reaches back to an unrelated break from an hour of trading ago.
    //
    // An episode is a run of same-direction crossings of one zone, close
    // enough together to be the same event. Its FIRST crossing is the break;
    // the return in between is the retest.
    const crossings: { index: number; up: boolean }[] = [];
    for (let i = from; i <= end; i++) {
      const prev = candles[i - 1]!;
      const bar = candles[i]!;
      if (prev.close <= z.price + buffer && bar.close > z.price + buffer) crossings.push({ index: i, up: true });
      else if (prev.close >= z.price - buffer && bar.close < z.price - buffer) crossings.push({ index: i, up: false });
    }
    if (crossings.length === 0) continue;

    let episodeStart = crossings[crossings.length - 1]!;
    for (let k = crossings.length - 1; k > 0; k--) {
      const cur = crossings[k]!;
      const before = crossings[k - 1]!;
      const sameEvent = before.up === cur.up && cur.index - before.index <= config.levels.retestWindow;
      if (!sameEvent) break;
      episodeStart = before;
    }

    const breakIndex: number | null = episodeStart.index;
    const up = episodeStart.up;

    if (breakIndex === null) continue;

    // Did price return to the level and hold the right side of it?
    let retestBarsAgo: number | null = null;
    for (let j = breakIndex + 1; j <= Math.min(end, breakIndex + config.levels.retestWindow); j++) {
      const b = candles[j]!;
      const touched = b.low <= z.price + z.halfWidth && b.high >= z.price - z.halfWidth;
      if (!touched) continue;
      const held = up ? b.close > z.price - buffer : b.close < z.price + buffer;
      if (held) retestBarsAgo = end - j;
    }

    const candidate: Breakout = {
      direction: up ? 'bullish' : 'bearish',
      level: z.price,
      barsAgo: end - breakIndex,
      retested: retestBarsAgo !== null,
      retestBarsAgo,
    };

    // Newest break wins, but a retested break beats a bare one: the retest is
    // what turns a chase into a setup with a defined invalidation.
    if (best === null || (candidate.retested && !best.retested) ||
        (candidate.retested === best.retested && candidate.barsAgo < best.barsAgo)) {
      best = candidate;
    }
  }

  return best;
}

export function readLevels(
  candles: readonly Candle[],
  end: number,
  swings: readonly Swing[],
  atr: number,
  config: EngineConfig,
): LevelRead {
  const price = candles[end]!.close;
  const zones = cluster(swings, candles, end, atr, config);

  const below = zones.filter((z) => z.price < price).sort((a, b) => b.price - a.price);
  const above = zones.filter((z) => z.price > price).sort((a, b) => a.price - b.price);
  const support = below[0] ?? null;
  const resistance = above[0] ?? null;

  const supportDistanceAtr = support === null ? null : (price - support.price) / atr;
  const resistanceDistanceAtr = resistance === null ? null : (resistance.price - price) / atr;

  const from = Math.max(0, end - config.levels.lookback);
  let previousHigh = -Infinity;
  let previousLow = Infinity;
  for (let i = from; i <= end; i++) {
    const c = candles[i]!;
    if (c.high > previousHigh) previousHigh = c.high;
    if (c.low < previousLow) previousLow = c.low;
  }

  return {
    zones,
    support,
    resistance,
    atSupport: supportDistanceAtr !== null && supportDistanceAtr <= config.levels.proximityAtr,
    atResistance: resistanceDistanceAtr !== null && resistanceDistanceAtr <= config.levels.proximityAtr,
    supportDistanceAtr,
    resistanceDistanceAtr,
    breakout: findBreakout(zones, candles, end, atr, config),
    previousHigh: Number.isFinite(previousHigh) ? previousHigh : null,
    previousLow: Number.isFinite(previousLow) ? previousLow : null,
  };
}

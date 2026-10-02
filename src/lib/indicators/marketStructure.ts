/**
 * Market structure — swing pivots, and the sequence of highs and lows.
 *
 * Indicators say what the average of price has been doing. Structure says what
 * price ITSELF has been doing, which is why the spec makes it a required
 * confirmation rather than another line to agree with.
 *
 * SWING DETECTION (fractal)
 * ─────────────────────────
 * A swing high is a bar whose high is strictly greater than the `wings` bars
 * on BOTH sides. That "both sides" is the catch: a swing is only confirmed
 * `wings` bars after it happened, so the most recent bars can never be pivots
 * yet. Pretending otherwise would be lookahead — the classic way a backtest
 * flatters itself.
 *
 *          ●  ← swing high, confirmed 2 bars later
 *       ╱  │  ╲
 *      ╱   │   ╲___
 *     ╱               ╲
 *    ╱                 ●  ← swing low
 *    └─2─┘   └─2─┘        wings = 2
 *
 * READING THE SEQUENCE
 * ────────────────────
 * Uptrend  = higher highs AND higher lows
 * Downtrend= lower highs  AND lower lows
 * Anything mixed is a range or a transition — deliberately NOT forced into a
 * direction, because "no clear structure" is the honest answer often enough
 * that inventing one is the expensive mistake.
 *
 * Swings smaller than `minSwingAtr × ATR` are dropped: a 3-pip wiggle inside a
 * 60-pip impulse is not a structural pivot, and counting it turns every clean
 * trend into "mixed".
 */
import type { OHLC } from './atr';

export type StructureDirection = 'up' | 'down' | 'range' | 'unclear';

export interface Swing {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

export interface MarketStructure {
  direction: StructureDirection;
  /** 0–1. How cleanly the swing sequence agrees with `direction`. */
  strength: number;
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  /** Most recent confirmed swings, oldest first. */
  swings: Swing[];
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
  /** Bars since the newest confirmed pivot — staleness of the read. */
  barsSinceSwing: number | null;
}

export interface StructureOptions {
  fractalWings: number;
  swingLookback: number;
  maxBars: number;
  minSwingAtr: number;
}

/**
 * Confirmed swing pivots up to and including bar `end`.
 *
 * Only bars at least `wings` back from `end` can be pivots, because the right
 * wing must already exist. This function never reads past `end`.
 */
export function findSwings(
  candles: readonly OHLC[],
  end: number,
  options: StructureOptions,
  atrAt: number | null = null,
): Swing[] {
  const { fractalWings: w, maxBars, minSwingAtr } = options;
  const swings: Swing[] = [];
  if (w < 1 || end < 2 * w) return swings;

  const first = Math.max(w, end - maxBars);
  const last = end - w; // right wing must be complete

  for (let i = first; i <= last; i++) {
    const bar = candles[i];
    if (!bar) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (!other) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (other.high >= bar.high) isHigh = false;
      if (other.low <= bar.low) isLow = false;
    }

    if (isHigh) swings.push({ index: i, price: bar.high, kind: 'high' });
    else if (isLow) swings.push({ index: i, price: bar.low, kind: 'low' });
  }

  if (atrAt === null || atrAt <= 0 || minSwingAtr <= 0) return swings;

  // Drop pivots that barely move against their neighbour — noise, not structure.
  const minMove = atrAt * minSwingAtr;
  const kept: Swing[] = [];
  for (const s of swings) {
    const prev = kept[kept.length - 1];
    if (prev && prev.kind !== s.kind && Math.abs(s.price - prev.price) < minMove) continue;
    kept.push(s);
  }
  return kept;
}

/**
 * Read the highs/lows sequence at bar `end`.
 *
 * `strength` is the share of comparisons that agree with the direction, so a
 * trend with one corrective pivot scores below a clean one instead of being
 * discarded outright.
 */
export function analyseStructure(
  candles: readonly OHLC[],
  end: number,
  options: StructureOptions,
  atrAt: number | null = null,
): MarketStructure {
  const all = findSwings(candles, end, options, atrAt);
  const swings = all.slice(-options.swingLookback);

  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');

  // Three-way, not boolean: an EQUAL pivot is neither higher nor lower. Folding
  // equality into "not higher" makes a dead flat market read as a downtrend,
  // which is both wrong and the exact case a range filter exists to catch.
  const compare = (xs: Swing[]): number[] => xs.slice(1).map((s, i) => Math.sign(s.price - xs[i]!.price));
  const highSeq = compare(highs);
  const lowSeq = compare(lows);

  const higherHighs = highSeq.length > 0 && highSeq.every((x) => x > 0);
  const higherLows = lowSeq.length > 0 && lowSeq.every((x) => x > 0);
  const lowerHighs = highSeq.length > 0 && highSeq.every((x) => x < 0);
  const lowerLows = lowSeq.length > 0 && lowSeq.every((x) => x < 0);

  const comparisons = [...highSeq, ...lowSeq];
  const up = comparisons.filter((x) => x > 0).length;
  const down = comparisons.filter((x) => x < 0).length;

  let direction: StructureDirection = 'unclear';
  let strength = 0;

  if (comparisons.length === 0) {
    direction = 'unclear';
  } else if (higherHighs && higherLows) {
    direction = 'up';
    strength = 1;
  } else if (lowerHighs && lowerLows) {
    direction = 'down';
    strength = 1;
  } else {
    const share = Math.max(up, down) / comparisons.length;
    // A near-even split of rising and falling pivots IS a range — that is what
    // a sideways market looks like structurally, not a weak trend.
    if (share < 0.6) {
      direction = 'range';
      strength = 0;
    } else {
      direction = up > down ? 'up' : 'down';
      // Rescale 0.6–1.0 onto 0–1 so an imperfect trend is clearly weaker than
      // a textbook one without collapsing to zero.
      strength = (share - 0.6) / 0.4;
    }
  }

  const lastSwingHigh = highs.length > 0 ? highs[highs.length - 1]! : null;
  const lastSwingLow = lows.length > 0 ? lows[lows.length - 1]! : null;
  const newest = swings.length > 0 ? swings[swings.length - 1]! : null;

  return {
    direction,
    strength: Math.max(0, Math.min(1, strength)),
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    swings,
    lastSwingHigh,
    lastSwingLow,
    barsSinceSwing: newest === null ? null : end - newest.index,
  };
}

/**
 * Short-term structure over the last few bars — used for entry confirmation,
 * where the question is "has price started turning back in the trend's
 * direction yet?" rather than "what is the trend?".
 *
 * Returns the direction of the most recent micro-leg, or null when flat.
 */
export function microStructure(candles: readonly OHLC[], end: number, bars: number): 'up' | 'down' | null {
  const start = end - bars;
  if (start < 0 || !candles[end]) return null;

  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (!c) return null;
    if (c.high > highestHigh) highestHigh = c.high;
    if (c.low < lowestLow) lowestLow = c.low;
  }

  const close = candles[end]!.close;
  const range = highestHigh - lowestLow;
  if (range <= 0) return null;

  // Where the close sits inside the recent range: near the top means buyers
  // took control of the leg, near the bottom means sellers did.
  const position = (close - lowestLow) / range;
  if (position >= 0.6) return 'up';
  if (position <= 0.4) return 'down';
  return null;
}

/**
 * Chart patterns, detected from the swing sequence.
 *
 * WHY SWINGS AND NOT RAW BARS
 * ───────────────────────────
 * A double top is two swing highs at a similar level with a swing low between
 * them. Expressed in swings that is four lines of code and it is robust;
 * expressed in raw OHLC it is a curve-fitting exercise that finds a double top
 * in every sideways week. Every pattern here is a shape over 3–7 confirmed
 * swings, which also means they inherit the fractal confirmation delay — a
 * pattern cannot be claimed before its last pivot is real.
 *
 * NEUTRAL PATTERNS DO NOT GET A DIRECTION
 * ───────────────────────────────────────
 * Symmetrical triangles, ranges and compressions resolve either way, and the
 * spec is explicit: do not predict the direction before the breakout. They are
 * reported with bias 'neutral' and contribute nothing to a directional score
 * until price actually leaves them — at which point the BREAKOUT scores, not
 * the pattern.
 *
 * TARGETS
 * ───────
 * Where a pattern has a conventional measured move (height of the head, of the
 * range, of the flagpole), it is reported. The risk module prefers structural
 * levels but will use a measured move when nothing better is in range.
 */
import type { Swing } from '../../../lib/indicators/marketStructure';
import type { Candle } from '../../marketData/types';
import type { EngineConfig } from './config';

export type PatternBias = 'bullish' | 'bearish' | 'neutral';
export type PatternFamily = 'reversal' | 'continuation' | 'bilateral';

export interface ChartPattern {
  name: string;
  family: PatternFamily;
  bias: PatternBias;
  /** Bar index of the last swing forming it. */
  index: number;
  barsAgo: number;
  /** 0–1 confidence in the shape itself. */
  quality: number;
  /** Measured-move target, where the pattern has one. */
  target: number | null;
  /** Price that would invalidate it. */
  invalidation: number | null;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Score how cleanly two levels match: 1.0 for identical, 0 at the tolerance.
 * A double top whose peaks are 0.05 typical range apart is a better pattern than one
 * whose peaks are 0.49 typical range apart, and the difference should survive into the
 * confluence score rather than being flattened to a boolean.
 */
const matchQuality = (a: number, b: number, tol: number) => Math.max(0, 1 - Math.abs(a - b) / tol);

export function readChartPatterns(
  candles: readonly Candle[],
  end: number,
  swings: readonly Swing[],
  scale: number,
  config: EngineConfig,
): ChartPattern[] {
  const out: ChartPattern[] = [];
  // Three is the real floor: a double top is peak, trough, peak. Requiring
  // four silently rejected every valid one.
  if (scale <= 0 || swings.length < 3) return out;

  const tol = scale * config.patterns.equalityRange;
  const minHeight = scale * config.patterns.minHeightRange;
  const recent = swings.filter((s) => end - s.index <= config.patterns.lookback);
  if (recent.length < 3) return out;

  const add = (p: Omit<ChartPattern, 'barsAgo'>) => {
    if (end - p.index > config.patterns.freshnessBars + config.structure.fractalWings) return;
    out.push({ ...p, barsAgo: end - p.index });
  };

  const highs = recent.filter((s) => s.kind === 'high');
  const lows = recent.filter((s) => s.kind === 'low');

  // ── Double / triple tops and bottoms ───────────────────────────────────
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i - 1]!;
    const b = highs[i]!;
    if (!near(a.price, b.price, tol)) continue;
    const trough = lows.find((l) => l.index > a.index && l.index < b.index);
    if (!trough || a.price - trough.price < minHeight) continue;

    const triple = highs[i + 1] && near(b.price, highs[i + 1]!.price, tol);
    add({
      name: triple ? 'Triple Top' : 'Double Top',
      family: 'reversal',
      bias: 'bearish',
      index: triple ? highs[i + 1]!.index : b.index,
      quality: matchQuality(a.price, b.price, tol) * (triple ? 1 : 0.9),
      target: trough.price - (a.price - trough.price),
      invalidation: Math.max(a.price, b.price) + tol,
    });
  }

  for (let i = 1; i < lows.length; i++) {
    const a = lows[i - 1]!;
    const b = lows[i]!;
    if (!near(a.price, b.price, tol)) continue;
    const peak = highs.find((h) => h.index > a.index && h.index < b.index);
    if (!peak || peak.price - a.price < minHeight) continue;

    const triple = lows[i + 1] && near(b.price, lows[i + 1]!.price, tol);
    add({
      name: triple ? 'Triple Bottom' : 'Double Bottom',
      family: 'reversal',
      bias: 'bullish',
      index: triple ? lows[i + 1]!.index : b.index,
      quality: matchQuality(a.price, b.price, tol) * (triple ? 1 : 0.9),
      target: peak.price + (peak.price - a.price),
      invalidation: Math.min(a.price, b.price) - tol,
    });
  }

  // ── Head and shoulders ─────────────────────────────────────────────────
  // Three peaks, middle highest, shoulders roughly level. The neckline is the
  // two troughs between them, and breaking it is what completes the pattern.
  for (let i = 2; i < highs.length; i++) {
    const l = highs[i - 2]!;
    const h = highs[i - 1]!;
    const r = highs[i]!;
    if (h.price <= l.price || h.price <= r.price) continue;
    if (!near(l.price, r.price, tol * 1.5)) continue;
    const troughs = lows.filter((x) => x.index > l.index && x.index < r.index);
    if (troughs.length < 2) continue;
    const neckline = troughs.reduce((a, b) => a + b.price, 0) / troughs.length;
    if (h.price - neckline < minHeight) continue;

    add({
      name: 'Head and Shoulders',
      family: 'reversal',
      bias: 'bearish',
      index: r.index,
      quality: matchQuality(l.price, r.price, tol * 1.5) * 0.95,
      target: neckline - (h.price - neckline),
      invalidation: h.price,
    });
  }

  for (let i = 2; i < lows.length; i++) {
    const l = lows[i - 2]!;
    const h = lows[i - 1]!;
    const r = lows[i]!;
    if (h.price >= l.price || h.price >= r.price) continue;
    if (!near(l.price, r.price, tol * 1.5)) continue;
    const peaks = highs.filter((x) => x.index > l.index && x.index < r.index);
    if (peaks.length < 2) continue;
    const neckline = peaks.reduce((a, b) => a + b.price, 0) / peaks.length;
    if (neckline - h.price < minHeight) continue;

    add({
      name: 'Inverse Head and Shoulders',
      family: 'reversal',
      bias: 'bullish',
      index: r.index,
      quality: matchQuality(l.price, r.price, tol * 1.5) * 0.95,
      target: neckline + (neckline - h.price),
      invalidation: h.price,
    });
  }

  // ── Triangles, wedges and ranges ───────────────────────────────────────
  // All four are the same measurement — the slope of the highs against the
  // slope of the lows — so they are derived together rather than as four
  // near-identical detectors that could disagree with each other.
  const lastHighs = highs.slice(-3);
  const lastLows = lows.slice(-3);

  if (lastHighs.length >= 2 && lastLows.length >= 2) {
    const hFirst = lastHighs[0]!;
    const hLast = lastHighs[lastHighs.length - 1]!;
    const lFirst = lastLows[0]!;
    const lLast = lastLows[lastLows.length - 1]!;

    const highSlope = (hLast.price - hFirst.price) / Math.max(1, hLast.index - hFirst.index);
    const lowSlope = (lLast.price - lFirst.price) / Math.max(1, lLast.index - lFirst.index);
    const flatTol = scale * 0.02;
    const height = Math.abs(hLast.price - lLast.price);
    const index = Math.max(hLast.index, lLast.index);
    const converging = Math.abs(hLast.price - lLast.price) < Math.abs(hFirst.price - lFirst.price);

    const highFlat = Math.abs(highSlope) < flatTol;
    const lowFlat = Math.abs(lowSlope) < flatTol;

    if (highFlat && lowSlope > flatTol && height >= minHeight * 0.6) {
      add({
        name: 'Ascending Triangle',
        family: 'continuation',
        bias: 'bullish',
        index,
        quality: 0.7,
        target: hLast.price + height,
        invalidation: lLast.price,
      });
    } else if (lowFlat && highSlope < -flatTol && height >= minHeight * 0.6) {
      add({
        name: 'Descending Triangle',
        family: 'continuation',
        bias: 'bearish',
        index,
        quality: 0.7,
        target: lLast.price - height,
        invalidation: hLast.price,
      });
    } else if (highFlat && lowFlat && height >= minHeight * 0.6) {
      add({
        name: 'Rectangle',
        family: 'bilateral',
        bias: 'neutral',
        index,
        quality: 0.6,
        target: null,
        invalidation: null,
      });
    } else if (converging && highSlope < -flatTol && lowSlope > flatTol) {
      add({
        name: 'Symmetrical Triangle',
        family: 'bilateral',
        bias: 'neutral',
        index,
        quality: 0.6,
        target: null,
        invalidation: null,
      });
    } else if (converging && highSlope > flatTol && lowSlope > flatTol) {
      // Both boundaries rising but converging: buyers are running out of room.
      add({
        name: 'Rising Wedge',
        family: 'reversal',
        bias: 'bearish',
        index,
        quality: 0.65,
        target: lFirst.price,
        invalidation: hLast.price + tol,
      });
    } else if (converging && highSlope < -flatTol && lowSlope < -flatTol) {
      add({
        name: 'Falling Wedge',
        family: 'reversal',
        bias: 'bullish',
        index,
        quality: 0.65,
        target: hFirst.price,
        invalidation: lLast.price - tol,
      });
    }
  }

  // ── Flags and pennants ─────────────────────────────────────────────────
  // A sharp impulse followed by a shallow, tight drift against it. The
  // pole must dominate: a "flag" whose consolidation is as big as the move
  // before it is just a range.
  const flag = detectFlag(candles, end, scale);
  if (flag) add(flag);

  // ── Rounded top / bottom ───────────────────────────────────────────────
  const rounded = detectRounded(candles, end, scale, config);
  if (rounded) add(rounded);

  return out.sort((a, b) => b.quality - a.quality || a.barsAgo - b.barsAgo);
}

/**
 * Impulse leg, then a shallow counter-drift.
 *
 * Measured on closes rather than swings: a flag is often too tight to produce
 * confirmed fractals, which is exactly why swing-based detection misses them.
 */
function detectFlag(
  candles: readonly Candle[],
  end: number,
  scale: number,
): Omit<ChartPattern, 'barsAgo'> | null {
  const consolidation = 8;
  const pole = 12;
  const start = end - consolidation - pole;
  if (start < 0) return null;

  const poleFrom = candles[start]!.close;
  const poleTo = candles[start + pole]!.close;
  const poleMove = poleTo - poleFrom;
  if (Math.abs(poleMove) < scale * 2.5) return null;

  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start + pole; i <= end; i++) {
    const c = candles[i]!;
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const consolidationHeight = hi - lo;
  if (consolidationHeight > Math.abs(poleMove) * 0.5) return null;

  const bullish = poleMove > 0;
  const drift = candles[end]!.close - poleTo;
  // The drift must go AGAINST the pole, or it is continuation already underway.
  if (bullish && drift > 0) return null;
  if (!bullish && drift < 0) return null;

  // A pennant converges; a flag drifts in a channel. Narrow enough is a pennant.
  const pennant = consolidationHeight < scale * 1.2;
  const name = bullish
    ? pennant ? 'Bull Pennant' : 'Bull Flag'
    : pennant ? 'Bear Pennant' : 'Bear Flag';

  return {
    name,
    family: 'continuation',
    bias: bullish ? 'bullish' : 'bearish',
    index: end,
    quality: 0.7,
    target: bullish ? hi + Math.abs(poleMove) : lo - Math.abs(poleMove),
    invalidation: bullish ? lo : hi,
  };
}

/**
 * A rounded reversal: price curves rather than pivots.
 *
 * Detected by comparing the middle of the window against both ends — a saucer
 * has its extreme in the middle and roughly level edges. Deliberately coarse,
 * because a rounded bottom that needs precision to detect is not one.
 */
function detectRounded(
  candles: readonly Candle[],
  end: number,
  scale: number,
  config: EngineConfig,
): Omit<ChartPattern, 'barsAgo'> | null {
  const window = 40;
  const start = end - window;
  if (start < 0) return null;

  const first = candles[start]!.close;
  const last = candles[end]!.close;
  if (!near(first, last, scale * 1.2)) return null;

  let extremeLow = Infinity;
  let extremeHigh = -Infinity;
  let lowIdx = start;
  let highIdx = start;
  for (let i = start; i <= end; i++) {
    const c = candles[i]!;
    if (c.low < extremeLow) { extremeLow = c.low; lowIdx = i; }
    if (c.high > extremeHigh) { extremeHigh = c.high; highIdx = i; }
  }

  const middle = (lo: number) => lo > start + window * 0.3 && lo < end - window * 0.2;
  const depth = Math.min(first, last) - extremeLow;
  const heightAbove = extremeHigh - Math.max(first, last);

  if (middle(lowIdx) && depth >= scale * config.patterns.minHeightRange) {
    return {
      name: 'Rounded Bottom',
      family: 'reversal',
      bias: 'bullish',
      index: end,
      quality: 0.55,
      target: last + depth,
      invalidation: extremeLow,
    };
  }
  if (middle(highIdx) && heightAbove >= scale * config.patterns.minHeightRange) {
    return {
      name: 'Rounded Top',
      family: 'reversal',
      bias: 'bearish',
      index: end,
      quality: 0.55,
      target: last - heightAbove,
      invalidation: extremeHigh,
    };
  }
  return null;
}

/** The strongest directional pattern for a side, ignoring neutral ones. */
export function bestPatternFor(patterns: readonly ChartPattern[], bias: 'bullish' | 'bearish'): ChartPattern | null {
  const matching = patterns.filter((p) => p.bias === bias);
  if (matching.length === 0) return null;
  return matching.reduce((a, b) => (b.quality > a.quality ? b : a));
}

/** Any neutral pattern in force — used to damp a score, never to direct it. */
export function neutralPattern(patterns: readonly ChartPattern[]): ChartPattern | null {
  return patterns.find((p) => p.bias === 'neutral') ?? null;
}

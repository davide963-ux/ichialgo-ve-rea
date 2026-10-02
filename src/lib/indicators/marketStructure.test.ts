import { describe, expect, it } from 'vitest';
import { analyseStructure, findSwings, microStructure, type StructureOptions } from './marketStructure';

const OPTIONS: StructureOptions = { fractalWings: 2, swingLookback: 6, maxBars: 120, minSwingAtr: 0 };

/** Bars from highs/lows, with close midway — enough for pivot detection. */
function bars(points: { high: number; low: number }[]) {
  return points.map((p) => ({ ...p, close: (p.high + p.low) / 2, open: (p.high + p.low) / 2 }));
}

/**
 * A zigzag as a CONTINUOUS path: straight legs between alternating turning
 * points, each pair of turns `drift` higher.
 *
 * Interpolating matters. Building it leg-by-leg and repeating the boundary
 * value puts two equal bars next to each other, which the fractal reads as
 * extra micro-pivots and turns a clean trend into "range". Real price does
 * not stutter like that; the fixture should not either.
 */
function zigzag(turns: number, base = 100, amplitude = 5, drift = 0, barsPerLeg = 5) {
  const targets: number[] = [];
  for (let t = 0; t < turns; t++) {
    targets.push(base + Math.floor(t / 2) * drift + (t % 2 === 0 ? amplitude : -amplitude));
  }

  const path: number[] = [targets[0]!];
  for (let t = 1; t < targets.length; t++) {
    const from = targets[t - 1]!;
    const to = targets[t]!;
    for (let k = 1; k <= barsPerLeg; k++) path.push(from + ((to - from) * k) / barsPerLeg);
  }

  return bars(path.map((v) => ({ high: v + 0.5, low: v - 0.5 })));
}

describe('findSwings', () => {
  it('finds alternating pivots in a zigzag', () => {
    const candles = zigzag(6);
    const swings = findSwings(candles, candles.length - 1, OPTIONS);
    expect(swings.length).toBeGreaterThanOrEqual(4);
    // Pivots should alternate: a high is always followed by a low.
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i]!.kind).not.toBe(swings[i - 1]!.kind);
    }
  });

  it('never returns a pivot that its right wing has not confirmed', () => {
    const candles = zigzag(6);
    const end = candles.length - 1;
    const swings = findSwings(candles, end, OPTIONS);
    for (const s of swings) {
      expect(s.index).toBeLessThanOrEqual(end - OPTIONS.fractalWings);
    }
  });

  it('reads no more than it is given — a later spike cannot change an earlier read', () => {
    const candles = zigzag(6);
    const early = findSwings(candles, 20, OPTIONS);
    const extended = [...candles];
    extended[30] = { high: 999, low: 998, close: 998.5, open: 998.5 };
    const again = findSwings(extended, 20, OPTIONS);
    expect(again).toEqual(early);
  });

  it('drops pivots smaller than minSwingAtr', () => {
    const candles = zigzag(8, 100, 0.4);
    const loose = findSwings(candles, candles.length - 1, { ...OPTIONS, minSwingAtr: 0 }, 1);
    const strict = findSwings(candles, candles.length - 1, { ...OPTIONS, minSwingAtr: 2 }, 1);
    expect(strict.length).toBeLessThan(loose.length);
  });

  it('returns nothing when there is not enough history for a wing', () => {
    const candles = zigzag(1);
    expect(findSwings(candles, 2, OPTIONS)).toEqual([]);
  });
});

describe('analyseStructure', () => {
  it('reads a rising zigzag as an uptrend with higher highs and higher lows', () => {
    const candles = zigzag(8, 100, 5, 4);
    const s = analyseStructure(candles, candles.length - 1, OPTIONS);
    expect(s.direction).toBe('up');
    expect(s.higherHighs).toBe(true);
    expect(s.higherLows).toBe(true);
    expect(s.strength).toBeGreaterThan(0.5);
  });

  it('reads a falling zigzag as a downtrend', () => {
    const candles = zigzag(8, 200, 5, -4);
    const s = analyseStructure(candles, candles.length - 1, OPTIONS);
    expect(s.direction).toBe('down');
    expect(s.lowerHighs).toBe(true);
    expect(s.lowerLows).toBe(true);
  });

  it('calls a flat zigzag a range rather than inventing a direction', () => {
    const candles = zigzag(8, 100, 5, 0);
    const s = analyseStructure(candles, candles.length - 1, OPTIONS);
    expect(s.direction).toBe('range');
    expect(s.strength).toBe(0);
  });

  it('says unclear when there are no pivots at all', () => {
    const flat = bars(Array.from({ length: 30 }, () => ({ high: 100, low: 99 })));
    const s = analyseStructure(flat, flat.length - 1, OPTIONS);
    expect(s.direction).toBe('unclear');
    expect(s.swings).toEqual([]);
  });

  it('scores a trend with one corrective pivot below a clean one', () => {
    const cleanBars = zigzag(8, 100, 5, 4);
    const clean = analyseStructure(cleanBars, cleanBars.length - 1, OPTIONS);
    const messy = zigzag(8, 100, 5, 4);
    // Flatten one peak so the highs stop rising monotonically.
    messy[12] = { high: 90, low: 89, close: 89.5, open: 89.5 };
    const dirty = analyseStructure(messy, messy.length - 1, OPTIONS);
    expect(dirty.strength).toBeLessThanOrEqual(clean.strength);
  });

  it('reports how stale the structure read is', () => {
    const candles = zigzag(8, 100, 5, 4);
    const s = analyseStructure(candles, candles.length - 1, OPTIONS);
    expect(s.barsSinceSwing).toBeGreaterThanOrEqual(OPTIONS.fractalWings);
  });
});

describe('microStructure', () => {
  it('reads a close near the top of the recent range as up', () => {
    const candles = bars([
      { high: 10, low: 8 },
      { high: 11, low: 9 },
      { high: 12, low: 10 },
    ]);
    candles[2]!.close = 11.9;
    expect(microStructure(candles, 2, 2)).toBe('up');
  });

  it('reads a close near the bottom as down', () => {
    const candles = bars([
      { high: 12, low: 10 },
      { high: 11, low: 9 },
      { high: 10, low: 8 },
    ]);
    candles[2]!.close = 8.1;
    expect(microStructure(candles, 2, 2)).toBe('down');
  });

  it('returns null mid-range rather than guessing', () => {
    const candles = bars([
      { high: 12, low: 8 },
      { high: 12, low: 8 },
      { high: 12, low: 8 },
    ]);
    candles[2]!.close = 10;
    expect(microStructure(candles, 2, 2)).toBeNull();
  });

  it('returns null without enough bars', () => {
    expect(microStructure(bars([{ high: 1, low: 0 }]), 0, 5)).toBeNull();
  });
});

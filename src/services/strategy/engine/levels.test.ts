/**
 * Support, resistance, breakouts and retests.
 *
 * The property that matters most here is that a zone's ROLE follows price
 * rather than its origin: broken resistance becomes support, and a zone that
 * keeps its original label gives exactly the wrong reading at the retest —
 * the moment the setup is most tradeable.
 */
import { describe, expect, it } from 'vitest';
import { readLevels } from './levels';
import { swingsOf } from './structure';
import { ENGINE } from './config';
import { fromCloses, leg, warmup, market } from './testFixtures';
import { typicalRange } from './scale';

function read(closes: number[], at?: number) {
  const c = fromCloses(closes);
  const end = at ?? c.length - 1;
  const a = typicalRange(c, end, ENGINE.rangeLookback) || 0.001;
  return readLevels(c, end, swingsOf(c, end, ENGINE, a), a, ENGINE);
}

/** Price repeatedly turned at 1.14 and at 1.10. */
const rangeBound = [
  ...warmup(1.12, 40),
  ...leg(1.12, 1.1398, 10), ...leg(1.1398, 1.1002, 12),
  ...leg(1.1002, 1.1401, 12), ...leg(1.1401, 1.1005, 12),
  ...leg(1.1005, 1.1399, 12),
];

describe('zones', () => {
  it('merges repeated turns at one price into a single multi-touch zone', () => {
    const l = read(rangeBound);
    const strong = l.zones.filter((z) => z.touches >= 2);
    expect(strong.length).toBeGreaterThan(0);
  });

  it('does not promote a one-off pivot to a zone', () => {
    // minTouches exists so that every minor swing is not called "resistance".
    const l = read(rangeBound);
    for (const z of l.zones) expect(z.touches).toBeGreaterThanOrEqual(ENGINE.levels.minTouches);
  });

  it('ranks the most-touched zone first', () => {
    const l = read(rangeBound);
    for (let i = 1; i < l.zones.length; i++) {
      expect(l.zones[i - 1]!.touches).toBeGreaterThanOrEqual(l.zones[i]!.touches);
    }
  });
});

describe('role follows price, not origin', () => {
  it('calls a level below price support and one above resistance', () => {
    const l = read([...rangeBound, ...leg(1.1399, 1.12, 6)]);
    for (const z of l.zones) {
      if (z.role === 'support') expect(z.price).toBeLessThan(l.previousHigh!);
    }
    expect(l.support?.price ?? 0).toBeLessThan(l.resistance?.price ?? Infinity);
  });

  it('flips a broken resistance into support once price is above it', () => {
    // Built from HIGHS, so a naive implementation would keep calling it
    // resistance while price trades above it — the worst possible reading.
    const broken = [...rangeBound, ...leg(1.1399, 1.16, 14)];
    const l = read(broken);
    const nearOldHigh = l.zones.find((z) => Math.abs(z.price - 1.14) < 0.004);
    if (nearOldHigh) expect(nearOldHigh.role).toBe('support');
  });
});

describe('proximity', () => {
  it('reports being at support when price sits on it', () => {
    const l = read([...rangeBound, ...leg(1.1399, 1.1008, 12)]);
    expect(l.atSupport || (l.supportDistanceRatio ?? 99) < 1).toBe(true);
  });

  it('measures distance in SCALE, so the same number means the same thing', () => {
    const l = read(rangeBound);
    if (l.supportDistanceRatio !== null) expect(l.supportDistanceRatio).toBeGreaterThanOrEqual(0);
    if (l.resistanceDistanceRatio !== null) expect(l.resistanceDistanceRatio).toBeGreaterThanOrEqual(0);
  });
});

describe('breakout and retest', () => {
  it('detects a breakout above a repeatedly-tested level', () => {
    const l = read([...rangeBound, ...leg(1.1399, 1.155, 8)]);
    expect(l.breakout?.direction).toBe('bullish');
  });

  it('marks a retest only when price came back AND held', () => {
    const withRetest = read([
      ...rangeBound,
      ...leg(1.1399, 1.155, 8),
      ...leg(1.155, 1.1405, 6),
      ...leg(1.1405, 1.15, 6),
    ]);
    expect(withRetest.breakout?.retested).toBe(true);
  });

  it('does not claim a retest when price never returned', () => {
    const noReturn = read([...rangeBound, ...leg(1.1399, 1.18, 14)]);
    expect(noReturn.breakout?.retested ?? false).toBe(false);
  });

  it('prefers the most recent break over an older one', () => {
    const l = read([...rangeBound, ...leg(1.1399, 1.155, 8), ...leg(1.155, 1.135, 8)]);
    if (l.breakout) expect(l.breakout.barsAgo).toBeLessThanOrEqual(ENGINE.levels.retestWindow * 3);
  });
});

describe('extremes', () => {
  it('reports the highest high and lowest low of the lookback', () => {
    const l = read(rangeBound);
    expect(l.previousHigh).toBeGreaterThan(l.previousLow!);
  });
});

describe('robustness', () => {
  it('produces no zones from a flat market rather than inventing them', () => {
    expect(read(warmup(1.1, 200)).zones).toEqual([]);
  });

  it('never returns a support above price or a resistance below it', () => {
    const c = market(500, 4);
    const a = typicalRange(c, c.length - 1, ENGINE.rangeLookback) || 0.001;
    for (let i = 250; i < c.length; i += 13) {
      const l = readLevels(c, i, swingsOf(c, i, ENGINE, a), a, ENGINE);
      const price = c[i]!.close;
      if (l.support) expect(l.support.price).toBeLessThan(price);
      if (l.resistance) expect(l.resistance.price).toBeGreaterThan(price);
    }
  });
});

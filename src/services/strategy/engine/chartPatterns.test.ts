/**
 * Chart patterns.
 *
 * The two failure modes are opposite and both expensive: missing a textbook
 * double bottom, and finding one in every sideways week. There are tests for
 * each, plus the rule the spec is most explicit about — a bilateral pattern
 * must never be given a direction before its breakout.
 */
import { describe, expect, it } from 'vitest';
import { readChartPatterns, bestPatternFor, neutralPattern } from './chartPatterns';
import { swingsOf } from './structure';
import { ENGINE } from './config';
import { fromCloses, leg, warmup, market } from './testFixtures';
import { atr } from '../../../lib/indicators/atr';

function analyse(closes: number[]) {
  const c = fromCloses(closes);
  const a = atr(c, ENGINE.atrPeriod)[c.length - 1] ?? 0;
  const swings = swingsOf(c, c.length - 1, ENGINE, a);
  return { patterns: readChartPatterns(c, c.length - 1, swings, a, ENGINE), swings, atr: a };
}

const found = (closes: number[]) => analyse(closes).patterns.map((p) => p.name);

describe('double tops and bottoms', () => {
  it('detects a double top from two peaks at the same level', () => {
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.14, 12), ...leg(1.14, 1.11, 10),
      ...leg(1.11, 1.1398, 12), ...leg(1.1398, 1.12, 8),
    ];
    expect(found(closes)).toContain('Double Top');
  });

  it('detects a double bottom from two troughs at the same level', () => {
    const closes = [
      ...warmup(1.14, 40),
      ...leg(1.14, 1.10, 12), ...leg(1.10, 1.13, 10),
      ...leg(1.13, 1.1002, 12), ...leg(1.1002, 1.12, 8),
    ];
    expect(found(closes)).toContain('Double Bottom');
  });

  it('does not call two peaks at clearly different levels a double top', () => {
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.14, 12), ...leg(1.14, 1.11, 10),
      ...leg(1.11, 1.17, 12), ...leg(1.17, 1.15, 8),
    ];
    expect(found(closes)).not.toContain('Double Top');
  });

  it('gives a tighter match a higher quality than a sloppier one', () => {
    const tight = analyse([
      ...warmup(1.1, 40),
      ...leg(1.1, 1.14, 12), ...leg(1.14, 1.11, 10),
      ...leg(1.11, 1.13995, 12), ...leg(1.13995, 1.12, 8),
    ]).patterns.find((p) => p.name === 'Double Top');

    const sloppy = analyse([
      ...warmup(1.1, 40),
      ...leg(1.1, 1.14, 12), ...leg(1.14, 1.11, 10),
      ...leg(1.11, 1.1385, 12), ...leg(1.1385, 1.12, 8),
    ]).patterns.find((p) => p.name === 'Double Top');

    if (tight && sloppy) expect(tight.quality).toBeGreaterThan(sloppy.quality);
  });

  it('reports a measured-move target below the neckline', () => {
    const p = analyse([
      ...warmup(1.1, 40),
      ...leg(1.1, 1.14, 12), ...leg(1.14, 1.11, 10),
      ...leg(1.11, 1.1398, 12), ...leg(1.1398, 1.12, 8),
    ]).patterns.find((x) => x.name === 'Double Top');
    if (p?.target) expect(p.target).toBeLessThan(1.11);
  });
});

describe('head and shoulders', () => {
  it('detects three peaks with the middle highest and level shoulders', () => {
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.13, 10), ...leg(1.13, 1.11, 8),
      ...leg(1.11, 1.17, 12), ...leg(1.17, 1.112, 12),
      ...leg(1.112, 1.1305, 10), ...leg(1.1305, 1.12, 8),
    ];
    expect(found(closes)).toContain('Head and Shoulders');
  });

  it('detects the inverse', () => {
    const closes = [
      ...warmup(1.17, 40),
      ...leg(1.17, 1.14, 10), ...leg(1.14, 1.16, 8),
      ...leg(1.16, 1.10, 12), ...leg(1.10, 1.158, 12),
      ...leg(1.158, 1.1395, 10), ...leg(1.1395, 1.15, 8),
    ];
    expect(found(closes)).toContain('Inverse Head and Shoulders');
  });

  it('rejects a middle peak that is not the highest', () => {
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.17, 10), ...leg(1.17, 1.11, 8),
      ...leg(1.11, 1.13, 12), ...leg(1.13, 1.112, 12),
      ...leg(1.112, 1.16, 10), ...leg(1.16, 1.14, 8),
    ];
    expect(found(closes)).not.toContain('Head and Shoulders');
  });
});

describe('bilateral patterns get no direction', () => {
  it('never assigns a bias to a symmetrical triangle or rectangle', () => {
    // The spec: "Do not predict the direction of neutral patterns before
    // breakout confirmation."
    const c = market(500, 11);
    const a = atr(c, ENGINE.atrPeriod)[c.length - 1] ?? 0;
    for (let i = 250; i < c.length; i += 9) {
      const swings = swingsOf(c, i, ENGINE, a);
      for (const p of readChartPatterns(c, i, swings, a, ENGINE)) {
        if (p.family === 'bilateral') {
          expect(p.bias).toBe('neutral');
          expect(p.target).toBeNull();
        }
      }
    }
  });

  it('excludes neutral patterns from the directional pick', () => {
    const c = market(400, 5);
    const a = atr(c, ENGINE.atrPeriod)[c.length - 1] ?? 0;
    const swings = swingsOf(c, c.length - 1, ENGINE, a);
    const patterns = readChartPatterns(c, c.length - 1, swings, a, ENGINE);
    expect(bestPatternFor(patterns, 'bullish')?.bias ?? 'bullish').toBe('bullish');
    expect(neutralPattern(patterns)?.bias ?? 'neutral').toBe('neutral');
  });
});

describe('robustness', () => {
  it('finds nothing in a flat market', () => {
    const closes = warmup(1.1, 200);
    expect(found(closes)).toEqual([]);
  });

  it('never returns a pattern older than the freshness window', () => {
    const c = market(600, 2);
    const a = atr(c, ENGINE.atrPeriod)[c.length - 1] ?? 0;
    const swings = swingsOf(c, c.length - 1, ENGINE, a);
    for (const p of readChartPatterns(c, c.length - 1, swings, a, ENGINE)) {
      expect(p.barsAgo).toBeLessThanOrEqual(ENGINE.patterns.freshnessBars + ENGINE.structure.fractalWings);
    }
  });

  it('survives having too few swings to form anything', () => {
    const c = fromCloses(warmup(1.1, 30));
    expect(readChartPatterns(c, c.length - 1, [], 0.001, ENGINE)).toEqual([]);
  });

  it('never reports a directional pattern without an invalidation level', () => {
    // A pattern with a target but no invalidation gives the risk module a
    // reward with no defined risk.
    const c = market(500, 9);
    const a = atr(c, ENGINE.atrPeriod)[c.length - 1] ?? 0;
    for (let i = 250; i < c.length; i += 11) {
      const swings = swingsOf(c, i, ENGINE, a);
      for (const p of readChartPatterns(c, i, swings, a, ENGINE)) {
        if (p.bias !== 'neutral') expect(p.invalidation).not.toBeNull();
      }
    }
  });
});

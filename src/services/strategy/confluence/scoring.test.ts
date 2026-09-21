import { describe, expect, it } from 'vitest';
import { CONFLUENCE_STRATEGY } from '../../../config/confluence';
import { gradeSignal, isActionable, scoreSetup, type GateInput, type ScoreInput } from './scoring';

const W = CONFLUENCE_STRATEGY.weights;
const T = CONFLUENCE_STRATEGY.thresholds;

const base: ScoreInput = {
  direction: 'long',
  trendAligned: false,
  cloudAligned: false,
  tenkanKijunAligned: false,
  chikouFree: null,
  structureAligned: false,
  structureOpposed: false,
  zoneRank: 0,
  cloudBacked: false,
  pullbackQuality: 0,
  confirmed: false,
  higherTimeframe: null,
  mixedConditions: false,
  overextended: false,
  choppy: false,
  thinCloud: false,
};

const perfect: ScoreInput = {
  ...base,
  trendAligned: true,
  cloudAligned: true,
  tenkanKijunAligned: true,
  chikouFree: true,
  structureAligned: true,
  zoneRank: 3,
  cloudBacked: true,
  pullbackQuality: 1,
  confirmed: true,
  higherTimeframe: 'long',
};

describe('scoreSetup — attribution', () => {
  it('every point is attributable: reasons sum to the raw score', () => {
    const r = scoreSetup(perfect, W);
    const ungrouped = r.reasons.filter((x) => x.group === null).reduce((s, x) => s + x.points, 0);
    const grouped = r.reasons.filter((x) => x.group !== null).reduce((s, x) => s + x.points, 0);
    // Raw is the ungrouped sum plus the CAPPED group total.
    expect(r.raw).toBe(ungrouped + Math.min(grouped, W.maxGroupContribution));
  });

  it('produces no reasons, and zero confidence, when nothing is aligned', () => {
    const r = scoreSetup(base, W);
    expect(r.reasons).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('never exceeds 100 even with every positive at maximum', () => {
    const r = scoreSetup(perfect, W);
    expect(r.confidence).toBeLessThanOrEqual(100);
    expect(r.confidence).toBeGreaterThan(90);
  });

  it('floors at 0 rather than going negative', () => {
    const awful: ScoreInput = { ...base, mixedConditions: true, overextended: true, choppy: true, structureOpposed: true };
    expect(scoreSetup(awful, W).confidence).toBe(0);
  });
});

describe('scoreSetup — correlated conditions do not stack', () => {
  it('caps the trend group however many of its members agree', () => {
    const one = scoreSetup({ ...base, trendAligned: true }, W);
    const all = scoreSetup({ ...base, trendAligned: true, cloudAligned: true, tenkanKijunAligned: true }, W);

    const rawGroupSum = W.trendAlignment + W.cloudAlignment + W.tenkanKijun;
    expect(rawGroupSum).toBeGreaterThan(W.maxGroupContribution);
    expect(all.raw).toBe(W.maxGroupContribution);
    expect(all.raw).toBeLessThan(rawGroupSum);
    expect(all.raw).toBeGreaterThan(one.raw);
  });

  it('still lists all three reasons, so the cap is visible not hidden', () => {
    const all = scoreSetup({ ...base, trendAligned: true, cloudAligned: true, tenkanKijunAligned: true }, W);
    expect(all.reasons.map((r) => r.key).sort()).toEqual(['cloud', 'tenkanKijun', 'trend']);
  });

  it('does not cap independent evidence', () => {
    const independent = scoreSetup({ ...base, structureAligned: true, confirmed: true, chikouFree: true }, W);
    expect(independent.raw).toBe(W.marketStructure + W.entryConfirmation + W.chikouFree);
  });

  it('three correlated conditions score below three independent ones', () => {
    const correlated = scoreSetup({ ...base, trendAligned: true, cloudAligned: true, tenkanKijunAligned: true }, W);
    const independent = scoreSetup({ ...base, structureAligned: true, confirmed: true, chikouFree: true }, W);
    expect(correlated.confidence).toBeLessThan(independent.confidence);
  });
});

describe('scoreSetup — symmetry', () => {
  it('scores a short exactly as it scores the mirrored long', () => {
    const long = scoreSetup({ ...perfect, direction: 'long', higherTimeframe: 'long' }, W);
    const short = scoreSetup({ ...perfect, direction: 'short', higherTimeframe: 'short' }, W);
    expect(short.confidence).toBe(long.confidence);
    expect(short.raw).toBe(long.raw);
  });

  it('penalises a conflicting higher timeframe in both directions equally', () => {
    const long = scoreSetup({ ...perfect, direction: 'long', higherTimeframe: 'short' }, W);
    const short = scoreSetup({ ...perfect, direction: 'short', higherTimeframe: 'long' }, W);
    expect(short.confidence).toBe(long.confidence);
    expect(long.reasons.some((r) => r.key === 'htfConflict')).toBe(true);
  });
});

describe('scoreSetup — graded inputs', () => {
  it('scales the zone contribution by its grade', () => {
    const weak = scoreSetup({ ...base, zoneRank: 1 }, W).raw;
    const moderate = scoreSetup({ ...base, zoneRank: 2 }, W).raw;
    const strong = scoreSetup({ ...base, zoneRank: 3 }, W).raw;
    expect(weak).toBeLessThan(moderate);
    expect(moderate).toBeLessThan(strong);
    expect(strong).toBe(W.emaKijunConfluence);
  });

  it('scales the pullback contribution by quality', () => {
    const poor = scoreSetup({ ...base, pullbackQuality: 0.25 }, W).raw;
    const good = scoreSetup({ ...base, pullbackQuality: 1 }, W).raw;
    expect(poor).toBeLessThan(good);
    expect(good).toBe(W.pullbackQuality);
  });
});

describe('gradeSignal', () => {
  const gates: GateInput = {
    confidence: 90,
    direction: 'long',
    trendStrength: 1,
    zoneRank: 3,
    pullbackQuality: 1,
    confirmed: true,
    blocked: false,
  };

  it('returns NO_TRADE when blocked, whatever the score', () => {
    expect(gradeSignal({ ...gates, blocked: true }, T)).toBe('NO_TRADE');
  });

  it('returns NEUTRAL below the watch threshold', () => {
    expect(gradeSignal({ ...gates, confidence: T.watch - 1 }, T)).toBe('NEUTRAL');
  });

  it('a high score cannot buy its way past a missing confirmation', () => {
    expect(gradeSignal({ ...gates, confidence: 99, confirmed: false }, T)).toBe('WATCH_LONG');
  });

  it('downgrades to WATCH, not NEUTRAL, when a gate fails — the setup is still real', () => {
    expect(gradeSignal({ ...gates, zoneRank: 0 }, T)).toBe('WATCH_LONG');
    expect(gradeSignal({ ...gates, direction: 'short', zoneRank: 0 }, T)).toBe('WATCH_SHORT');
  });

  it('grades the confidence bands', () => {
    expect(gradeSignal({ ...gates, confidence: T.strong }, T)).toBe('STRONG_LONG');
    expect(gradeSignal({ ...gates, confidence: T.actionable }, T)).toBe('LONG');
    expect(gradeSignal({ ...gates, confidence: T.watch }, T)).toBe('WATCH_LONG');
  });

  it('is symmetric for shorts', () => {
    expect(gradeSignal({ ...gates, direction: 'short', confidence: T.strong }, T)).toBe('STRONG_SHORT');
    expect(gradeSignal({ ...gates, direction: 'short', confidence: T.actionable }, T)).toBe('SHORT');
  });

  it('blocks on weak trend strength and on a poor pullback', () => {
    expect(gradeSignal({ ...gates, trendStrength: 0 }, T)).toBe('WATCH_LONG');
    expect(gradeSignal({ ...gates, pullbackQuality: 0 }, T)).toBe('WATCH_LONG');
  });
});

describe('isActionable', () => {
  it('counts only the tradeable grades', () => {
    expect(['LONG', 'SHORT', 'STRONG_LONG', 'STRONG_SHORT'].every(isActionable as (s: string) => boolean)).toBe(true);
    expect(['WATCH_LONG', 'WATCH_SHORT', 'NEUTRAL', 'NO_TRADE'].some(isActionable as (s: string) => boolean)).toBe(false);
  });
});

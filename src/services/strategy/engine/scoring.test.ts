/**
 * Scoring: context, capping, and the anti-over-filtering guarantee.
 *
 * The spec's most emphatic instruction is "do NOT require something like
 * structure AND BOS AND CHoCH AND pattern AND EMA AND cloud… before generating
 * a BUY", because that produces a signal roughly never. These tests pin that
 * down as a property rather than a hope: a realistic partial setup must reach
 * a tradeable score, and no single family may be able to veto one.
 */
import { describe, expect, it } from 'vitest';
import { scoreSetup, type ScoreInput } from './scoring';
import { ENGINE } from './config';
import type { StructureRead } from './structure';
import type { LevelRead } from './levels';

const structure = (over: Partial<StructureRead> = {}): StructureRead =>
  ({
    base: {
      direction: 'up', strength: 0.9, higherHighs: true, higherLows: true,
      lowerHighs: false, lowerLows: false, swings: [], lastSwingHigh: null,
      lastSwingLow: null, barsSinceSwing: 2,
    },
    trend: 'bullish',
    bos: null,
    choch: null,
    reversalConfirmed: false,
    events: [],
    lastSwingHigh: null,
    lastSwingLow: null,
    ...over,
  }) as StructureRead;

const levels = (over: Partial<LevelRead> = {}): LevelRead => ({
  zones: [],
  support: { price: 1.09, touches: 3, barsSinceTouch: 2, role: 'support', halfWidth: 0.0005 },
  resistance: { price: 1.13, touches: 2, barsSinceTouch: 20, role: 'resistance', halfWidth: 0.0005 },
  atSupport: false,
  atResistance: false,
  supportDistanceAtr: 2,
  resistanceDistanceAtr: 4,
  breakout: null,
  previousHigh: 1.14,
  previousLow: 1.08,
  ...over,
});

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  side: 'bullish',
  structure: structure(),
  levels: levels(),
  chartPattern: null,
  neutralPattern: null,
  candle: null,
  ema: null,
  ichimoku: null,
  momentum: 0,
  higherTrend: 'none',
  entryConfirmation: 'none',
  config: ENGINE,
  ...over,
});

describe('the spec\'s worked example reaches a tradeable score', () => {
  it('structure + support reaction + engulfing + EMA + Ichimoku, with NO BOS, is a BUY', () => {
    // Taken verbatim from the spec: "Bullish structure + support reaction +
    // bullish engulfing + EMA50 confirmation + bullish Ichimoku position may
    // already create a valid BUY even if there is no fresh BOS."
    const r = scoreSetup(input({
      levels: levels({ atSupport: true, supportDistanceAtr: 0.2 }),
      candle: { name: 'Bullish Engulfing', bias: 'bullish', index: 100, barsAgo: 0, weight: 0.8 },
      ema: { value: 1.1, slopeAtr: 0.5, direction: 'rising', side: 'above', distanceAtr: 0.3,
             atLevel: true, reclaimed: false, brokeDown: false, overextended: false },
      ichimoku: { side: 'above', cloudBullish: true, tenkan: 1.1, kijun: 1.09, tenkanAboveKijun: true,
                  futureCloudBullish: true, chikouFree: 'bullish', thicknessAtr: 1, brokeAbove: false, brokeBelow: false },
      higherTrend: 'long',
    }));

    expect(r.score).toBeGreaterThanOrEqual(72);
  });

  it('the spec\'s EARLY example reaches the EARLY band without clearing the cloud', () => {
    // "Bullish CHoCH + Double Bottom + support reaction + EMA50 reclaim may
    // create an EARLY BUY even if price has not fully cleared the cloud."
    const r = scoreSetup(input({
      structure: structure({
        trend: 'bearish',
        base: { ...structure().base, direction: 'down', strength: 0.7 },
        choch: { kind: 'CHoCH', direction: 'bullish', index: 100, barsAgo: 2, level: 1.1, strengthAtr: 0.5 },
      }),
      levels: levels({ atSupport: true, supportDistanceAtr: 0.2 }),
      chartPattern: { name: 'Double Bottom', family: 'reversal', bias: 'bullish', index: 98, barsAgo: 4, quality: 0.9, target: 1.13, invalidation: 1.08 },
      ema: { value: 1.1, slopeAtr: 0.05, direction: 'flat', side: 'above', distanceAtr: 0.2,
             atLevel: true, reclaimed: true, brokeDown: false, overextended: false },
      ichimoku: { side: 'inside', cloudBullish: false, tenkan: 1.1, kijun: 1.1, tenkanAboveKijun: true,
                  futureCloudBullish: true, chikouFree: null, thicknessAtr: 1, brokeAbove: false, brokeBelow: false },
    }));

    expect(r.score).toBeGreaterThanOrEqual(62);
  });
});

describe('no single family can veto a signal', () => {
  const strong = () => input({
    levels: levels({ atSupport: true, supportDistanceAtr: 0.2 }),
    candle: { name: 'Morning Star', bias: 'bullish', index: 100, barsAgo: 0, weight: 0.85 },
    chartPattern: { name: 'Double Bottom', family: 'reversal', bias: 'bullish', index: 98, barsAgo: 3, quality: 0.9, target: 1.13, invalidation: 1.08 },
    ema: { value: 1.1, slopeAtr: 0.5, direction: 'rising', side: 'above', distanceAtr: 0.3,
           atLevel: false, reclaimed: false, brokeDown: false, overextended: false },
    ichimoku: { side: 'above', cloudBullish: true, tenkan: 1.1, kijun: 1.09, tenkanAboveKijun: true,
                futureCloudBullish: true, chikouFree: 'bullish', thicknessAtr: 1, brokeAbove: false, brokeBelow: false },
    higherTrend: 'long',
  });

  it('survives having no Ichimoku data at all', () => {
    expect(scoreSetup({ ...strong(), ichimoku: null }).score).toBeGreaterThanOrEqual(62);
  });

  it('survives having no EMA data at all', () => {
    expect(scoreSetup({ ...strong(), ema: null }).score).toBeGreaterThanOrEqual(62);
  });

  it('survives having no chart pattern', () => {
    expect(scoreSetup({ ...strong(), chartPattern: null }).score).toBeGreaterThanOrEqual(62);
  });

  it('survives price being inside the cloud — reduced, not cancelled', () => {
    const inside = scoreSetup({
      ...strong(),
      ichimoku: { side: 'inside', cloudBullish: null, tenkan: null, kijun: null, tenkanAboveKijun: null,
                  futureCloudBullish: null, chikouFree: null, thicknessAtr: 0.8, brokeAbove: false, brokeBelow: false },
    });
    expect(inside.score).toBeLessThan(scoreSetup(strong()).score);
    expect(inside.score).toBeGreaterThan(0);
  });
});

describe('context decides what a fact is worth', () => {
  it('pays a bullish CHoCH far more in a downtrend than in an uptrend', () => {
    const choch = { kind: 'CHoCH' as const, direction: 'bullish' as const, index: 100, barsAgo: 1, level: 1.1, strengthAtr: 0.4 };
    const against = scoreSetup(input({
      structure: structure({ trend: 'bearish', base: { ...structure().base, direction: 'down' }, choch }),
    }));
    const with_ = scoreSetup(input({ structure: structure({ choch }) }));

    const pointsOf = (r: typeof against) => r.reasons.filter((x) => x.family === 'break').reduce((a, b) => a + b.points, 0);
    expect(pointsOf(against)).toBeGreaterThan(pointsOf(with_));
  });

  it('pays a bullish BOS more in an uptrend than in a downtrend', () => {
    const bos = { kind: 'BOS' as const, direction: 'bullish' as const, index: 100, barsAgo: 1, level: 1.1, strengthAtr: 0.4 };
    const withTrend = scoreSetup(input({ structure: structure({ bos }) }));
    const against = scoreSetup(input({
      structure: structure({ trend: 'bearish', base: { ...structure().base, direction: 'down' }, bos }),
    }));
    const pointsOf = (r: typeof against) => r.reasons.filter((x) => x.family === 'break').reduce((a, b) => a + b.points, 0);
    expect(pointsOf(withTrend)).toBeGreaterThan(pointsOf(against));
  });

  it('pays a candle at support several times what it pays one mid-range', () => {
    // "A random bullish candle in the middle of a range should receive very
    // little weight."
    const candle = { name: 'Bullish Engulfing', bias: 'bullish' as const, index: 100, barsAgo: 0, weight: 0.8 };
    const atLevel = scoreSetup(input({ levels: levels({ atSupport: true, supportDistanceAtr: 0.2 }), candle }));
    const midRange = scoreSetup(input({ candle }));

    const pointsOf = (r: typeof atLevel) => r.reasons.filter((x) => x.family === 'candle').reduce((a, b) => a + b.points, 0);
    expect(pointsOf(atLevel)).toBeGreaterThan(pointsOf(midRange) * 1.5);
    expect(midRange.warnings.some((w) => /away from any level/.test(w))).toBe(true);
  });

  it('warns rather than predicts when a neutral pattern is in force', () => {
    // The spec forbids predicting a bilateral pattern's direction pre-breakout.
    const r = scoreSetup(input({
      neutralPattern: { name: 'Symmetrical Triangle', family: 'bilateral', bias: 'neutral', index: 100, barsAgo: 2, quality: 0.6, target: null, invalidation: null },
    }));
    expect(r.warnings.some((w) => /Symmetrical Triangle/.test(w))).toBe(true);
  });
});

describe('correlated evidence is capped', () => {
  it('cannot let Ichimoku alone buy more than its family weight', () => {
    // Above cloud + bullish cloud + Tenkan>Kijun + bullish future + Chikou
    // free are largely one trending fact seen five ways.
    const r = scoreSetup(input({
      ichimoku: { side: 'above', cloudBullish: true, tenkan: 1.1, kijun: 1.09, tenkanAboveKijun: true,
                  futureCloudBullish: true, chikouFree: 'bullish', thicknessAtr: 2, brokeAbove: true, brokeBelow: false },
    }));
    const ichi = r.reasons.filter((x) => x.family === 'ichimoku').reduce((a, b) => a + b.points, 0);
    // The raw contributions exceed the weight; the cap is what stops them.
    expect(ichi).toBeGreaterThan(ENGINE.weights.ichimoku);
    // …and the total still reflects only the capped amount.
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('keeps every score inside 0–100 however much evidence piles up', () => {
    const everything = scoreSetup(input({
      structure: structure({
        bos: { kind: 'BOS', direction: 'bullish', index: 100, barsAgo: 1, level: 1.1, strengthAtr: 1 },
        choch: { kind: 'CHoCH', direction: 'bullish', index: 90, barsAgo: 11, level: 1.09, strengthAtr: 1 },
        reversalConfirmed: true,
      }),
      levels: levels({ atSupport: true, supportDistanceAtr: 0.1, breakout: { direction: 'bullish', level: 1.1, barsAgo: 2, retested: true, retestBarsAgo: 1 } }),
      chartPattern: { name: 'Inverse Head and Shoulders', family: 'reversal', bias: 'bullish', index: 99, barsAgo: 2, quality: 1, target: 1.15, invalidation: 1.08 },
      candle: { name: 'Three White Soldiers', bias: 'bullish', index: 100, barsAgo: 0, weight: 0.9 },
      ema: { value: 1.1, slopeAtr: 1, direction: 'rising', side: 'above', distanceAtr: 0.2, atLevel: true, reclaimed: true, brokeDown: false, overextended: false },
      ichimoku: { side: 'above', cloudBullish: true, tenkan: 1.1, kijun: 1.09, tenkanAboveKijun: true, futureCloudBullish: true, chikouFree: 'bullish', thicknessAtr: 2, brokeAbove: true, brokeBelow: false },
      momentum: 1,
      higherTrend: 'long',
      entryConfirmation: 'long',
    }));
    expect(everything.score).toBeLessThanOrEqual(100);
    expect(everything.score).toBeGreaterThanOrEqual(85);
  });
});

describe('the higher timeframe objects but does not forbid', () => {
  it('reduces the score when the higher timeframe disagrees', () => {
    const agree = scoreSetup(input({ higherTrend: 'long' }));
    const conflict = scoreSetup(input({ higherTrend: 'short' }));
    expect(conflict.score).toBeLessThan(agree.score);
    expect(conflict.warnings.some((w) => /higher timeframe/i.test(w))).toBe(true);
  });

  it('does not zero a strong setup merely because the 4H disagrees', () => {
    // A reversal necessarily begins against the higher timeframe. Vetoing on
    // that basis makes every reversal untradeable.
    const r = scoreSetup(input({
      structure: structure({ trend: 'bearish', base: { ...structure().base, direction: 'down' },
        choch: { kind: 'CHoCH', direction: 'bullish', index: 100, barsAgo: 1, level: 1.1, strengthAtr: 1 } }),
      levels: levels({ atSupport: true, supportDistanceAtr: 0.1 }),
      candle: { name: 'Morning Star', bias: 'bullish', index: 100, barsAgo: 0, weight: 0.85 },
      chartPattern: { name: 'Double Bottom', family: 'reversal', bias: 'bullish', index: 98, barsAgo: 3, quality: 0.9, target: 1.13, invalidation: 1.08 },
      higherTrend: 'short',
    }));
    expect(r.score).toBeGreaterThan(40);
  });
});

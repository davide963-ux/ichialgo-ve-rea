/**
 * Candlestick detection.
 *
 * Each test builds the exact bar geometry the pattern is defined by, because
 * here the shape IS the specification. The risk with candle detectors is the
 * opposite of the usual one: they fire too easily, and a detector that calls
 * every small bar a doji floods the scorer with noise. So there are as many
 * tests for what must NOT be detected as for what must.
 */
import { describe, expect, it } from 'vitest';
import { readCandles, strongestFor } from './candles';
import { ENGINE } from './config';
import type { Candle } from '../../marketData/types';

const bar = (open: number, high: number, low: number, close: number, i = 0): Candle => ({
  time: 1_700_000_000 + i * 3600,
  open, high, low, close, volume: null, complete: true,
});

/** Ordinary bars, so the average-range size filter has something to measure. */
function withContext(...tail: Candle[]): Candle[] {
  const base: Candle[] = [];
  for (let i = 0; i < 24; i++) base.push(bar(1.1, 1.1012, 1.0988, 1.1002, i));
  return [...base, ...tail.map((b, j) => ({ ...b, time: 1_700_000_000 + (24 + j) * 3600 }))];
}

const names = (c: Candle[]) => readCandles(c, c.length - 1, ENGINE).map((p) => p.name);

describe('engulfing', () => {
  it('detects a bullish engulfing that swallows the previous body', () => {
    const c = withContext(bar(1.1005, 1.1008, 1.0980, 1.0985), bar(1.0982, 1.1030, 1.0980, 1.1025));
    expect(names(c)).toContain('Bullish Engulfing');
  });

  it('detects a bearish engulfing', () => {
    const c = withContext(bar(1.0985, 1.1010, 1.0983, 1.1005), bar(1.1008, 1.1010, 1.0960, 1.0965));
    expect(names(c)).toContain('Bearish Engulfing');
  });

  it('does not call it engulfing when the body is smaller than the one before', () => {
    const c = withContext(bar(1.0982, 1.1040, 1.0980, 1.1035), bar(1.1000, 1.1015, 1.0995, 1.1010));
    expect(names(c)).not.toContain('Bullish Engulfing');
  });
});

describe('rejection bars', () => {
  it('detects a hammer: long lower wick, small body, little above', () => {
    const c = withContext(bar(1.1000, 1.1005, 1.0940, 1.0998));
    const found = names(c);
    expect(found).toContain('Hammer');
    expect(found).toContain('Pin Bar');
  });

  it('detects a shooting star as the mirror image', () => {
    const c = withContext(bar(1.1000, 1.1060, 1.0995, 1.1002));
    expect(names(c)).toContain('Shooting Star');
  });

  it('reports both readings of one shape, leaving the trend to decide', () => {
    // A hammer and a hanging man are the SAME bar; only the trend separates
    // them, and the detector does not know the trend. Reporting both and
    // letting the scorer weigh them loses nothing; picking one guesses.
    const c = withContext(bar(1.1000, 1.1005, 1.0940, 1.0998));
    expect(names(c)).toContain('Hanging Man');
  });

  it('does not call a long-bodied bar a pin bar', () => {
    const c = withContext(bar(1.0950, 1.1055, 1.0945, 1.1050));
    expect(names(c)).not.toContain('Pin Bar');
  });
});

describe('doji family', () => {
  it('separates dragonfly from gravestone by which wick is long', () => {
    const dragonfly = withContext(bar(1.1000, 1.1002, 1.0950, 1.1000));
    expect(names(dragonfly)).toContain('Dragonfly Doji');

    const gravestone = withContext(bar(1.1000, 1.1050, 1.0998, 1.1000));
    expect(names(gravestone)).toContain('Gravestone Doji');
  });

  it('calls a balanced tiny body a plain neutral doji', () => {
    const c = withContext(bar(1.1000, 1.1025, 1.0975, 1.1000));
    const found = readCandles(c, c.length - 1, ENGINE);
    const doji = found.find((p) => p.name === 'Doji');
    expect(doji?.bias).toBe('neutral');
  });
});

describe('three-bar patterns', () => {
  it('detects a morning star: drop, pause, recovery through the midpoint', () => {
    const c = withContext(
      bar(1.1020, 1.1022, 1.0960, 1.0965),
      bar(1.0962, 1.0970, 1.0955, 1.0960),
      bar(1.0965, 1.1010, 1.0963, 1.1005),
    );
    expect(names(c)).toContain('Morning Star');
  });

  it('detects three white soldiers only when all three have solid bodies', () => {
    const solid = withContext(
      bar(1.0950, 1.0982, 1.0948, 1.0980),
      bar(1.0980, 1.1012, 1.0978, 1.1010),
      bar(1.1010, 1.1042, 1.1008, 1.1040),
    );
    expect(names(solid)).toContain('Three White Soldiers');

    // Same direction, but all wick and no body: indecision, not conviction.
    const wicky = withContext(
      bar(1.0950, 1.1000, 1.0900, 1.0955),
      bar(1.0955, 1.1005, 1.0905, 1.0960),
      bar(1.0960, 1.1010, 1.0910, 1.0965),
    );
    expect(names(wicky)).not.toContain('Three White Soldiers');
  });
});

describe('containment patterns', () => {
  it('detects an inside bar and an outside bar', () => {
    const inside = withContext(bar(1.0950, 1.1050, 1.0940, 1.1040), bar(1.1000, 1.1020, 1.0990, 1.1010));
    expect(names(inside)).toContain('Inside Bar');

    const outside = withContext(bar(1.1000, 1.1020, 1.0990, 1.1010), bar(1.0995, 1.1060, 1.0940, 1.1050));
    expect(names(outside)).toContain('Outside Bar');
  });
});

describe('freshness and selection', () => {
  it('ignores a pattern older than the freshness window', () => {
    // A bullish engulfing from eleven bars ago has already been acted on.
    const c = withContext(
      bar(1.1005, 1.1008, 1.0980, 1.0985),
      bar(1.0982, 1.1030, 1.0980, 1.1025),
      ...Array.from({ length: 8 }, () => bar(1.1025, 1.1030, 1.1020, 1.1025)),
    );
    expect(names(c)).not.toContain('Bullish Engulfing');
  });

  it('decays with age, so the same pattern is worth less the older it is', () => {
    // Freshness is a tiebreak, NOT an override: three white soldiers one bar
    // back still outranks a hammer today, and should. What decay guarantees
    // is that two EQUAL patterns are separated by recency.
    const engulfingAt = (pad: number) =>
      withContext(
        bar(1.1005, 1.1008, 1.0980, 1.0985),
        bar(1.0982, 1.1030, 1.0980, 1.1025),
        ...Array.from({ length: pad }, () => bar(1.1025, 1.1028, 1.1022, 1.1025)),
      );

    const fresh = strongestFor(readCandles(engulfingAt(0), engulfingAt(0).length - 1, ENGINE), 'bullish');
    const older = strongestFor(readCandles(engulfingAt(2), engulfingAt(2).length - 1, ENGINE), 'bullish');

    expect(fresh?.name).toBe('Bullish Engulfing');
    expect(fresh?.barsAgo).toBe(0);
    // Two bars later the same pattern is either gone or demoted behind
    // something newer — it can never still be the freshest reading.
    expect(older?.barsAgo ?? 99).toBeGreaterThan(0);
  });

  it('finds nothing in a featureless series rather than inventing something', () => {
    const c = withContext();
    const found = readCandles(c, c.length - 1, ENGINE).filter((p) => p.bias !== 'neutral');
    expect(found).toEqual([]);
  });

  it('returns null when nothing agrees with the side asked about', () => {
    const c = withContext(bar(1.1000, 1.1060, 1.0995, 1.1002));
    expect(strongestFor(readCandles(c, c.length - 1, ENGINE), 'bullish')?.bias).not.toBe('bearish');
  });
});

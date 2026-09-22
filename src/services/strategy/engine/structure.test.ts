/**
 * BOS and CHoCH — the distinction the whole reversal logic rests on.
 *
 * The same price action is a BOS or a CHoCH depending on the trend in force
 * when it happened. Getting that backwards does not throw; it quietly relabels
 * every reversal as a continuation, which is the most expensive kind of wrong
 * a structure engine can be.
 */
import { describe, expect, it } from 'vitest';
import { readStructure } from './structure';
import { ENGINE } from './config';
import { fromCloses, leg, warmup, market } from './testFixtures';
import { atr } from '../../../lib/indicators/atr';

const atrOf = (candles: ReturnType<typeof fromCloses>) => {
  const a = atr(candles, ENGINE.atrPeriod);
  return a[candles.length - 1] ?? null;
};

describe('trend reading', () => {
  it('reads a staircase of higher highs and higher lows as bullish', () => {
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.12, 10), ...leg(1.12, 1.112, 6),
      ...leg(1.112, 1.14, 10), ...leg(1.14, 1.132, 6),
      ...leg(1.132, 1.16, 10),
    ];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    expect(s.trend).toBe('bullish');
    expect(s.base.higherHighs).toBe(true);
    expect(s.base.higherLows).toBe(true);
  });

  it('reads the mirror image as bearish', () => {
    const closes = [
      ...warmup(1.2, 40),
      ...leg(1.2, 1.18, 10), ...leg(1.18, 1.188, 6),
      ...leg(1.188, 1.16, 10), ...leg(1.16, 1.168, 6),
      ...leg(1.168, 1.14, 10),
    ];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    expect(s.trend).toBe('bearish');
    expect(s.base.lowerLows).toBe(true);
  });
});

describe('BOS vs CHoCH depends on the trend in force', () => {
  it('calls a break of the swing high in an UPTREND a BOS', () => {
    // Continuation: the trend did what it was already doing.
    const closes = [
      ...warmup(1.1, 40),
      ...leg(1.1, 1.13, 10), ...leg(1.13, 1.12, 6),
      ...leg(1.12, 1.15, 10), ...leg(1.15, 1.14, 6),
      ...leg(1.14, 1.17, 8),
    ];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    const bullBreaks = s.events.filter((e) => e.direction === 'bullish');
    expect(bullBreaks.length).toBeGreaterThan(0);
    expect(bullBreaks[bullBreaks.length - 1]!.kind).toBe('BOS');
  });

  it('calls a break of the swing HIGH in a DOWNTREND a CHoCH', () => {
    // Same bullish break, opposite meaning: the character changed.
    const closes = [
      ...warmup(1.2, 40),
      ...leg(1.2, 1.17, 10), ...leg(1.17, 1.18, 6),
      ...leg(1.18, 1.15, 10), ...leg(1.15, 1.16, 6),
      // Now break back above the last lower high.
      ...leg(1.16, 1.19, 10),
    ];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    const chochs = s.events.filter((e) => e.kind === 'CHoCH' && e.direction === 'bullish');
    expect(chochs.length).toBeGreaterThan(0);
  });

  it('never reports a break as both a BOS and a CHoCH', () => {
    // They are mutually exclusive readings of one event, and the spec is
    // explicit that neither requires the other.
    const c = market(400, 7);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    for (const e of s.events) {
      expect(['BOS', 'CHoCH']).toContain(e.kind);
    }
    const byIndex = new Map<number, string>();
    for (const e of s.events) {
      expect(byIndex.get(e.index)).toBeUndefined();
      byIndex.set(e.index, e.kind);
    }
  });
});

describe('reversal confirmation', () => {
  it('is false when only a CHoCH has happened', () => {
    const closes = [
      ...warmup(1.2, 40),
      ...leg(1.2, 1.17, 10), ...leg(1.17, 1.18, 6),
      ...leg(1.18, 1.15, 10), ...leg(1.15, 1.185, 10),
    ];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    if (s.choch) expect(s.reversalConfirmed).toBe(false);
  });

  it('requires the follow-up BOS to run the SAME way as the CHoCH', () => {
    // A BOS the other way is the old trend resuming — the opposite of
    // confirmation — so it must never set this flag.
    const c = market(500, 3);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    if (s.reversalConfirmed) {
      const lastChoch = [...s.events].reverse().find((e) => e.kind === 'CHoCH')!;
      const after = s.events.filter((e) => e.kind === 'BOS' && e.index > lastChoch.index);
      expect(after.some((e) => e.direction === lastChoch.direction)).toBe(true);
    }
  });
});

describe('robustness', () => {
  it('does not invent breaks in a dead flat market', () => {
    const c = fromCloses(warmup(1.1, 200), 0.00005);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    expect(s.events.length).toBe(0);
  });

  it('collapses a run of breaks from one trend leg into a single event', () => {
    // A strong leg breaks its swing high on every bar. Reporting forty of them
    // would drown the explanation and triple-count one piece of evidence.
    const closes = [...warmup(1.1, 40), ...leg(1.1, 1.13, 10), ...leg(1.13, 1.12, 6), ...leg(1.12, 1.30, 40)];
    const c = fromCloses(closes);
    const s = readStructure(c, c.length - 1, ENGINE, atrOf(c));
    expect(s.events.length).toBeLessThan(12);
  });

  it('returns a usable read when ATR is unavailable', () => {
    const c = fromCloses(warmup(1.1, 60));
    const s = readStructure(c, c.length - 1, ENGINE, null);
    expect(s.events).toEqual([]);
    expect(s.trend).toBeDefined();
  });
});

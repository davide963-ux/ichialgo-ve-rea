/**
 * Entry, stop, targets and the reward/risk gate.
 *
 * Every bug this module can have costs money directly: a stop on the wrong
 * side of entry, a target behind price, or a ticket whose reward does not
 * justify its risk. The gate is tested as a REJECTION, because the spec asks
 * to avoid such signals and a scoring penalty would still let a high-confluence
 * setup through with a ticket nobody should trade.
 */
import { describe, expect, it } from 'vitest';
import { buildTicket, type RiskInput } from './risk';
import { ENGINE } from './config';
import type { StructureRead } from './structure';
import type { LevelRead } from './levels';

const SCALE = 0.001;

const structure = (over: Partial<StructureRead> = {}): StructureRead =>
  ({
    base: {} as StructureRead['base'],
    trend: 'bullish',
    bos: null, choch: null, reversalConfirmed: false, events: [],
    lastSwingHigh: { index: 90, price: 1.108, kind: 'high' },
    lastSwingLow: { index: 95, price: 1.0975, kind: 'low' },
    ...over,
  }) as StructureRead;

/**
 * A long setup: price at 1.1000, structure just below, room above.
 *
 * The geometry is deliberately realistic against a 10-pip SCALE. An earlier
 * version put resistance 40 pips away and the module correctly refused every
 * ticket as too wide to size — the fixture was wrong, not the code.
 */
const levels = (over: Partial<LevelRead> = {}): LevelRead => ({
  zones: [
    { price: 1.1050, touches: 3, barsSinceTouch: 10, role: 'resistance', halfWidth: 0.0004 },
    { price: 1.0985, touches: 2, barsSinceTouch: 20, role: 'support', halfWidth: 0.0004 },
  ],
  support: { price: 1.0985, touches: 2, barsSinceTouch: 20, role: 'support', halfWidth: 0.0004 },
  resistance: { price: 1.1050, touches: 3, barsSinceTouch: 10, role: 'resistance', halfWidth: 0.0004 },
  atSupport: false, atResistance: false,
  supportDistanceRatio: 1.5, resistanceDistanceRatio: 5,
  breakout: null, previousHigh: 1.1080, previousLow: 1.0940,
  ...over,
});

const input = (over: Partial<RiskInput> = {}): RiskInput => ({
  side: 'bullish',
  price: 1.1,
  scale: SCALE,
  structure: structure(),
  levels: levels(),
  pattern: null,
  config: ENGINE,
  ...over,
});

/** A short setup, with its own geometry: structure above, room below. */
const shortInput = (over: Partial<RiskInput> = {}): RiskInput => ({
  ...input(),
  side: 'bearish',
  structure: structure({
    lastSwingHigh: { index: 90, price: 1.1015, kind: 'high' },
    lastSwingLow: { index: 95, price: 1.0940, kind: 'low' },
  }),
  levels: levels({
    zones: [
      { price: 1.1015, touches: 3, barsSinceTouch: 8, role: 'resistance', halfWidth: 0.0004 },
      { price: 1.0950, touches: 2, barsSinceTouch: 25, role: 'support', halfWidth: 0.0004 },
    ],
    resistance: { price: 1.1015, touches: 3, barsSinceTouch: 8, role: 'resistance', halfWidth: 0.0004 },
    support: { price: 1.0950, touches: 2, barsSinceTouch: 25, role: 'support', halfWidth: 0.0004 },
    previousLow: 1.0930,
  }),
  ...over,
});

describe('stops come from structure', () => {
  it('places a long stop below the nearest structural level, with a buffer', () => {
    const { ticket } = buildTicket(input());
    expect(ticket).not.toBeNull();
    expect(ticket!.stop).toBeLessThan(1.1);
    // Below the level itself, not exactly on it: a stop sitting on an obvious
    // swing low is the most reliably hunted price in the market.
    expect(ticket!.stop).toBeLessThan(1.0985);
    expect(ticket!.stopBasis).toMatch(/swing low|support/);
  });

  it('places a short stop above the nearest level', () => {
    const { ticket } = buildTicket(shortInput());
    expect(ticket).not.toBeNull();
    expect(ticket!.stop).toBeGreaterThan(1.1);
    expect(ticket!.stop).toBeGreaterThan(1.1015);
  });

  it('ignores levels on the wrong side of entry', () => {
    // A "support" above a long's entry cannot be its stop.
    const { ticket } = buildTicket(input({
      structure: structure({ lastSwingLow: { index: 95, price: 1.12, kind: 'low' } }),
    }));
    expect(ticket!.stop).toBeLessThan(1.1);
  });

  it('keeps a tight structural stop tight instead of padding it out', () => {
    // There used to be a volatility floor here that widened close stops to a
    // minimum. It manufactured trades with a very tight stop and a very
    // distant target — flattering reward/risk, stopped out by ordinary noise
    // far more often than the geometry implied. The level is the level.
    const { ticket } = buildTicket(input({
      structure: structure({ lastSwingLow: { index: 95, price: 1.0995, kind: 'low' } }),
      levels: levels({ support: null, zones: [levels().zones[0]!] }),
    }));
    expect(ticket!.stopDistance).toBeLessThan(SCALE);
  });

  it('refuses when no structural level sits below entry to anchor a stop to', () => {
    // A stop no level chose is a guess, not an invalidation.
    const { ticket, reject } = buildTicket(input({
      structure: structure({ lastSwingLow: null, lastSwingHigh: null }),
      levels: levels({ support: null, resistance: null, zones: [] }),
      pattern: null,
    }));
    expect(ticket).toBeNull();
    expect(reject).toMatch(/anchor a stop/);
  });
});

describe('targets come from where price actually stops', () => {
  it('aims just short of the next opposing zone, not at it', () => {
    // The level is where the opposing orders sit, so price routinely turns a
    // few pips before reaching it. Aiming exactly at it converts moves that
    // went the right way into full losses.
    const { ticket } = buildTicket(input());
    expect(ticket!.target).toBeGreaterThan(1.1);
    expect(ticket!.target).toBeLessThan(1.1050);
    expect(ticket!.targetBasis).toMatch(/resistance/);
  });

  it('gives exactly one target', () => {
    const t = buildTicket(input()).ticket!;
    expect(typeof t.target).toBe('number');
  });

  it('puts a short\'s target below entry', () => {
    const t = buildTicket(shortInput()).ticket!;
    expect(t.target).toBeLessThan(1.1);
  });

  it('uses R multiples when nothing structural is in range, and says so', () => {
    const { ticket } = buildTicket(input({
      levels: levels({ zones: [], resistance: null, previousHigh: null }),
    }));
    expect(ticket!.targetBasis).toMatch(/R multiple/);
  });

  it('prefers a pattern measured move when it is the nearest obstacle', () => {
    const { ticket } = buildTicket(input({
      levels: levels({ zones: [], resistance: null, previousHigh: null }),
      pattern: { name: 'Double Bottom', family: 'reversal', bias: 'bullish', index: 90, barsAgo: 3, quality: 0.9, target: 1.1045, invalidation: 1.0985 },
    }));
    expect(ticket!.targetBasis).toMatch(/measured move/);
  });
});

describe('the reward/risk gate', () => {
  it('rejects a setup whose first target does not pay for the stop', () => {
    // Resistance almost on top of entry, stop far below: a real setup shape,
    // and not a trade.
    const { ticket, reject } = buildTicket(input({
      levels: levels({
        zones: [{ price: 1.1005, touches: 3, barsSinceTouch: 5, role: 'resistance', halfWidth: 0.0002 }],
        resistance: { price: 1.1005, touches: 3, barsSinceTouch: 5, role: 'resistance', halfWidth: 0.0002 },
        previousHigh: 1.1006,
      }),
    }));
    expect(ticket).toBeNull();
    expect(reject).toMatch(/below the .*R floor/);
    expect(reject).toMatch(/Only 0\.\d+R/);
  });

  it('accepts one that clears the floor, and reports the ratio', () => {
    const { ticket } = buildTicket(input());
    expect(ticket!.rewardRisk).toBeGreaterThanOrEqual(ENGINE.risk.minRewardRisk);
  });

  it('never reports a reward/risk that disagrees with its own levels', () => {
    const t = buildTicket(input()).ticket!;
    const recomputed = Math.abs(t.target - t.entry) / Math.abs(t.entry - t.stop);
    expect(t.rewardRisk).toBeCloseTo(recomputed, 6);
  });
});

describe('robustness', () => {
  it('refuses rather than dividing by zero when SCALE is unavailable', () => {
    const { ticket, reject } = buildTicket(input({ scale: 0 }));
    expect(ticket).toBeNull();
    expect(reject).toMatch(/typical candle range/);
  });

  it('never returns a long ticket whose stop is above entry', () => {
    for (const price of [1.099, 1.1, 1.1005, 1.101]) {
      const { ticket } = buildTicket(input({ price }));
      if (ticket) expect(ticket.stop).toBeLessThan(ticket.entry);
    }
  });

  it('never returns a short ticket whose stop is below entry', () => {
    for (const price of [1.0995, 1.1, 1.1005, 1.101]) {
      const { ticket } = buildTicket(shortInput({ price }));
      if (ticket) expect(ticket.stop).toBeGreaterThan(ticket.entry);
    }
  });
});

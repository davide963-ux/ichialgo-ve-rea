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

const ATR = 0.001;

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
 * The geometry is deliberately realistic against a 10-pip ATR. An earlier
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
  supportDistanceAtr: 1.5, resistanceDistanceAtr: 5,
  breakout: null, previousHigh: 1.1080, previousLow: 1.0940,
  ...over,
});

const input = (over: Partial<RiskInput> = {}): RiskInput => ({
  side: 'bullish',
  price: 1.1,
  atr: ATR,
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

  it('falls back to ATR when no structure is in range, and says so', () => {
    const { ticket } = buildTicket(input({
      structure: structure({ lastSwingLow: null, lastSwingHigh: null }),
      levels: levels({ support: null, resistance: null, zones: [] }),
    }));
    expect(ticket!.stopBasis).toMatch(/ATR-based/);
  });

  it('widens a stop that would sit inside the noise', () => {
    const { ticket } = buildTicket(input({
      structure: structure({ lastSwingLow: { index: 95, price: 1.09995, kind: 'low' } }),
      levels: levels({ support: null, zones: [levels().zones[0]!] }),
    }));
    expect(ticket!.stopDistance).toBeGreaterThanOrEqual(ATR * ENGINE.risk.minStopAtr);
  });

  it('refuses a stop too wide to size against', () => {
    const { ticket, reject } = buildTicket(input({
      structure: structure({ lastSwingLow: { index: 95, price: 1.09, kind: 'low' } }),
      levels: levels({ support: null, zones: [] }),
    }));
    expect(ticket).toBeNull();
    expect(reject).toMatch(/too wide/);
  });
});

describe('targets come from where price actually stops', () => {
  it('uses the next opposing zone as the first target', () => {
    const { ticket } = buildTicket(input());
    expect(ticket!.targets[0]).toBeCloseTo(1.1050, 4);
    expect(ticket!.targetBasis).toMatch(/resistance/);
  });

  it('always offers three targets, so a runner still has a plan', () => {
    expect(buildTicket(input()).ticket!.targets).toHaveLength(3);
  });

  it('orders targets away from entry', () => {
    const t = buildTicket(input()).ticket!.targets;
    expect(t[1]).toBeGreaterThan(t[0]!);
    expect(t[2]).toBeGreaterThan(t[1]!);
  });

  it('orders a short\'s targets downward', () => {
    const t = buildTicket(shortInput()).ticket!.targets;
    expect(t[0]).toBeLessThan(1.1);
    expect(t[1]).toBeLessThan(t[0]!);
  });

  it('uses R multiples when nothing structural is in range, and says so', () => {
    const { ticket } = buildTicket(input({
      levels: levels({ zones: [], resistance: null, previousHigh: null }),
    }));
    expect(ticket!.targetBasis).toMatch(/R multiples/);
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
    const recomputed = Math.abs(t.targets[0]! - t.entry) / Math.abs(t.entry - t.stop);
    expect(t.rewardRisk).toBeCloseTo(recomputed, 6);
  });
});

describe('robustness', () => {
  it('refuses rather than dividing by zero when ATR is unavailable', () => {
    const { ticket, reject } = buildTicket(input({ atr: 0 }));
    expect(ticket).toBeNull();
    expect(reject).toMatch(/ATR/);
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

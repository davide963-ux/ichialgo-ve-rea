/**
 * The order ticket.
 *
 * What this file is NOT testing any more is worth naming: there is no ATR
 * multiple and no pip floor to check, because the stop is not computed here.
 * The detector puts entry, stop and target on the signal from the 26-bar
 * range, and this layer only rounds them and sizes the position. The tests
 * that matter are therefore about rounding, about sizing off the ROUNDED
 * prices, and about the plan never inventing a level of its own.
 */
import { describe, expect, it } from 'vitest';
import { ICHIMOKU } from '../../config/ichimokuStrategy';

import { calculatorLink, planFromSignal, ticketLevels } from './tradePlan';
import type { IchimokuSignal } from './types';

const ACCOUNT = { balance: 10_000, riskPct: 1 };
const PIP = 0.0001;

/**
 * A clean signal's checks. The COUNT is deliberately not imported from the
 * config: a pullback and a breakout do not require the same number of
 * conditions, so there is no single "number of checks" any more, and a test
 * that pretended there was would be asserting against the wrong thing.
 */
const CLEAN_CHECKS = Array.from({ length: 5 }, (_, i) => ({
  label: `check ${i + 1}`,
  pass: true as boolean | null,
  detail: 'ok',
  required: true,
}));

/** A long on EUR/USD: entry 1.0850, 30-pip stop, 60-pip target. */
const signal = (over: Partial<IchimokuSignal> = {}): IchimokuSignal => {
  const base: IchimokuSignal = {
    id: 'ichimoku|EUR/USD|30M|1000',
    strategy: 'ichimoku',
    symbol: 'EUR/USD',
    timeframe: '30M',
    barTime: 1000,
    detectedAt: 0,
    source: 'candle',
    direction: 'LONG',
    kumo: 'above',
    entry: 1.085,
    stop: 1.085 - 30 * PIP,
    target: 1.085 + 60 * PIP,
    stopPips: 30,
    rangePips: 75,
    entryType: 'pullback',
    stopLevel: 1.0848,
    breakEven: 1.085 + 10 * PIP,
    breakEvenStop: 1.085 + 1 * PIP,
    tenkan: 1.0855,
    kijun: 1.0848,
    senkouA: 1.082,
    senkouB: 1.081,
    senkouAheadA: 1.0995,
    senkouAheadB: 1.0975,
    distancePips: 2,
    cloudPips: 10,
    checks: CLEAN_CHECKS,
    score: CLEAN_CHECKS.length,
    checksTotal: CLEAN_CHECKS.length,
  };
  return { ...base, ...over };
};

/** Mirror a long into a short around its entry, so both risk the same. */
const short = (over: Partial<IchimokuSignal> = {}): IchimokuSignal =>
  signal({ direction: 'SHORT', kumo: 'below', stop: 1.085 + 30 * PIP, target: 1.085 - 60 * PIP, ...over });

describe('ticketLevels', () => {
  it('passes the detector’s own direction and prices through, rounded', () => {
    const t = ticketLevels(signal({ entry: 1.0850183, stop: 1.0820183, target: 1.0910183 }))!;
    expect(t.direction).toBe('LONG');
    expect(t.entry).toBe(1.08502);
    expect(t.stop).toBe(1.08202);
    expect(t.target).toBe(1.09102);
  });

  it('rejects levels that round to no stop distance at all', () => {
    // USD/JPY has 3 digits, so a sub-tenth-of-a-pip stop vanishes on rounding.
    expect(ticketLevels(signal({ symbol: 'USD/JPY', entry: 151.2, stop: 151.2000001, target: 151.3 }))).toBeNull();
  });

  it('rejects a non-finite or non-positive level rather than sizing off it', () => {
    expect(ticketLevels(signal({ entry: Number.NaN }))).toBeNull();
    expect(ticketLevels(signal({ stop: 0 }))).toBeNull();
    expect(ticketLevels(signal({ target: -1 }))).toBeNull();
  });
});

describe('planFromSignal', () => {
  it('reports the detector’s levels and the reward multiple they imply', () => {
    const plan = planFromSignal(signal(), ACCOUNT)!;
    expect(plan.direction).toBe('LONG');
    expect(plan.entry).toBe(1.085);
    expect(plan.stopPips).toBeCloseTo(30, 6);
    expect(plan.targetPips).toBeCloseTo(60, 6);
    expect(plan.riskReward).toBeCloseTo(ICHIMOKU.rewardMultiple, 6);
    expect(plan.rangePips).toBe(75);
  });

  it('mirrors the plan for a short', () => {
    const plan = planFromSignal(short(), ACCOUNT)!;
    expect(plan.direction).toBe('SHORT');
    expect(plan.stop).toBeGreaterThan(plan.entry);
    expect(plan.target).toBeLessThan(plan.entry);
    expect(plan.stopPips).toBeCloseTo(30, 6);
  });

  it('sizes the position so the stop costs exactly the risk budget', () => {
    const plan = planFromSignal(signal(), ACCOUNT)!;
    // EUR/USD: $10 per pip per lot. 1% of 10k = $100 risk over a 30-pip stop.
    expect(plan.riskAmount).toBe(100);
    expect(plan.lots).toBeCloseTo(0.33, 2);
    expect(plan.potentialLoss!).toBeLessThanOrEqual(100);
    expect(plan.potentialProfit!).toBeCloseTo(plan.potentialLoss! * 2, 6);
  });

  /**
   * The stop now scales with the 26-bar range rather than an ATR, but the
   * consequence for sizing is the same and is the part worth pinning: a
   * volatile pair must get a SMALLER position, not a bigger loss.
   */
  it('takes a smaller position when the range is wide', () => {
    const calm = planFromSignal(signal({ stop: 1.085 - 8 * PIP, target: 1.085 + 16 * PIP, rangePips: 20 }), ACCOUNT)!;
    const wild = planFromSignal(signal({ stop: 1.085 - 60 * PIP, target: 1.085 + 120 * PIP, rangePips: 150 }), ACCOUNT)!;
    expect(wild.stopPips).toBeGreaterThan(calm.stopPips);
    expect(wild.lots!).toBeLessThan(calm.lots!);
    /**
     * Both risk the same budget, that being what sizing is for — but only to
     * within one tradeable lot step. Lots round DOWN to 0.01, so a 60-pip
     * stop lands on 0.16 lots and risks $96 of the $100 rather than $100.04.
     * The invariant is "at or under budget", not "equal to it".
     */
    for (const plan of [calm, wild]) {
      expect(plan.potentialLoss!).toBeLessThanOrEqual(100);
      expect(plan.potentialLoss!).toBeGreaterThan(95);
    }
  });

  it('quotes prices the pair can actually be traded at, so the plan and the calculator agree', () => {
    const plan = planFromSignal(signal({ entry: 1.1005183, stop: 1.0937583, target: 1.1140383 }), ACCOUNT)!;
    for (const price of [plan.entry, plan.stop, plan.target]) {
      expect(price).toBe(Number(price.toFixed(5))); // no un-placeable 7th decimal
    }
    // sizing used those same rounded prices
    expect(plan.stopPips).toBeCloseTo(Math.abs(plan.entry - plan.stop) / PIP, 9);
  });

  it('handles a JPY pair on its own pip scale', () => {
    const plan = planFromSignal(
      signal({ symbol: 'USD/JPY', entry: 151.2, stop: 151.2 - 0.3, target: 151.2 + 0.6, kijun: 151.18 }),
      ACCOUNT,
    )!;
    expect(plan.stopPips).toBeCloseTo(30, 6);
    expect(plan.stop).toBeCloseTo(151.2 - 0.3, 8);
  });

  it('reports no size when the quote currency cannot be converted to USD', () => {
    const plan = planFromSignal(
      signal({ symbol: 'EUR/GBP', entry: 0.855, stop: 0.855 - 30 * PIP, target: 0.855 + 60 * PIP }),
      ACCOUNT,
    )!;
    expect(plan.lots).toBeNull();
    expect(plan.warnings.join(' ')).toMatch(/Cannot convert GBP/);
  });

  it('sizes a cross once a USD rate is available', () => {
    const plan = planFromSignal(
      signal({ symbol: 'EUR/GBP', entry: 0.855, stop: 0.855 - 30 * PIP, target: 0.855 + 60 * PIP }),
      ACCOUNT,
      (sym) => (sym === 'GBP/USD' ? 1.27 : null),
    )!;
    expect(plan.lots).toBeGreaterThan(0);
  });

  /**
   * The gate means a signal cannot arrive below `minScore`, but it CAN arrive
   * below unanimous if the gate is ever lowered. The plan says so rather than
   * presenting a 3/4 setup as identical to a 4/4 one.
   */
  it('names a non-unanimous score first, and still sizes the trade', () => {
    const plan = planFromSignal(signal({ score: CLEAN_CHECKS.length - 1 }), ACCOUNT)!;
    expect(plan.warnings[0]).toMatch(new RegExp(`of ${CLEAN_CHECKS.length} checks passed`));
    expect(plan.lots).not.toBeNull();
  });

  /**
   * A check that could not be answered is worth saying out loud, and the plan
   * reads it off the signal's own list rather than from a named field — the
   * three strategies do not share one, so a hardcoded "chikouFree" lookup
   * would be silent on two of them.
   */
  it('says so when a check could not be answered, rather than passing it silently', () => {
    const unknown = CLEAN_CHECKS.map((c, i) => (i === 2 ? { ...c, pass: null, detail: 'fewer than 26 bars' } : c));
    const plan = planFromSignal(signal({ checks: unknown, score: CLEAN_CHECKS.length }), ACCOUNT)!;
    expect(plan.warnings.join(' ')).toMatch(/could not be checked/);
  });

  it('marks a live signal as read from an unfinished bar', () => {
    const plan = planFromSignal(signal({ source: 'live' }), ACCOUNT)!;
    expect(plan.warnings.join(' ')).toMatch(/live tick/);
  });

  it('adds no warnings at all to a clean closed-bar signal', () => {
    expect(planFromSignal(signal(), ACCOUNT)!.warnings).toEqual([]);
  });

  it('rejects a signal whose levels are unusable', () => {
    expect(planFromSignal(signal({ entry: 0 }), ACCOUNT)).toBeNull();
    expect(planFromSignal(signal({ entry: Number.NaN }), ACCOUNT)).toBeNull();
  });
});

describe('calculatorLink', () => {
  it('rounds prices to the pair precision instead of leaking floats', () => {
    const plan = planFromSignal(signal(), ACCOUNT)!;
    const link = calculatorLink('EUR/USD', plan);
    expect(link).toContain('entry=1.08500');
    expect(link).toContain('sl=1.08200');
    expect(link).toContain('tp=1.09100');
    expect(link).not.toMatch(/\d{7,}/);
  });
});

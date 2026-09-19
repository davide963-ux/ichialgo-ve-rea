import { describe, expect, it } from 'vitest';
import { TRADE_PLAN } from '../../config/strategy';
import { calculatorLink, directionOf, planFromTouch } from './tradePlan';
import type { TouchSignal } from './types';

const ACCOUNT = { balance: 10_000, riskPct: 1 };
const PIP = 0.0001;

const touch = (over: Partial<TouchSignal> = {}): TouchSignal => ({
  id: 'ema50-touch|EUR/USD|30M|1000',
  strategy: 'ema50-touch',
  symbol: 'EUR/USD',
  timeframe: '30M',
  barTime: 1000,
  detectedAt: 0,
  source: 'candle',
  price: 1.085,
  ema: 1.085,
  tolerancePips: 2,
  atr: 20 * PIP, // 20-pip ATR
  distancePips: 0.2,
  approach: 'above',
  outcome: 'bounce',
  trend: 'up',
  bias: 'long',
  counterTrend: false,
  ichimoku: null,
  ...over,
});

describe('directionOf', () => {
  it('reads a pullback from above as a long and a rally from below as a short', () => {
    expect(directionOf({ approach: 'above' })).toBe('LONG');
    expect(directionOf({ approach: 'below' })).toBe('SHORT');
  });

  it('still gives a counter-trend touch a direction', () => {
    expect(directionOf({ approach: 'below' })).toBe('SHORT');
  });
});

describe('planFromTouch', () => {
  it('puts the stop an ATR multiple below a long entry, target at the R multiple', () => {
    const plan = planFromTouch(touch(), ACCOUNT)!;
    expect(plan.direction).toBe('LONG');
    expect(plan.entry).toBe(1.085);
    expect(plan.stopPips).toBeCloseTo(20 * TRADE_PLAN.stopAtrMultiple, 6); // 30 pips
    expect(plan.stop).toBeCloseTo(1.085 - 30 * PIP, 10);
    expect(plan.target).toBeCloseTo(1.085 + 60 * PIP, 10);
    expect(plan.riskReward).toBe(TRADE_PLAN.rewardMultiple);
  });

  it('mirrors the plan for a short', () => {
    const plan = planFromTouch(touch({ approach: 'below', bias: 'short', trend: 'down' }), ACCOUNT)!;
    expect(plan.direction).toBe('SHORT');
    expect(plan.stop).toBeGreaterThan(plan.entry);
    expect(plan.target).toBeLessThan(plan.entry);
  });

  it('sizes the position so the stop costs exactly the risk budget', () => {
    const plan = planFromTouch(touch(), ACCOUNT)!;
    // EUR/USD: $10 per pip per lot. 1% of 10k = $100 risk over a 30-pip stop.
    expect(plan.riskAmount).toBe(100);
    expect(plan.lots).toBeCloseTo(0.33, 2);
    expect(plan.potentialLoss!).toBeLessThanOrEqual(100);
    expect(plan.potentialProfit!).toBeCloseTo(plan.potentialLoss! * 2, 6);
  });

  it('scales the stop with volatility', () => {
    const calm = planFromTouch(touch({ atr: 8 * PIP }), ACCOUNT)!;
    const wild = planFromTouch(touch({ atr: 60 * PIP }), ACCOUNT)!;
    expect(wild.stopPips).toBeGreaterThan(calm.stopPips);
    expect(wild.lots!).toBeLessThan(calm.lots!); // wider stop → smaller position
  });

  it('never produces a hair-thin stop when ATR collapses', () => {
    const plan = planFromTouch(touch({ atr: 0.2 * PIP }), ACCOUNT)!;
    expect(plan.stopPips).toBeCloseTo(TRADE_PLAN.minStopPips, 6);
    expect(plan.warnings.join(' ')).toMatch(/floor/);
  });

  it('quotes prices the pair can actually be traded at, so the plan and the calculator agree', () => {
    const plan = planFromTouch(touch({ ema: 1.1005183, atr: 6.76 * PIP }), ACCOUNT)!;
    for (const price of [plan.entry, plan.stop, plan.target]) {
      expect(price).toBe(Number(price.toFixed(5))); // no un-placeable 7th decimal
    }
    // sizing used those same rounded prices
    expect(plan.stopPips).toBeCloseTo(Math.abs(plan.entry - plan.stop) / PIP, 9);
  });

  it('flags a counter-trend touch before anything else', () => {
    const plan = planFromTouch(touch({ counterTrend: true, bias: 'neutral', trend: 'down' }), ACCOUNT)!;
    expect(plan.warnings[0]).toMatch(/against the EMA trend/);
    expect(plan.lots).not.toBeNull(); // still sized — it is a worse trade, not an impossible one
  });

  it('handles a JPY pair on its own pip scale', () => {
    const plan = planFromTouch(touch({ symbol: 'USD/JPY', ema: 151.2, atr: 20 * 0.01 }), ACCOUNT)!;
    expect(plan.stopPips).toBeCloseTo(30, 6);
    expect(plan.stop).toBeCloseTo(151.2 - 0.3, 8);
  });

  it('reports no size when the quote currency cannot be converted to USD', () => {
    const plan = planFromTouch(touch({ symbol: 'EUR/GBP', ema: 0.855, atr: 20 * PIP }), ACCOUNT)!;
    expect(plan.lots).toBeNull();
    expect(plan.warnings.join(' ')).toMatch(/Cannot convert GBP/);
  });

  it('sizes a cross once a USD rate is available', () => {
    const plan = planFromTouch(
      touch({ symbol: 'EUR/GBP', ema: 0.855, atr: 20 * PIP }),
      ACCOUNT,
      (sym) => (sym === 'GBP/USD' ? 1.27 : null),
    )!;
    expect(plan.lots).toBeGreaterThan(0);
  });

  it('rejects a signal with no usable EMA', () => {
    expect(planFromTouch(touch({ ema: 0 }), ACCOUNT)).toBeNull();
    expect(planFromTouch(touch({ ema: Number.NaN }), ACCOUNT)).toBeNull();
  });
});

describe('calculatorLink', () => {
  it('rounds prices to the pair precision instead of leaking floats', () => {
    const plan = planFromTouch(touch(), ACCOUNT)!;
    const link = calculatorLink('EUR/USD', plan);
    expect(link).toContain('entry=1.08500');
    expect(link).toContain('sl=1.08200');
    expect(link).toContain('tp=1.09100');
    expect(link).not.toMatch(/\d{7,}/);
  });
});

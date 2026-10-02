import { describe, expect, it } from 'vitest';
import { calculatePosition, quoteToUsd } from './positionSize';

describe('calculatePosition', () => {
  it('EUR/USD long: 1% of 10k, 50 pip stop → 0.20 lots', () => {
    const r = calculatePosition({ balance: 10_000, riskPct: 1, symbol: 'EUR/USD', entry: 1.1, stopLoss: 1.095, takeProfit: 1.11 });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('LONG');
    expect(r.pipValuePerLot).toBeCloseTo(10);
    expect(r.stopPips).toBeCloseTo(50);
    expect(r.lots).toBeCloseTo(0.2);
    expect(r.units).toBe(20_000);
    expect(r.potentialLoss).toBeCloseTo(100);
    expect(r.potentialProfit).toBeCloseTo(200);
    expect(r.riskReward).toBeCloseTo(2);
  });

  it('USD/JPY short: JPY pip size and USD conversion', () => {
    const r = calculatePosition({ balance: 10_000, riskPct: 1, symbol: 'USD/JPY', entry: 150, stopLoss: 150.5, takeProfit: 149 });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe('SHORT');
    expect(r.pipSize).toBe(0.01);
    expect(r.stopPips).toBeCloseTo(50);
    expect(r.pipValuePerLot).toBeCloseTo(6.6667, 3);
    expect(r.lots).toBeCloseTo(0.3);
    expect(r.riskReward).toBeCloseTo(2);
  });

  it('cross pair uses live conversion rate', () => {
    const lookup = (s: string) => (s === 'USD/JPY' ? 150 : null);
    expect(quoteToUsd('EUR/JPY', 160, lookup)).toBeCloseTo(1 / 150);
    expect(quoteToUsd('EUR/GBP', 0.85, () => null)).toBeNull();
    expect(quoteToUsd('EUR/GBP', 0.85, (s) => (s === 'GBP/USD' ? 1.27 : null))).toBeCloseTo(1.27);
  });

  it('rejects take profit on the stop side', () => {
    const r = calculatePosition({ balance: 10_000, riskPct: 1, symbol: 'EUR/USD', entry: 1.1, stopLoss: 1.095, takeProfit: 1.09 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/above entry/);
  });

  it('floors lots to 0.01 so risk is never exceeded', () => {
    const r = calculatePosition({ balance: 1_000, riskPct: 1, symbol: 'EUR/USD', entry: 1.1, stopLoss: 1.0967, takeProfit: null });
    expect(r.lots).toBeCloseTo(0.03);
    expect(r.potentialLoss!).toBeLessThanOrEqual(10);
    expect(r.riskReward).toBeNull();
  });
});

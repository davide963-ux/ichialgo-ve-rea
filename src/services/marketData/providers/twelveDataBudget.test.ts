/**
 * The poll interval must fit the provider's credit budget. /quote costs one
 * credit PER SYMBOL, so this is what stops the price poll from feeding the
 * rate limiter — and what leaves credits over for candles.
 */
import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../../config/app';
import { TwelveDataProvider } from './TwelveDataProvider';

const configured = APP_CONFIG.twelveDataPollMs; // 60s by default

function poll(perMinuteTotal: number, symbols: number): number {
  const p = new TwelveDataProvider();
  p.applyBudgetToPolling(perMinuteTotal, symbols);
  return p.capabilities.pollIntervalMs;
}

describe('applyBudgetToPolling', () => {
  it('leaves the configured interval alone when quotes already fit', () => {
    // 7 pairs on one free key = 7 of 8 credits per minute at a 60s poll.
    expect(poll(8, 7)).toBe(configured);
  });

  it('never speeds the poll up past what was configured', () => {
    // 24 credits/min could afford ~18s, but the user asked for 60s.
    expect(poll(24, 7)).toBe(configured);
  });

  it('stretches the interval when quotes alone cannot fit the budget', () => {
    // 12 pairs on 8 credits/min needs 90s just for the quotes.
    expect(poll(8, 12)).toBe(90_000);
    expect(poll(8, 20)).toBe(150_000);
  });

  it('caps the interval so a tiny budget cannot stall prices forever', () => {
    expect(poll(1, 60)).toBe(300_000);
  });

  it('keeps the chart refresh at least twice the poll, and never under 2 min', () => {
    const p = new TwelveDataProvider();
    p.applyBudgetToPolling(8, 12);
    expect(p.capabilities.pollIntervalMs).toBe(90_000);
    expect(p.capabilities.candleRefreshMs).toBe(180_000);

    p.applyBudgetToPolling(8, 7);
    expect(p.capabilities.candleRefreshMs).toBeGreaterThanOrEqual(120_000);
  });

  it('ignores nonsense budgets rather than producing a broken interval', () => {
    const p = new TwelveDataProvider();
    const before = p.capabilities.pollIntervalMs;
    p.applyBudgetToPolling(0, 7);
    p.applyBudgetToPolling(Number.NaN, 7);
    p.applyBudgetToPolling(8, 0);
    expect(p.capabilities.pollIntervalMs).toBe(before);
  });

  it('uses the symbol count the service handed it when none is passed', () => {
    const p = new TwelveDataProvider();
    p.setSymbolCount(12);
    p.applyBudgetToPolling(8);
    expect(p.capabilities.pollIntervalMs).toBe(90_000);
  });
});

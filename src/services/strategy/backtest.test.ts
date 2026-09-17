import { describe, expect, it } from 'vitest';
import { EMA50_TOUCH, ICHIMOKU_CONFLUENCE, TRADE_PLAN } from '../../config/strategy';
import type { Candle } from '../marketData';
import { runBacktest, summarise, type BacktestTrade } from './backtest';

const SYMBOL = 'EUR/USD';
const PIP = 0.0001;
const STEP = 900;

function candles(closes: number[], wickPips = 3): Candle[] {
  const w = wickPips * PIP;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      time: 1_700_000_000 + i * STEP,
      open,
      high: Math.max(open, close) + w,
      low: Math.min(open, close) - w,
      close,
      volume: null,
      complete: true,
    };
  });
}

/** Enough bars for EMA50 + Ichimoku, trending up 2 pips a bar. */
const upPath = (n = 200, step = 2 * PIP) => Array.from({ length: n }, (_, i) => 1.1 + i * step);

const OPTS = { startingBalance: 10_000, riskPct: 1 };

describe('runBacktest', () => {
  it('refuses to invent results without enough warm-up history', () => {
    const r = runBacktest(candles(upPath(40)), SYMBOL, '15M', OPTS);
    expect(r.trades).toEqual([]);
    expect(r.stats.trades).toBe(0);
    expect(r.stats.endingBalance).toBe(10_000);
    expect(r.warnings.join(' ')).toMatch(/at least \d+ 15M candles/);
  });

  it('reports no trades, not zero-value trades, when nothing touches', () => {
    const r = runBacktest(candles(upPath()), SYMBOL, '15M', OPTS);
    expect(r.trades).toEqual([]);
    expect(r.stats.winRatePct).toBeNull();
    expect(r.stats.profitFactor).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/No EMA50 touches/);
  });

  it('takes a pullback long and books the target when price runs on', () => {
    // trend up, dip onto the EMA, then rally hard enough to hit 2R
    const closes = upPath();
    const bars = candles(closes);
    const r0 = runBacktest(bars, SYMBOL, '15M', OPTS);
    expect(r0.trades).toHaveLength(0);

    const withTouch = [...closes];
    withTouch.push(withTouch.at(-1)! - 60 * PIP); // drop into the EMA
    for (let i = 0; i < 40; i++) withTouch.push(withTouch.at(-1)! + 12 * PIP); // rally away
    const r = runBacktest(candles(withTouch), SYMBOL, '15M', OPTS);

    expect(r.trades.length).toBeGreaterThan(0);
    const t = r.trades[0]!;
    expect(t.direction).toBe('LONG');
    expect(t.exitReason).toBe('target');
    expect(t.pnl!).toBeGreaterThan(0);
    expect(t.rMultiple!).toBeCloseTo(TRADE_PLAN.rewardMultiple, 1);
    expect(r.stats.endingBalance).toBeGreaterThan(10_000);
  });

  it('books the stop when price keeps falling through the level', () => {
    const closes = upPath();
    closes.push(closes.at(-1)! - 60 * PIP); // touch
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! - 14 * PIP); // collapse
    const r = runBacktest(candles(closes), SYMBOL, '15M', OPTS);

    const t = r.trades[0]!;
    expect(t.exitReason).toBe('stop');
    expect(t.pnl!).toBeLessThan(0);
    expect(t.rMultiple!).toBeCloseTo(-1, 1);
    // The loss is capped at the risk budget: 1% of 10k.
    expect(Math.abs(t.pnl!)).toBeLessThanOrEqual(100.01);
  });

  it('takes the stop when one bar covers both stop and target', () => {
    const closes = upPath();
    closes.push(closes.at(-1)! - 60 * PIP);
    const bars = candles(closes);
    // One enormous bar spanning far above and far below the entry.
    const last = bars.at(-1)!;
    bars.push({
      time: last.time + STEP,
      open: last.close,
      high: last.close + 300 * PIP,
      low: last.close - 300 * PIP,
      close: last.close,
      volume: null,
      complete: true,
    });
    const r = runBacktest(bars, SYMBOL, '15M', OPTS);
    expect(r.trades[0]!.exitReason).toBe('stop'); // pessimistic, never invents a win
  });

  it('holds one position at a time and counts the touches it skipped', () => {
    const closes = upPath();
    // Sit on the EMA for a long stretch: repeated touches, one trade.
    for (let i = 0; i < 30; i++) closes.push(closes.at(-1)! - 3 * PIP);
    for (let i = 0; i < 30; i++) closes.push(closes.at(-1)! + 3 * PIP);
    const r = runBacktest(candles(closes), SYMBOL, '15M', OPTS);
    const overlapping = r.trades.filter((t, i) => i > 0 && t.entryTime <= r.trades[i - 1]!.exitTime!);
    expect(overlapping).toEqual([]);
  });

  it('marks a trade still open at the end and keeps it out of the stats', () => {
    const closes = upPath();
    closes.push(closes.at(-1)! - 60 * PIP); // touch on the very last bar
    const r = runBacktest(candles(closes), SYMBOL, '15M', OPTS);

    const open = r.trades.filter((t) => t.exitReason === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.pnl).toBeNull();
    expect(r.stats.closed).toBe(0);
    expect(r.stats.endingBalance).toBe(10_000);
    expect(r.warnings.join(' ')).toMatch(/still open/);
  });

  it('compounds: position size follows the running balance', () => {
    const closes = upPath(200);
    for (let round = 0; round < 3; round++) {
      closes.push(closes.at(-1)! - 60 * PIP);
      for (let i = 0; i < 30; i++) closes.push(closes.at(-1)! + 12 * PIP);
    }
    const r = runBacktest(candles(closes), SYMBOL, '15M', OPTS);
    const wins = r.trades.filter((t) => t.exitReason === 'target');
    if (wins.length >= 2) expect(wins.at(-1)!.lots).toBeGreaterThanOrEqual(wins[0]!.lots);
    expect(r.equity[0]!.balance).toBe(10_000);
    expect(r.equity.at(-1)!.balance).toBeCloseTo(r.stats.endingBalance, 6);
  });

  it('honours the date range: touches outside it are not traded', () => {
    const closes = upPath();
    closes.push(closes.at(-1)! - 60 * PIP);
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! + 12 * PIP);
    const bars = candles(closes);

    const all = runBacktest(bars, SYMBOL, '15M', OPTS);
    expect(all.trades.length).toBeGreaterThan(0);

    // A window that ends before the touch bar yields nothing.
    const early = runBacktest(bars, SYMBOL, '15M', { ...OPTS, to: bars[100]!.time });
    expect(early.trades).toEqual([]);
  });

  it('can restrict trades to Ichimoku-confluent touches', () => {
    const closes = upPath();
    closes.push(closes.at(-1)! - 60 * PIP);
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! + 12 * PIP);
    const bars = candles(closes);

    const all = runBacktest(bars, SYMBOL, '15M', OPTS);
    const filtered = runBacktest(bars, SYMBOL, '15M', { ...OPTS, confluentOnly: true });

    expect(filtered.trades.length).toBeLessThanOrEqual(all.trades.length);
    // Every trade the filter let through clears the agreement threshold.
    for (const t of filtered.trades) {
      expect(t.ichimokuScore).toBeGreaterThanOrEqual(ICHIMOKU_CONFLUENCE.agreeThreshold);
    }
    // And anything it turned away is counted, not silently dropped. (The
    // counts do not subtract: skipping one touch can free a later one that
    // an open position had blocked.)
    const rejected = filtered.skipped.notConfluent;
    if (filtered.trades.length < all.trades.length) expect(rejected).toBeGreaterThan(0);
    expect(rejected + filtered.trades.length + filtered.skipped.positionOpen + filtered.skipped.unsizable).toBeGreaterThanOrEqual(
      all.trades.length,
    );
  });

  it('cannot size a cross without a USD rate, and says so instead of guessing', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 0.855 + i * 2 * PIP);
    closes.push(closes.at(-1)! - 60 * PIP);
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! + 12 * PIP);
    const bars = candles(closes);

    const blind = runBacktest(bars, 'EUR/GBP', '15M', OPTS);
    expect(blind.trades).toEqual([]);
    expect(blind.skipped.unsizable).toBeGreaterThan(0);

    const withRate = runBacktest(bars, 'EUR/GBP', '15M', { ...OPTS, lookup: (s) => (s === 'GBP/USD' ? 1.27 : null) });
    expect(withRate.trades.length).toBeGreaterThan(0);
  });

  it('never reports more warm-up bars than it was given', () => {
    const r = runBacktest(candles(upPath(80)), SYMBOL, '15M', OPTS);
    expect(r.warmupBars).toBeLessThanOrEqual(80);
    expect(r.warmupBars).toBe(EMA50_TOUCH.minBars);
  });
});

describe('summarise', () => {
  const trade = (over: Partial<BacktestTrade>): BacktestTrade => ({
    id: 't', symbol: SYMBOL, direction: 'LONG', entryTime: 0, entryPrice: 1, stop: 0.99, target: 1.02,
    exitTime: 1, exitPrice: 1.02, exitReason: 'target', barsHeld: 3, lots: 0.1, pips: 20, pnl: 200,
    balanceAfter: 10_200, rMultiple: 2, ichimokuScore: 3, counterTrend: false, ...over,
  });

  it('computes win rate, profit factor and expectancy from closed trades only', () => {
    const s = summarise(
      [
        trade({ pnl: 200, balanceAfter: 10_200, rMultiple: 2 }),
        trade({ pnl: -100, balanceAfter: 10_100, rMultiple: -1, exitReason: 'stop' }),
        trade({ pnl: null, exitReason: 'open', balanceAfter: 10_100, rMultiple: null }),
      ],
      10_000,
      10_100,
    );
    expect(s.trades).toBe(3);
    expect(s.closed).toBe(2);
    expect(s.winRatePct).toBe(50);
    expect(s.profitFactor).toBe(2);
    expect(s.expectancy).toBe(50);
    expect(s.averageR).toBeCloseTo(0.5, 6);
    expect(s.netProfit).toBe(100);
    expect(s.returnPct).toBeCloseTo(1, 6);
  });

  it('measures drawdown peak-to-trough, not just from the start', () => {
    const s = summarise(
      [
        trade({ pnl: 1_000, balanceAfter: 11_000 }),
        trade({ pnl: -2_000, balanceAfter: 9_000, exitReason: 'stop' }),
        trade({ pnl: 500, balanceAfter: 9_500 }),
      ],
      10_000,
      9_500,
    );
    expect(s.maxDrawdown).toBe(2_000); // 11k peak → 9k trough
    expect(s.maxDrawdownPct).toBeCloseTo((2_000 / 11_000) * 100, 6);
  });

  it('leaves profit factor undefined when nothing lost', () => {
    const s = summarise([trade({ pnl: 200, balanceAfter: 10_200 })], 10_000, 10_200);
    expect(s.profitFactor).toBeNull();
    expect(s.losses).toBe(0);
  });
});

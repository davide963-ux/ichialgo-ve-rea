import { describe, expect, it } from 'vitest';
import {
  MIN_RELIABLE_TRADES,
  buildReport,
  computeMetrics,
  groupBy,
  regimeFamily,
  signalStrength,
  type MeasuredTrade,
} from './performance';

const trade = (over: Partial<MeasuredTrade> = {}): MeasuredTrade => ({
  direction: 'long',
  timeframe: '1H',
  marketCondition: 'TRENDING_BULLISH',
  signal: 'LONG',
  outcome: 'tp',
  rMultiple: 2.5,
  confidence: 70,
  symbol: 'EUR/USD',
  ...over,
});

const win = (r = 2) => trade({ outcome: 'tp', rMultiple: r });
const loss = () => trade({ outcome: 'sl', rMultiple: -1 });
const scratch = () => trade({ outcome: 'tp', rMultiple: 0 });
const open = () => trade({ outcome: 'pending', rMultiple: null });

describe('computeMetrics — the basics', () => {
  it('returns an empty report for no trades', () => {
    const m = computeMetrics([]);
    expect(m.trades).toBe(0);
    expect(m.winRatePct).toBeNull();
    expect(m.averageR).toBeNull();
  });

  it('counts wins, losses and scratches separately', () => {
    const m = computeMetrics([win(), win(), loss(), scratch()]);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.breakeven).toBe(1);
    expect(m.closed).toBe(4);
  });

  it('excludes breakevens from the win rate denominator', () => {
    // 2 wins, 1 loss, 1 scratch → 2/3, not 2/4.
    expect(computeMetrics([win(), win(), loss(), scratch()]).winRatePct).toBeCloseTo(66.67, 1);
  });

  it('sums R and averages over closed trades', () => {
    const m = computeMetrics([win(2), win(3), loss()]);
    expect(m.totalR).toBeCloseTo(4);
    expect(m.averageR).toBeCloseTo(4 / 3);
  });

  it('computes profit factor as gross win over gross loss', () => {
    const m = computeMetrics([win(3), loss(), loss()]);
    expect(m.profitFactor).toBeCloseTo(1.5); // 3 / 2
  });

  it('reports Infinity profit factor when nothing lost, rather than dividing by zero', () => {
    expect(computeMetrics([win(), win()]).profitFactor).toBe(Infinity);
  });

  it('tracks best and worst', () => {
    const m = computeMetrics([win(1), win(5), loss()]);
    expect(m.bestR).toBe(5);
    expect(m.worstR).toBe(-1);
  });
});

describe('computeMetrics — open trades cannot flatter the numbers', () => {
  it('counts an open trade but excludes it from every statistic', () => {
    const m = computeMetrics([win(2), open(), open()]);
    expect(m.trades).toBe(3);
    expect(m.closed).toBe(1);
    expect(m.averageR).toBe(2);
    expect(m.winRatePct).toBe(100);
  });

  it('reports nothing measurable when every trade is still open', () => {
    const m = computeMetrics([open(), open()]);
    expect(m.trades).toBe(2);
    expect(m.closed).toBe(0);
    expect(m.winRatePct).toBeNull();
    expect(m.averageR).toBeNull();
  });
});

describe('computeMetrics — drawdown', () => {
  it('measures the deepest peak-to-trough fall of the R curve', () => {
    // +3 (peak 3), -1, -1 (trough 1) → drawdown 2, then +5.
    const m = computeMetrics([win(3), loss(), loss(), win(5)]);
    expect(m.maxDrawdownR).toBeCloseTo(2);
  });

  it('is zero for an unbroken run of wins', () => {
    expect(computeMetrics([win(1), win(1), win(1)]).maxDrawdownR).toBe(0);
  });

  it('depends on order, which is why trades must be passed oldest first', () => {
    const rising = computeMetrics([loss(), loss(), win(5)]);
    const falling = computeMetrics([win(5), loss(), loss()]);
    expect(rising.maxDrawdownR).toBeCloseTo(2);
    expect(falling.maxDrawdownR).toBeCloseTo(2);
    // Same totals either way — only the path differs.
    expect(rising.totalR).toBeCloseTo(falling.totalR);
  });
});

describe('computeMetrics — sample size honesty', () => {
  it('marks a small sample unreliable however good it looks', () => {
    const m = computeMetrics([win(), win(), win()]);
    expect(m.winRatePct).toBe(100);
    expect(m.reliable).toBe(false);
  });

  it('marks a sample reliable at the threshold', () => {
    const m = computeMetrics(Array.from({ length: MIN_RELIABLE_TRADES }, () => win()));
    expect(m.reliable).toBe(true);
  });
});

describe('grouping', () => {
  it('splits by key and measures each side', () => {
    const groups = groupBy(
      [
        trade({ symbol: 'EUR/USD', outcome: 'tp', rMultiple: 2 }),
        trade({ symbol: 'EUR/USD', outcome: 'sl', rMultiple: -1 }),
        trade({ symbol: 'GBP/USD', outcome: 'tp', rMultiple: 3 }),
      ],
      (t) => t.symbol,
    );

    expect(groups.map((g) => g.key)).toEqual(['EUR/USD', 'GBP/USD']);
    expect(groups[0]!.closed).toBe(2);
    expect(groups[1]!.totalR).toBe(3);
  });

  it('orders the biggest samples first, so the readable groups lead', () => {
    const groups = groupBy([win(), win(), win(), trade({ symbol: 'X/USD' })], (t) => t.symbol);
    expect(groups[0]!.key).toBe('EUR/USD');
  });
});

describe('regimeFamily', () => {
  it('collapses both trending regimes into one', () => {
    expect(regimeFamily('TRENDING_BULLISH')).toBe('Trending');
    expect(regimeFamily('TRENDING_BEARISH')).toBe('Trending');
  });

  it('keeps the non-trending regimes distinct', () => {
    expect(regimeFamily('RANGING')).toBe('Ranging');
    expect(regimeFamily('CHOPPY')).toBe('Choppy');
    expect(regimeFamily('COMPRESSION')).toBe('Compression');
  });

  it('groups a confirmed reversal with a transition, since both are turns', () => {
    expect(regimeFamily('REVERSAL')).toBe('Reversal');
    expect(regimeFamily('TRANSITION')).toBe('Reversal');
  });

  it('does not guess at an unknown regime', () => {
    expect(regimeFamily('SOMETHING_NEW')).toBe('Unknown');
  });
});

describe('signalStrength', () => {
  it('grades by tier, not by side', () => {
    expect(signalStrength('STRONG_LONG')).toBe('Strong');
    expect(signalStrength('STRONG_SHORT')).toBe('Strong');
    expect(signalStrength('LONG')).toBe('Standard');
    expect(signalStrength('SHORT')).toBe('Standard');
    expect(signalStrength('WATCH_LONG')).toBe('Watch');
    expect(signalStrength('NO_TRADE')).toBe('Other');
  });
});

describe('buildReport', () => {
  const trades: MeasuredTrade[] = [
    trade({ marketCondition: 'TRENDING_BULLISH', signal: 'STRONG_LONG', outcome: 'tp', rMultiple: 3.5, timeframe: '4H' }),
    trade({ marketCondition: 'TRENDING_BULLISH', signal: 'LONG', outcome: 'tp', rMultiple: 1.5, timeframe: '1H' }),
    trade({ marketCondition: 'RANGING', signal: 'LONG', outcome: 'sl', rMultiple: -1, timeframe: '1H' }),
    trade({ marketCondition: 'RANGING', signal: 'SHORT', outcome: 'sl', rMultiple: -1, direction: 'short', timeframe: '1H' }),
  ];

  it('answers the question the strategy rests on: trending vs ranging', () => {
    const report = buildReport(trades);
    const trending = report.byRegimeFamily.find((g) => g.key === 'Trending')!;
    const ranging = report.byRegimeFamily.find((g) => g.key === 'Ranging')!;

    expect(trending.totalR).toBeCloseTo(5);
    expect(ranging.totalR).toBeCloseTo(-2);
    expect(trending.averageR!).toBeGreaterThan(ranging.averageR!);
  });

  it('separates strong signals from standard ones', () => {
    const report = buildReport(trades);
    expect(report.bySignalStrength.find((g) => g.key === 'Strong')!.averageR).toBeCloseTo(3.5);
    expect(report.bySignalStrength.find((g) => g.key === 'Standard')!.closed).toBe(3);
  });

  it('splits long and short', () => {
    const report = buildReport(trades);
    expect(report.byDirection.find((g) => g.key === 'Long')!.closed).toBe(3);
    expect(report.byDirection.find((g) => g.key === 'Short')!.closed).toBe(1);
  });

  it('splits by timeframe', () => {
    const report = buildReport(trades);
    expect(report.byTimeframe.map((g) => g.key).sort()).toEqual(['1H', '4H']);
  });

  it('overall agrees with the sum of its parts', () => {
    const report = buildReport(trades);
    const fromGroups = report.byRegimeFamily.reduce((sum, g) => sum + g.totalR, 0);
    expect(report.overall.totalR).toBeCloseTo(fromGroups);
  });
});

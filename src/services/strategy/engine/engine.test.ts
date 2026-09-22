/**
 * Whole-engine guarantees.
 *
 * These two properties are worth more than any individual detector test. If
 * causality breaks, every backtest number becomes fiction. If frequency
 * collapses, the scanner is indistinguishable from a broken one — and that is
 * the failure mode the strategy spec spends an entire section warning about.
 *
 * Both are measured over generated market rather than hand-drawn bars,
 * because both are statements about behaviour across many conditions.
 */
import { describe, expect, it } from 'vitest';
import { analyse } from '../analyse';
import { runBacktest } from '../backtest';
import { isActionable, isOpportunity, TIER_THRESHOLDS, tierFor } from '../contract';
import { market } from './testFixtures';
import type { Direction } from '../contract';

/** Rough higher/lower timeframe context, as the scanner supplies in production. */
function mtf(candles: ReturnType<typeof market>, i: number) {
  const hi = candles[i]!.close - candles[i - 50]!.close;
  const lo = candles[i]!.close - candles[i - 4]!.close;
  return {
    higherTimeframeBias: (hi > 0.0005 ? 'long' : hi < -0.0005 ? 'short' : 'none') as Direction,
    entryConfirmation: (lo > 0 ? 'long' : lo < 0 ? 'short' : 'none') as Direction,
  };
}

describe('the engine is causal', () => {
  it('gives the same answer when every later bar is replaced with garbage', () => {
    // The single most important property here. A backtest of a strategy that
    // can see the future is not optimistic, it is fiction — and nothing else
    // in this file would catch it.
    let checked = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const base = market(400, seed);
      const wrecked = base.map((c, j) => (j <= 300 ? c : { ...c, open: 9, high: 9.5, low: 8.5, close: 9 }));

      for (let i = 250; i <= 300; i += 10) {
        const a = analyse(base, { symbol: 'EUR/USD', timeframe: '1H', index: i });
        const b = analyse(wrecked, { symbol: 'EUR/USD', timeframe: '1H', index: i });
        expect(b.signal).toBe(a.signal);
        expect(b.confidence).toBe(a.confidence);
        expect(b.risk.stop).toBe(a.risk.stop);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });
});

describe('the engine signals often enough to be useful', () => {
  /**
   * Sampled across twelve independent markets — the spec's "scan enough
   * markets that the strongest setups can normally be found every day".
   */
  const distribution = () => {
    const counts = { actionable: 0, early: 0, watch: 0, neutral: 0, total: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      const candles = market(500, seed);
      for (let i = 220; i < candles.length; i += 4) {
        const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: i, ...mtf(candles, i) });
        counts.total++;
        if (isActionable(a.signal)) counts.actionable++;
        else if (a.signal === 'EARLY_LONG' || a.signal === 'EARLY_SHORT') counts.early++;
        else if (a.signal === 'WATCH_LONG' || a.signal === 'WATCH_SHORT') counts.watch++;
        else counts.neutral++;
      }
    }
    return counts;
  };

  it('produces tradeable signals on a meaningful share of bars', () => {
    // The anti-over-filtering guarantee, as a number. Below ~2% a seven-pair
    // scanner goes days without a signal, which is the behaviour the spec
    // rules out.
    const c = distribution();
    const rate = c.actionable / c.total;
    expect(rate).toBeGreaterThan(0.03);
  });

  it('does not signal so often that the tiers stop meaning anything', () => {
    // The other half of the balance the spec asks for. If a third of all bars
    // are BUY, "BUY" carries no information.
    const c = distribution();
    expect(c.actionable / c.total).toBeLessThan(0.25);
  });

  it('surfaces developing setups far more often than tradeable ones', () => {
    // EARLY and WATCHLIST exist so the scanner has something to show on a day
    // with no clean entry. If they were rarer than BUY the tiers would be
    // upside down.
    const c = distribution();
    expect(c.early + c.watch).toBeGreaterThan(c.actionable);
  });

  it('still calls most bars neutral, because most bars are', () => {
    const c = distribution();
    expect(c.neutral / c.total).toBeGreaterThan(0.15);
  });
});

describe('tier boundaries agree with the score', () => {
  it('maps each band to the tier the spec names', () => {
    expect(tierFor(90, 'long')).toBe('STRONG_LONG');
    expect(tierFor(TIER_THRESHOLDS.strong, 'short')).toBe('STRONG_SHORT');
    expect(tierFor(75, 'long')).toBe('LONG');
    expect(tierFor(65, 'long')).toBe('EARLY_LONG');
    expect(tierFor(55, 'short')).toBe('WATCH_SHORT');
    expect(tierFor(40, 'long')).toBe('NEUTRAL');
  });

  it('never reports a tier that disagrees with its own confidence', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const candles = market(400, seed);
      for (let i = 250; i < candles.length; i += 9) {
        const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: i, ...mtf(candles, i) });
        if (isActionable(a.signal)) expect(a.confidence).toBeGreaterThanOrEqual(TIER_THRESHOLDS.actionable);
        if (a.signal === 'NEUTRAL') expect(a.confidence).toBeLessThan(TIER_THRESHOLDS.watch);
      }
    }
  });
});

describe('every actionable signal is tradeable', () => {
  it('carries a complete ticket whose geometry is coherent', () => {
    // A BUY with no stop, or a stop above entry, would be recorded as a trade
    // that cannot be executed or measured.
    let seen = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const candles = market(500, seed);
      for (let i = 220; i < candles.length; i += 3) {
        const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: i, ...mtf(candles, i) });
        if (!isActionable(a.signal)) continue;
        seen++;

        expect(a.risk.entry).not.toBeNull();
        expect(a.risk.stop).not.toBeNull();
        expect(a.risk.targets.length).toBeGreaterThan(0);
        expect(a.risk.invalidation).not.toBeNull();

        const { entry, stop, targets } = a.risk;
        if (a.direction === 'long') {
          expect(stop!).toBeLessThan(entry!);
          expect(targets[0]!).toBeGreaterThan(entry!);
        } else {
          expect(stop!).toBeGreaterThan(entry!);
          expect(targets[0]!).toBeLessThan(entry!);
        }

        // The reward/risk floor is a hard gate, not a preference.
        const rr = Math.abs(targets[0]! - entry!) / Math.abs(entry! - stop!);
        expect(rr).toBeGreaterThanOrEqual(1.2);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('explains itself in terms a reader can check', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const candles = market(400, seed);
      for (let i = 250; i < candles.length; i += 11) {
        const a = analyse(candles, { symbol: 'EUR/USD', timeframe: '1H', index: i, ...mtf(candles, i) });
        if (!isOpportunity(a.signal)) continue;
        expect(a.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the backtest finds trades through the same code', () => {
  it('takes trades and resolves them against structure', () => {
    const result = runBacktest(market(1000, 3), { symbol: 'EUR/USD', timeframe: '1H' });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.note).toBeNull();
    // Both outcomes must occur, or the exit logic is only half exercised.
    expect(result.trades.some((t) => t.exit === 'sl')).toBe(true);
    expect(result.trades.some((t) => t.exit.startsWith('tp'))).toBe(true);
  });

  it('measures R against the stop the trade was sized against', () => {
    const result = runBacktest(market(1000, 5), { symbol: 'EUR/USD', timeframe: '1H' });
    for (const t of result.trades) {
      if (t.rMultiple === null) continue;
      expect(Number.isFinite(t.rMultiple)).toBe(true);
      // A full stop-out is −1R by construction; anything worse means R was
      // divided by a stop that had already moved.
      if (t.exit === 'sl') expect(t.rMultiple).toBeCloseTo(-1, 1);
    }
  });
});

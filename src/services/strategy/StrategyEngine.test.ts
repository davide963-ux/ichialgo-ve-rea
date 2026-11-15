import { describe, expect, it } from 'vitest';
import { STRATEGY_CONFIG } from '../../config/strategy';
import { candlesAreDue, mergeSignals, type PairState } from './StrategyEngine';
import type { TouchSignal } from './types';

const signal = (over: Partial<TouchSignal> = {}): TouchSignal => ({
  id: 'ema50-touch|EUR/USD|30M|1000',
  strategy: 'ema50-touch',
  symbol: 'EUR/USD',
  timeframe: '30M',
  barTime: 1000,
  detectedAt: 10,
  source: 'candle',
  price: 1.1,
  ema: 1.1,
  tolerancePips: 2,
  atr: 0.0008,
  distancePips: 0.4,
  approach: 'above',
  outcome: 'bounce',
  trend: 'up',
  bias: 'long',
  counterTrend: false,
  ichimoku: null,
  ...over,
});

describe('mergeSignals', () => {
  it('orders by market time, newest first', () => {
    const out = mergeSignals([], [signal({ id: 'a', barTime: 1000 }), signal({ id: 'b', barTime: 2000 })], 10);
    expect(out.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('ranks a live tick by its own time, not by its bar', () => {
    const oldBarLiveTick = signal({ id: 'live', source: 'live', barTime: 100, detectedAt: 9_000_000 });
    const recentClosedBar = signal({ id: 'closed', source: 'candle', barTime: 8_000, detectedAt: 0 });
    const out = mergeSignals([], [recentClosedBar, oldBarLiveTick], 10);
    expect(out[0]!.id).toBe('live');
  });

  it('never duplicates the same bar across scans', () => {
    const first = mergeSignals([], [signal()], 10);
    const second = mergeSignals(first, [signal()], 10);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // same reference → no re-render
  });

  it('upgrades a live touch with the closed-bar result, keeping the original time', () => {
    const live = mergeSignals([], [signal({ source: 'live', outcome: 'pending', detectedAt: 5 })], 10);
    const closed = mergeSignals(live, [signal({ source: 'candle', outcome: 'cross', detectedAt: 90 })], 10);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.source).toBe('candle');
    expect(closed[0]!.outcome).toBe('cross');
    expect(closed[0]!.detectedAt).toBe(5); // when the user actually saw it
  });

  it('does not let a later live tick overwrite a resolved bar', () => {
    const closed = mergeSignals([], [signal({ outcome: 'bounce' })], 10);
    const after = mergeSignals(closed, [signal({ source: 'live', outcome: 'pending', detectedAt: 99 })], 10);
    expect(after[0]!.outcome).toBe('bounce');
    expect(after).toBe(closed);
  });

  it('caps the log at the configured size, dropping the oldest', () => {
    const many = Array.from({ length: 30 }, (_, i) => signal({ id: `s${i}`, barTime: 1000 + i }));
    const out = mergeSignals([], many, 5);
    expect(out).toHaveLength(5);
    expect(out[0]!.id).toBe('s29');
    expect(out.at(-1)!.id).toBe('s25');
  });

  it('is a no-op for an empty batch', () => {
    const existing = mergeSignals([], [signal()], 10);
    expect(mergeSignals(existing, [], 10)).toBe(existing);
  });
});

// ── the fetch schedule ────────────────────────────────────────────────────

const LAG = 60_000;
const FLOOR = 120_000;
const H1 = 3600;          // bar length in seconds
const M30 = 1800;

/** State as the engine records it: bar open time in seconds, fetch time in ms. */
const state = (newestBarTime: number, fetchedAt: number): PairState => ({ newestBarTime, fetchedAt });

describe('candlesAreDue', () => {
  it('asks for a pair it has never seen', () => {
    expect(candlesAreDue(0, undefined, M30, LAG, FLOOR)).toBe(true);
  });

  it('leaves a pair alone while its bar is still forming', () => {
    // Bar opened at t=0 and closes at 1800s. Half way through, nothing to get.
    const now = 900_000;
    expect(candlesAreDue(now, state(0, now - FLOOR - 1), M30, LAG, FLOOR)).toBe(false);
  });

  /**
   * The grace period is the difference between asking for a bar and getting
   * it: providers publish a closed bar late, so a request on the stroke of
   * the close returns the same data and spends the round trip for nothing.
   */
  it('waits out the grace period after the close', () => {
    const closesAt = M30 * 1000;
    const old = -FLOOR; // last fetched long ago, so only the bar rule decides
    expect(candlesAreDue(closesAt + LAG - 1, state(0, old), M30, LAG, FLOOR)).toBe(false);
    expect(candlesAreDue(closesAt + LAG, state(0, old), M30, LAG, FLOOR)).toBe(true);
  });

  it('respects the floor even when the bar has closed', () => {
    const now = (M30 + 600) * 1000;              // well past the close
    expect(candlesAreDue(now, state(0, now - FLOOR + 1), M30, LAG, FLOOR)).toBe(false);
    expect(candlesAreDue(now, state(0, now - FLOOR), M30, LAG, FLOOR)).toBe(true);
  });

  /**
   * A provider whose newest bar stops advancing leaves that bar permanently
   * past its close, so the bar rule alone would fire on every single tick.
   * The floor is what makes that a bounded retry instead of a hot loop.
   */
  it('backs a late provider off to the floor instead of every tick', () => {
    const stuckBar = 0;                           // its newest bar never advances
    const start = M30 * 1000;                     // fetched right after the close
    const end = start + 600_000;                  // fixed: the window cannot recede
    let fetchedAt = start;
    const at: number[] = [];
    for (let now = start; now < end; now += 30_000) {
      if (candlesAreDue(now, state(stuckBar, fetchedAt), M30, LAG, FLOOR)) {
        at.push(now);
        fetchedAt = now;
      }
    }
    // Twenty ticks in the window; the floor allows four.
    expect(at).toHaveLength(4);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBe(FLOOR);
  });
});

/**
 * The claim this change was made for, pinned to a number.
 *
 * The old engine fetched every pair every scan, and scanned on a fixed
 * interval derived from Twelve Data's credit budget — 30 times an hour on the
 * default config. Bars do not close that often, so almost all of it was the
 * same data twice.
 */
describe('fetches per hour, simulated at a 30s tick', () => {
  const simulate = (barSeconds: number) => {
    let st: PairState | undefined;
    let fetches = 0;
    // Start aligned to a bar open so the window is a whole number of bars.
    for (let now = 0; now < 3_600_000; now += STRATEGY_CONFIG.scanTickMs) {
      if (candlesAreDue(now, st, barSeconds, LAG, FLOOR)) {
        fetches++;
        // What the engine does on a fetch: record the bar in progress now.
        st = { newestBarTime: Math.floor(now / 1000 / barSeconds) * barSeconds, fetchedAt: now };
      }
    }
    return fetches;
  };

  it('is one per bar close, not one per tick', () => {
    // 120 ticks an hour. The old loop fetched on 30 of them; these are bar closes.
    expect(simulate(M30)).toBe(2); // 30M: two bars an hour
    expect(simulate(H1)).toBe(1);  // 1H:  one
    expect(simulate(14400)).toBe(1); // 4H: the first fetch, then nothing
  });

  it('is a large cut against the old fixed interval', () => {
    const OLD_SCANS_PER_HOUR = 30; // max(60s, candleRefreshMs=120s) → every 2 min
    expect(simulate(M30)).toBeLessThan(OLD_SCANS_PER_HOUR / 10);
  });
});

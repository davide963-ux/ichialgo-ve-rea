import { describe, expect, it } from 'vitest';
import { mergeSignals } from './StrategyEngine';
import type { TouchSignal } from './types';

const signal = (over: Partial<TouchSignal> = {}): TouchSignal => ({
  id: 'ema50-touch|EUR/USD|15M|1000',
  strategy: 'ema50-touch',
  symbol: 'EUR/USD',
  timeframe: '15M',
  barTime: 1000,
  detectedAt: 10,
  source: 'candle',
  price: 1.1,
  ema: 1.1,
  tolerancePips: 2,
  distancePips: 0.4,
  approach: 'above',
  outcome: 'bounce',
  trend: 'up',
  bias: 'long',
  counterTrend: false,
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

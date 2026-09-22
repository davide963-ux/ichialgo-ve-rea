/**
 * The tracker decides what is NEWS. Its failures are all silent ones:
 * a duplicate signal every fifteen minutes, or a pair that goes quiet forever
 * while the scanner reports itself healthy. Neither throws, so only tests
 * catch them.
 */
import { describe, expect, it } from 'vitest';
import { SetupTracker, setupKey } from './lifecycle';
import type { StrategyAnalysis } from './contract';

let clock = 1_000_000;
const tracker = () => new SetupTracker({ now: () => clock });

const analysis = (over: Partial<StrategyAnalysis> = {}): StrategyAnalysis => ({
  symbol: 'EUR/USD',
  timeframe: '1H',
  barTime: 1_700_000_000,
  barClosed: true,
  direction: 'long',
  signal: 'LONG',
  confidence: 70,
  marketCondition: 'TRENDING_BULLISH',
  status: 'CONFIRMED',
  price: 1.1,
  risk: { entry: 1.1, stop: 1.098, targets: [1.103], stopPips: 20, invalidation: null },
  anchor: 1,
  reasons: [],
  warnings: [],
  detail: {},
  ...over,
});

describe('setupKey', () => {
  it('separates the same pair on different timeframes', () => {
    expect(setupKey('EUR/USD', '1H')).not.toBe(setupKey('EUR/USD', '4H'));
  });
});

describe('emitting', () => {
  it('emits a confirmed, actionable setup the first time it is seen', () => {
    const d = tracker().update(analysis());
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('new-setup');
  });

  it('does not emit a setup that is still forming', () => {
    expect(tracker().update(analysis({ status: 'CONFIRMING' })).emit).toBe(false);
  });

  it('does not emit a WATCH, however confident', () => {
    // Confirmed but not actionable: the grade is the gate, not the status.
    expect(tracker().update(analysis({ signal: 'WATCH_LONG', confidence: 99 })).emit).toBe(false);
  });

  it('emits when a watched setup crosses into confirmed', () => {
    const t = tracker();
    expect(t.update(analysis({ status: 'CONFIRMING', signal: 'WATCH_LONG' })).emit).toBe(false);
    const d = t.update(analysis({ barTime: 1_700_003_600 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('confirmed');
  });
});

describe('not emitting the same thing twice', () => {
  it('stays silent while the same setup keeps confirming', () => {
    const t = tracker();
    t.update(analysis());
    // The scanner re-derives this same conclusion every run; only the first
    // one is news.
    expect(t.update(analysis({ barTime: 1_700_003_600 })).emit).toBe(false);
    expect(t.update(analysis({ barTime: 1_700_007_200 })).emit).toBe(false);
  });

  it('ignores a trivial confidence wobble', () => {
    const t = tracker();
    t.update(analysis({ confidence: 70 }));
    expect(t.update(analysis({ confidence: 78, barTime: 1_700_003_600 })).emit).toBe(false);
  });

  it('re-emits when confidence improves materially', () => {
    const t = tracker();
    t.update(analysis({ confidence: 70 }));
    const d = t.update(analysis({ confidence: 90, barTime: 1_700_003_600 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('upgraded');
  });

  it('treats a different anchor as a genuinely new setup', () => {
    const t = tracker();
    t.update(analysis({ anchor: 1 }));
    const d = t.update(analysis({ anchor: 2, barTime: 1_700_003_600 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('new-setup');
  });

  it('treats a direction flip as a new setup', () => {
    const t = tracker();
    t.update(analysis({ direction: 'long', signal: 'LONG' }));
    const d = t.update(analysis({ direction: 'short', signal: 'SHORT', barTime: 1_700_003_600 }));
    expect(d.emit).toBe(true);
  });
});

describe('one position per pair', () => {
  it('suppresses everything once a setup is ACTIVE', () => {
    const t = tracker();
    t.update(analysis());
    t.activate('EUR/USD', '1H');
    expect(t.update(analysis({ anchor: 99, confidence: 100, barTime: 1_700_003_600 })).emit).toBe(false);
  });

  it('releases the pair once the trade completes — otherwise it is silent forever', () => {
    // This is the bug that made a pair go permanently quiet after its first
    // trade while the scanner still looked healthy.
    const t = tracker();
    t.update(analysis());
    t.activate('EUR/USD', '1H');
    t.complete('EUR/USD', '1H');
    expect(t.update(analysis({ barTime: 1_700_010_000 })).emit).toBe(true);
  });

  it('does not let one pair\'s state leak into another', () => {
    const t = tracker();
    t.update(analysis());
    t.activate('EUR/USD', '1H');
    expect(t.update(analysis({ symbol: 'GBP/USD' })).emit).toBe(true);
  });
});

describe('invalidation', () => {
  it('reports an invalidation of a setup that was actually live', () => {
    const t = tracker();
    t.update(analysis({ status: 'CONFIRMING', signal: 'WATCH_LONG' }));
    const d = t.update(analysis({ status: 'INVALIDATED', barTime: 1_700_003_600 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('invalidated');
  });

  it('says nothing when there was never a setup to invalidate', () => {
    // A cold start seeing INVALIDATED must not announce a setup nobody saw.
    expect(tracker().update(analysis({ status: 'INVALIDATED' })).emit).toBe(false);
  });
});

describe('surviving a cold start', () => {
  it('rehydrates and does not re-emit what was already emitted', () => {
    const first = tracker();
    first.update(analysis());
    first.activate('EUR/USD', '1H');
    const saved = first.snapshot();

    // A serverless scanner starts with an empty Map every single run.
    const second = tracker();
    second.load(saved);
    expect(second.update(analysis({ barTime: 1_700_003_600 })).emit).toBe(false);
  });

  it('snapshots copies, so mutating the result cannot corrupt the tracker', () => {
    const t = tracker();
    t.update(analysis());
    const snap = t.snapshot();
    snap[0]!.status = 'COMPLETED';
    expect(t.get('EUR/USD', '1H')!.status).toBe('CONFIRMED');
  });
});

describe('eviction', () => {
  it('forgets a stale emitted setup', () => {
    const t = new SetupTracker({ now: () => clock, staleMs: 1000 });
    t.update(analysis());
    clock += 5000;
    // Evicted, so the same setup reads as new again rather than being
    // suppressed by a record nobody is maintaining.
    expect(t.update(analysis({ barTime: 1_700_010_000 })).emit).toBe(true);
    clock -= 5000;
  });

  it('never evicts an ACTIVE setup, however long the trade runs', () => {
    const t = new SetupTracker({ now: () => clock, staleMs: 1000 });
    t.update(analysis());
    t.activate('EUR/USD', '1H');
    clock += 100_000;
    expect(t.update(analysis({ barTime: 1_700_010_000 })).emit).toBe(false);
    clock -= 100_000;
  });
});

import { describe, expect, it } from 'vitest';
import { SetupTracker, setupKey } from './setupTracker';
import type { ConfluenceAnalysis, ConfluenceSignal, SetupStatus } from './types';

/** Minimal analysis object — only the fields the tracker reads. */
function analysis(over: {
  status: SetupStatus;
  signal?: ConfluenceSignal;
  direction?: 'long' | 'short' | 'none';
  confidence?: number;
  barTime?: number;
  stopRef?: number | null;
  symbol?: string;
}): ConfluenceAnalysis {
  return {
    symbol: over.symbol ?? 'EUR/USD',
    timeframe: '1H',
    barTime: over.barTime ?? 1_700_000_000,
    barClosed: true,
    direction: over.direction ?? 'long',
    signal: over.signal ?? 'LONG',
    confidence: over.confidence ?? 70,
    marketCondition: 'TRENDING_BULLISH',
    price: 1.1,
    atr: 0.001,
    ema50: null,
    ichimoku: null,
    confluence: null,
    marketStructure: null,
    setup: {
      status: over.status,
      pullback: 'healthy',
      pullbackQuality: 0.8,
      retracementPct: 0.4,
      confirmation: over.status === 'CONFIRMED',
      confirmationReason: null,
      entryCondition: null,
    },
    risk: {
      suggestedStopReference: over.stopRef === undefined ? 1.09 : over.stopRef,
      stopDistanceAtr: 1,
      stopPips: 20,
      entry: 1.1,
      targets: [],
      invalidationCondition: null,
    },
    multiTimeframe: null,
    scoreReasons: [],
    reasons: [],
    warnings: [],
  };
}

describe('SetupTracker — the same setup is emitted once', () => {
  it('emits on the bar a setup becomes CONFIRMED', () => {
    const t = new SetupTracker();
    expect(t.update(analysis({ status: 'FORMING', signal: 'WATCH_LONG' })).emit).toBe(false);
    expect(t.update(analysis({ status: 'CONFIRMING', signal: 'LONG' })).emit).toBe(false);

    const d = t.update(analysis({ status: 'CONFIRMED' }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('confirmed');
  });

  it('stays silent while the same setup remains confirmed', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED', barTime: 1 }));

    for (let bar = 2; bar <= 10; bar++) {
      expect(t.update(analysis({ status: 'CONFIRMED', barTime: bar })).emit).toBe(false);
    }
  });

  it('is the difference between one signal and ten — the old bug', () => {
    const t = new SetupTracker();
    let emitted = 0;
    for (let bar = 1; bar <= 10; bar++) {
      if (t.update(analysis({ status: 'CONFIRMED', barTime: bar })).emit) emitted++;
    }
    expect(emitted).toBe(1);
  });
});

describe('SetupTracker — what counts as a new setup', () => {
  it('emits again when the impulse changes, even in the same direction', () => {
    const t = new SetupTracker();
    expect(t.update(analysis({ status: 'CONFIRMED', stopRef: 1.09 })).emit).toBe(true);
    expect(t.update(analysis({ status: 'CONFIRMED', stopRef: 1.09, barTime: 2 })).emit).toBe(false);

    const d = t.update(analysis({ status: 'CONFIRMED', stopRef: 1.12, barTime: 3 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('new-setup');
  });

  it('emits when the direction flips', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED', direction: 'long' }));
    const d = t.update(analysis({ status: 'CONFIRMED', direction: 'short', signal: 'SHORT', barTime: 2 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('new-setup');
  });

  it('keeps setups on different pairs apart', () => {
    const t = new SetupTracker();
    expect(t.update(analysis({ status: 'CONFIRMED', symbol: 'EUR/USD' })).emit).toBe(true);
    expect(t.update(analysis({ status: 'CONFIRMED', symbol: 'GBP/USD' })).emit).toBe(true);
    expect(t.update(analysis({ status: 'CONFIRMED', symbol: 'EUR/USD', barTime: 2 })).emit).toBe(false);
  });
});

describe('SetupTracker — upgrades', () => {
  it('re-emits when confidence improves materially', () => {
    const t = new SetupTracker({ upgradeDelta: 10 });
    t.update(analysis({ status: 'CONFIRMED', confidence: 65 }));

    expect(t.update(analysis({ status: 'CONFIRMED', confidence: 70, barTime: 2 })).emit).toBe(false);
    const d = t.update(analysis({ status: 'CONFIRMED', confidence: 80, barTime: 3 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('upgraded');
  });

  it('does not re-emit for noise around the threshold', () => {
    const t = new SetupTracker({ upgradeDelta: 12 });
    t.update(analysis({ status: 'CONFIRMED', confidence: 70 }));
    let emitted = 0;
    for (const c of [71, 69, 72, 68, 73, 70]) {
      if (t.update(analysis({ status: 'CONFIRMED', confidence: c, barTime: c })).emit) emitted++;
    }
    expect(emitted).toBe(0);
  });
});

describe('SetupTracker — an active trade owns the pair', () => {
  it('suppresses everything once activated', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED' }));
    t.activate('EUR/USD', '1H');

    expect(t.update(analysis({ status: 'CONFIRMED', barTime: 2, stopRef: 1.2 })).emit).toBe(false);
    expect(t.update(analysis({ status: 'CONFIRMED', direction: 'short', signal: 'SHORT', barTime: 3 })).emit).toBe(false);
    expect(t.get('EUR/USD', '1H')!.status).toBe('ACTIVE');
  });

  it('accepts new setups again once the trade completes', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED' }));
    t.activate('EUR/USD', '1H');
    t.complete('EUR/USD', '1H');

    expect(t.update(analysis({ status: 'CONFIRMED', barTime: 5 })).emit).toBe(true);
  });
});

describe('SetupTracker — invalidation', () => {
  it('reports invalidation of a setup it was tracking', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED' }));
    const d = t.update(analysis({ status: 'INVALIDATED', signal: 'NO_TRADE', barTime: 2 }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('invalidated');
  });

  it('does not report invalidation it never saw form', () => {
    const t = new SetupTracker();
    expect(t.update(analysis({ status: 'INVALIDATED', signal: 'NO_TRADE' })).emit).toBe(false);
  });

  it('does not report the same invalidation twice', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED' }));
    t.update(analysis({ status: 'INVALIDATED', signal: 'NO_TRADE', barTime: 2 }));
    expect(t.update(analysis({ status: 'INVALIDATED', signal: 'NO_TRADE', barTime: 3 })).emit).toBe(false);
  });
});

describe('SetupTracker — persistence across a cold start', () => {
  it('does not re-emit a setup it already emitted before restarting', () => {
    const first = new SetupTracker();
    expect(first.update(analysis({ status: 'CONFIRMED' })).emit).toBe(true);
    const saved = first.snapshot();

    const restarted = new SetupTracker();
    restarted.load(saved);
    expect(restarted.update(analysis({ status: 'CONFIRMED', barTime: 2 })).emit).toBe(false);
  });

  it('round-trips the tracked state', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED', confidence: 77 }));
    const [s] = t.snapshot();
    expect(s).toMatchObject({
      key: setupKey('EUR/USD', '1H'),
      symbol: 'EUR/USD',
      direction: 'long',
      status: 'CONFIRMED',
      emittedConfidence: 77,
    });
  });

  it('a snapshot is a copy — mutating it cannot corrupt the tracker', () => {
    const t = new SetupTracker();
    t.update(analysis({ status: 'CONFIRMED' }));
    const snap = t.snapshot();
    snap[0]!.status = 'COMPLETED';
    expect(t.get('EUR/USD', '1H')!.status).toBe('CONFIRMED');
  });
});

describe('SetupTracker — eviction', () => {
  it('forgets a stale setup, so the same pair can signal again much later', () => {
    let clock = 1_000_000;
    const t = new SetupTracker({ staleMs: 1000, now: () => clock });
    expect(t.update(analysis({ status: 'CONFIRMED' })).emit).toBe(true);

    clock += 5000;
    expect(t.update(analysis({ status: 'CONFIRMED', barTime: 2 })).emit).toBe(true);
  });

  it('never evicts an active trade', () => {
    let clock = 1_000_000;
    const t = new SetupTracker({ staleMs: 1000, now: () => clock });
    t.update(analysis({ status: 'CONFIRMED' }));
    t.activate('EUR/USD', '1H');

    clock += 999_999;
    expect(t.update(analysis({ status: 'CONFIRMED', barTime: 9 })).emit).toBe(false);
    expect(t.get('EUR/USD', '1H')!.status).toBe('ACTIVE');
  });
});

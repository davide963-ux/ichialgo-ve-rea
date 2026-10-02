/**
 * Polling must stop while nobody is looking.
 *
 * WHY THIS HAS TESTS AT ALL
 * ─────────────────────────
 * This is credit-spending behaviour on a metered provider, and it is the
 * single largest consumer in the app: seven pairs at the default sixty-second
 * interval spend roughly 420 credits an hour, so one forgotten background tab
 * exhausts a 4,000-credit daily budget in under ten hours — after which the
 * charts, the backtest and the 24/7 scanner all fail on an exhausted key.
 *
 * A regression here does not throw and does not show up in the UI. It shows up
 * days later as "the data stopped working", which is exactly how it was found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataService } from './MarketDataService';
import type { MarketDataProvider, Quote } from './types';

/** Minimal stand-in for the parts of `document` the service touches. */
function stubDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return {
    hide() {
      doc.visibilityState = 'hidden';
      for (const fn of [...listeners]) fn();
    },
    show() {
      doc.visibilityState = 'visible';
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

const quote = (symbol: string): Quote => ({
  symbol,
  price: 1.1,
  bid: null,
  ask: null,
  spreadPips: null,
  changePct: 0,
  timestamp: Date.now(),
  receivedAt: Date.now(),
  marketOpen: true,
});

function fakeProvider(pollIntervalMs = 60_000) {
  let quoteCalls = 0;
  const provider: MarketDataProvider = {
    id: 'twelvedata' as MarketDataProvider['id'],
    label: 'Fake',
    capabilities: {
      streaming: false,
      bidAsk: false,
      pollIntervalMs,
    } as MarketDataProvider['capabilities'],
    async assertConfigured() {},
    async getQuotes(symbols: string[]) {
      quoteCalls++;
      return { quotes: symbols.map(quote), failed: [] };
    },
    async getCandles() {
      return [];
    },
  } as MarketDataProvider;
  return { provider, calls: () => quoteCalls };
}

describe('polling suspends while the tab is hidden', () => {
  let dom: ReturnType<typeof stubDocument>;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = stubDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { document?: unknown }).document;
  });

  it('stops requesting quotes once the tab goes to the background', async () => {
    const { provider, calls } = fakeProvider();
    const service = new MarketDataService(provider, ['EUR/USD']);

    await service.start();
    const afterStart = calls();
    expect(afterStart).toBeGreaterThan(0);

    dom.hide();
    // Far longer than several poll intervals. Nothing may be spent.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toBe(afterStart);

    service.stop();
  });

  it('keeps polling while the tab stays visible', async () => {
    // The control: without this, a test that simply never polls would pass
    // the suspension test above for entirely the wrong reason.
    const { provider, calls } = fakeProvider(1_000);
    const service = new MarketDataService(provider, ['EUR/USD']);

    await service.start();
    const afterStart = calls();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBeGreaterThan(afterStart);

    service.stop();
  });

  it('takes one fresh reading the moment the tab comes back', async () => {
    // Without this, a returning user's first sight is a stale price with
    // nothing saying it is stale — worse than the credits it saves.
    const { provider, calls } = fakeProvider();
    const service = new MarketDataService(provider, ['EUR/USD']);

    await service.start();
    dom.hide();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const whileHidden = calls();

    dom.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(whileHidden + 1);

    service.stop();
  });

  it('resumes the normal interval after coming back, not a burst', async () => {
    const { provider, calls } = fakeProvider(1_000);
    const service = new MarketDataService(provider, ['EUR/USD']);

    await service.start();
    dom.hide();
    await vi.advanceTimersByTimeAsync(10_000);
    dom.show();
    await vi.advanceTimersByTimeAsync(0);
    const onReturn = calls();

    // One interval later: exactly one more reading, not a backlog replay.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(onReturn + 1);

    service.stop();
  });

  it('detaches its listener on stop, so a restarted service does not double-poll', async () => {
    const { provider } = fakeProvider();
    const service = new MarketDataService(provider, ['EUR/USD']);

    await service.start();
    expect(dom.listenerCount()).toBe(1);

    service.stop();
    expect(dom.listenerCount()).toBe(0);
  });

  it('starts cleanly where there is no document at all', async () => {
    // The scanner imports this module server-side. A bare `document` reference
    // would crash the serverless function rather than the browser.
    delete (globalThis as { document?: unknown }).document;
    const { provider, calls } = fakeProvider();
    const service = new MarketDataService(provider, ['EUR/USD']);

    await expect(service.start()).resolves.toBeUndefined();
    expect(calls()).toBeGreaterThan(0);

    service.stop();
  });
});

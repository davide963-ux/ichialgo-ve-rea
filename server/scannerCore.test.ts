import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/services/marketData/types';
import type { TrackedSetup } from '../src/services/strategy/confluence';
import {
  DEFAULT_SCANNER_CONFIG,
  isSessionActive,
  resolveOutcome,
  runScan,
  type MarketFeed,
  type ScannerConfig,
} from './scannerCore';
import type { Outcome, PendingSignal, SignalRow, SignalsDb } from './signalsDb';

const PIP = 0.0001;

/** The same fixture shape the engine tests use: a trend with real swings. */
function toCandles(closes: readonly number[], wickPips = 4): Candle[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: i === 0 ? close : closes[i - 1]!,
    high: close + wickPips * PIP,
    low: close - wickPips * PIP,
    close,
    volume: null,
    complete: true,
  }));
}

const wave = (n: number, drift: number, amp: number, period: number) =>
  Array.from({ length: n }, (_, i) => 1.05 + i * drift * PIP + Math.sin((i / period) * 2 * Math.PI) * amp * PIP);

/** An uptrend pulled back into the zone with a rejection bar — fires LONG. */
function longSetupCandles(): Candle[] {
  const bars = toCandles(wave(130, 0.8, 25, 16));
  const last = bars[bars.length - 1]!;
  last.low = last.close - 20 * PIP;
  last.close = last.open + 6 * PIP;
  last.high = last.close + 1 * PIP;
  return bars;
}

/** A dead flat market — nothing should ever fire on it. */
const flatCandles = () => toCandles(Array.from({ length: 130 }, () => 1.1));

class FakeDb implements SignalsDb {
  setupState: TrackedSetup[] = [];
  pending: PendingSignal[] = [];
  recorded: SignalRow[] = [];
  closes: { id: string; outcome: Outcome; price: number }[] = [];
  breakevens: string[] = [];
  runs: number[] = [];
  lastRun: number | null = null;
  expired = 0;
  failOn: string | null = null;

  private guard(name: string) {
    if (this.failOn === name) throw new Error(`${name} exploded`);
  }

  async loadSetupState() {
    this.guard('loadSetupState');
    return this.setupState;
  }
  async saveSetupState(s: readonly TrackedSetup[]) {
    this.guard('saveSetupState');
    this.setupState = s.map((x) => ({ ...x }));
    return s.length;
  }
  async loadPending() {
    this.guard('loadPending');
    return this.pending;
  }
  async recordSignals(rows: readonly SignalRow[]) {
    this.guard('recordSignals');
    // Same rule as SQL: the id is the key, a repeat changes nothing.
    let inserted = 0;
    for (const r of rows) {
      if (this.recorded.some((x) => x.id === r.id)) continue;
      this.recorded.push(r);
      inserted++;
    }
    return inserted;
  }
  async closeSignal(id: string, outcome: Outcome, price: number) {
    this.guard('closeSignal');
    const row = this.pending.find((p) => p.id === id);
    if (!row) return 0;
    this.pending = this.pending.filter((p) => p.id !== id);
    this.closes.push({ id, outcome, price });
    return 1;
  }
  async markBreakeven(id: string) {
    this.guard('markBreakeven');
    const row = this.pending.find((p) => p.id === id);
    if (!row || row.tp1_hit) return 0;
    row.tp1_hit = true;
    row.stop_loss = row.entry;
    this.breakevens.push(id);
    return 1;
  }
  async lastRunStartedAt() {
    return this.lastRun;
  }
  cursor = 0;
  async lastCursor() {
    return this.cursor;
  }
  async startRun() {
    this.runs.push(Date.now());
    return this.runs.length;
  }
  async finishRun(_id: number | null, summary: { detail?: unknown }) {
    const detail = summary.detail as { nextOffset?: number } | undefined;
    if (typeof detail?.nextOffset === 'number') this.cursor = detail.nextOffset;
  }
  async expireStale() {
    return this.expired;
  }
}

class FakeFeed implements MarketFeed {
  credits = 0;
  candleCalls: string[] = [];
  priceCalls: string[] = [];
  prices = new Map<string, number>();
  series = new Map<string, Candle[]>();
  failSymbols = new Set<string>();
  private cache = new Map<string, Candle[]>();

  constructor(private readonly fallback: () => Candle[] = flatCandles) {}

  set(symbol: string, timeframe: string, candles: Candle[]) {
    this.series.set(`${symbol}|${timeframe}`, candles);
  }

  async candles(symbol: string, timeframe: string) {
    const key = `${symbol}|${timeframe}`;
    this.candleCalls.push(key);
    if (this.failSymbols.has(symbol)) throw new Error(`feed down for ${symbol}`);
    const cached = this.cache.get(key);
    if (cached) return cached;
    this.credits += 1;
    const data = this.series.get(key) ?? this.fallback();
    this.cache.set(key, data);
    return data;
  }

  async price(symbol: string) {
    this.priceCalls.push(symbol);
    if (this.failSymbols.has(symbol)) throw new Error(`no price for ${symbol}`);
    this.credits += 1;
    return this.prices.get(symbol) ?? 1.1;
  }

  creditsUsed() {
    return this.credits;
  }
}

/** Monday 12:00 UTC — inside the session window. */
const MONDAY_NOON = Date.UTC(2026, 8, 21, 12, 0, 0);
/** Saturday 12:00 UTC. */
const SATURDAY_NOON = Date.UTC(2026, 8, 19, 12, 0, 0);

const smallConfig = (over: Partial<ScannerConfig> = {}): ScannerConfig => ({
  ...DEFAULT_SCANNER_CONFIG,
  symbols: ['EUR/USD', 'GBP/USD'],
  timeframes: ['1H'],
  biasTimeframe: null,
  ...over,
});

const pendingSignal = (over: Partial<PendingSignal> = {}): PendingSignal => ({
  id: 'sig-1',
  symbol: 'EUR/USD',
  timeframe: '1H',
  direction: 'long',
  entry: 1.1,
  stop_loss: 1.098,
  take_profit1: 1.103,
  take_profit2: 1.105,
  take_profit3: 1.107,
  tp1_hit: false,
  bar_time: '2026-09-20T10:00:00Z',
  ...over,
});

describe('isSessionActive', () => {
  it('is open during the weekday window', () => {
    expect(isSessionActive(MONDAY_NOON, [7, 21])).toBe(true);
  });

  it('is closed outside the hours', () => {
    expect(isSessionActive(Date.UTC(2026, 8, 21, 3, 0), [7, 21])).toBe(false);
    expect(isSessionActive(Date.UTC(2026, 8, 21, 22, 0), [7, 21])).toBe(false);
  });

  it('is closed at weekends — the reference implementation checked only the hour', () => {
    expect(isSessionActive(SATURDAY_NOON, [7, 21])).toBe(false);
    expect(isSessionActive(Date.UTC(2026, 8, 20, 12, 0), [7, 21])).toBe(false); // Sunday
  });
});

describe('resolveOutcome', () => {
  it('closes a long at the stop', () => {
    expect(resolveOutcome(pendingSignal(), 1.0979)).toEqual({ outcome: 'sl', breakeven: false });
  });

  it('closes a short at the stop', () => {
    const short = pendingSignal({ direction: 'short', entry: 1.1, stop_loss: 1.102, take_profit1: 1.097, take_profit2: 1.095, take_profit3: 1.093 });
    expect(resolveOutcome(short, 1.1021)).toEqual({ outcome: 'sl', breakeven: false });
  });

  it('moves to breakeven on TP1 rather than closing', () => {
    expect(resolveOutcome(pendingSignal(), 1.1031)).toEqual({ outcome: null, breakeven: true });
  });

  it('closes at the furthest target reached', () => {
    expect(resolveOutcome(pendingSignal({ tp1_hit: true }), 1.1071).outcome).toBe('tp3');
    expect(resolveOutcome(pendingSignal({ tp1_hit: true }), 1.1051).outcome).toBe('tp2');
  });

  it('reports a breakeven stop, not a loss, once TP1 has been hit', () => {
    const moved = pendingSignal({ tp1_hit: true, stop_loss: 1.1 });
    expect(resolveOutcome(moved, 1.0999)).toEqual({ outcome: 'be', breakeven: false });
  });

  it('lets the stop win on a corrupted ticket whose levels cross', () => {
    // Well-formed levels cannot satisfy both tests at one price, so this only
    // arises if a ticket is wrong. The stop is still checked first, so the bad
    // row resolves as a loss rather than booking a phantom win.
    const crossed = pendingSignal({ stop_loss: 1.106, take_profit3: 1.105 });
    expect(resolveOutcome(crossed, 1.1055).outcome).toBe('sl');
  });

  it('does nothing while price sits between the levels', () => {
    expect(resolveOutcome(pendingSignal(), 1.101)).toEqual({ outcome: null, breakeven: false });
  });

  it('returns nothing when the ticket is incomplete', () => {
    expect(resolveOutcome(pendingSignal({ entry: null }), 1.2).outcome).toBeNull();
  });
});

describe('runScan — the interval guard', () => {
  it('refuses to run again inside the window', async () => {
    const db = new FakeDb();
    db.lastRun = MONDAY_NOON - 60_000;
    const result = await runScan({ db, feed: new FakeFeed(), config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.skipped).toMatch(/next allowed in/);
    expect(db.runs).toHaveLength(0);
  });

  it('runs once the window has passed', async () => {
    const db = new FakeDb();
    db.lastRun = MONDAY_NOON - 15 * 60_000;
    const result = await runScan({ db, feed: new FakeFeed(), config: smallConfig(), now: () => MONDAY_NOON });
    expect(result.skipped).toBeUndefined();
  });

  it('force overrides it', async () => {
    const db = new FakeDb();
    db.lastRun = MONDAY_NOON;
    const result = await runScan({ db, feed: new FakeFeed(), config: smallConfig(), now: () => MONDAY_NOON, force: true });
    expect(result.skipped).toBeUndefined();
  });
});

describe('runScan — trade management runs even when the market is shut', () => {
  it('still checks open trades at the weekend', async () => {
    const db = new FakeDb();
    db.pending = [pendingSignal()];
    const feed = new FakeFeed();
    feed.prices.set('EUR/USD', 1.0979); // stop hit

    const result = await runScan({ db, feed, config: smallConfig(), now: () => SATURDAY_NOON });

    expect(result.sessionActive).toBe(false);
    expect(db.closes).toEqual([{ id: 'sig-1', outcome: 'sl', price: 1.0979 }]);
  });

  it('does not look for new setups outside the session', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);

    const result = await runScan({ db, feed, config: smallConfig(), now: () => SATURDAY_NOON });

    expect(result.scanned).toBe(0);
    expect(feed.candleCalls).toHaveLength(0);
    expect(db.recorded).toHaveLength(0);
  });
});

describe('runScan — freezing', () => {
  it('spends no candle credits on a pair with an open trade', async () => {
    const db = new FakeDb();
    db.pending = [pendingSignal({ symbol: 'EUR/USD' })];
    const feed = new FakeFeed(longSetupCandles);
    feed.prices.set('EUR/USD', 1.101); // nothing hit — stays open

    await runScan({ db, feed, config: smallConfig(), now: () => MONDAY_NOON });

    expect(feed.candleCalls).not.toContain('EUR/USD|1H');
    expect(feed.candleCalls).toContain('GBP/USD|1H');
  });

  it('unfreezes a pair in the same run once its trade closes', async () => {
    const db = new FakeDb();
    db.pending = [pendingSignal({ symbol: 'EUR/USD' })];
    const feed = new FakeFeed(longSetupCandles);
    feed.prices.set('EUR/USD', 1.0979); // stop hit → closes → pair free again

    const result = await runScan({ db, feed, config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.closed).toBe(1);
    expect(feed.candleCalls).toContain('EUR/USD|1H');
  });

  it('freezes a pair the moment it signals, so it cannot signal twice', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);

    const result = await runScan({
      db,
      feed,
      config: smallConfig({ timeframes: ['1H', '4H'] }),
      now: () => MONDAY_NOON,
    });

    expect(result.signals.length).toBeGreaterThan(0);
    // Having signalled on 1H, the pair must not also be scanned on 4H.
    const eur = feed.candleCalls.filter((c) => c.startsWith('EUR/USD'));
    expect(eur).toEqual(['EUR/USD|1H']);
  });
});

describe('runScan — emitting', () => {
  it('records a signal for a valid setup', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);

    const result = await runScan({ db, feed, config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.emitted).toBeGreaterThan(0);
    const row = db.recorded[0]!;
    expect(row.direction).toBe('long');
    expect(row.id).toMatch(/^ichimoku-ema50-confluence\|EUR\/USD\|1H\|\d+$/);
    expect(row.entry).not.toBeNull();
    expect(row.take_profit1).not.toBeNull();
    expect(row.analysis).toBeTruthy();
  });

  it('emits nothing on a flat market', async () => {
    const db = new FakeDb();
    const result = await runScan({ db, feed: new FakeFeed(flatCandles), config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.emitted).toBe(0);
    expect(db.recorded).toHaveLength(0);
  });

  it('does not re-emit the same setup on the next run', async () => {
    const db = new FakeDb();
    const config = smallConfig();

    const first = await runScan({ db, feed: new FakeFeed(longSetupCandles), config, now: () => MONDAY_NOON, force: true });
    expect(first.emitted).toBeGreaterThan(0);

    // A second run, same market, tracker state reloaded from the fake db.
    const second = await runScan({ db, feed: new FakeFeed(longSetupCandles), config, now: () => MONDAY_NOON + 20 * 60_000, force: true });
    expect(second.emitted).toBe(0);
  });

  it('releases a pair once its trade closes — otherwise it goes silent forever', async () => {
    const db = new FakeDb();
    const config = smallConfig({ symbols: ['EUR/USD'] });

    // Signal, so the tracker marks the pair ACTIVE.
    const first = await runScan({ db, feed: new FakeFeed(longSetupCandles), config, now: () => MONDAY_NOON, force: true });
    expect(first.emitted).toBe(1);
    expect(db.setupState.some((s) => s.status === 'ACTIVE')).toBe(true);

    // The trade resolves and no longer appears as pending.
    db.pending = [];

    // The tracker must be released, or this pair can never signal again.
    // Without the reconciliation the setup stays ACTIVE, update() returns
    // emit:false for ever, and this list is empty.
    const after = await runScan({ db, feed: new FakeFeed(longSetupCandles), config, now: () => MONDAY_NOON + 60_000, force: true });
    expect(after.signals.length).toBeGreaterThan(0);
    expect(after.errors).toEqual([]);
  });

  it('persists tracker state so a cold start does not re-emit', async () => {
    const db = new FakeDb();
    await runScan({ db, feed: new FakeFeed(longSetupCandles), config: smallConfig(), now: () => MONDAY_NOON, force: true });
    expect(db.setupState.length).toBeGreaterThan(0);
    expect(db.setupState.some((s) => s.status === 'ACTIVE')).toBe(true);
  });
});

describe('runScan — resilience', () => {
  it('a failing pair does not stop the others', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);
    feed.failSymbols.add('EUR/USD');

    const result = await runScan({ db, feed, config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.errors.some((e) => e.includes('EUR/USD'))).toBe(true);
    expect(feed.candleCalls).toContain('GBP/USD|1H');
  });

  it('reports failure when the write fails', async () => {
    const db = new FakeDb();
    db.failOn = 'recordSignals';

    const result = await runScan({ db, feed: new FakeFeed(longSetupCandles), config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('recordSignals'))).toBe(true);
  });

  it('still scans when the tracker state cannot be loaded', async () => {
    const db = new FakeDb();
    db.failOn = 'loadSetupState';

    const result = await runScan({ db, feed: new FakeFeed(longSetupCandles), config: smallConfig(), now: () => MONDAY_NOON });

    expect(result.errors.some((e) => e.startsWith('loadSetupState'))).toBe(true);
    expect(result.scanned).toBeGreaterThan(0);
  });
});

describe('runScan — credits', () => {
  it('reuses one fetch per (pair, timeframe) within a run', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);

    await runScan({
      db,
      feed,
      config: smallConfig({ symbols: ['EUR/USD'], timeframes: ['1H'], biasTimeframe: '1H' }),
      now: () => MONDAY_NOON,
    });

    // Bias and scan both wanted EUR/USD 1H; only one of them cost a credit.
    expect(feed.candleCalls.filter((c) => c === 'EUR/USD|1H')).toHaveLength(2);
    expect(feed.credits).toBe(1);
  });

  it('stops at the credit cap instead of failing on the tail of the list', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);
    const config = smallConfig({
      symbols: ['A/USD', 'B/USD', 'C/USD', 'D/USD', 'E/USD'],
      maxCreditsPerRun: 3,
    });

    const result = await runScan({ db, feed, config, now: () => MONDAY_NOON });

    expect(result.budgetExhausted).toBe(true);
    expect(feed.credits).toBeLessThanOrEqual(3);
    expect(result.scanned).toBeLessThan(5);
  });

  it('resumes where it stopped, so the tail is not starved', async () => {
    const db = new FakeDb();
    const config = smallConfig({
      symbols: ['A/USD', 'B/USD', 'C/USD', 'D/USD', 'E/USD'],
      maxCreditsPerRun: 2,
    });

    const seen = new Set<string>();
    // Five pairs, two credits a run: four runs must cover all five.
    for (let run = 0; run < 4; run++) {
      const feed = new FakeFeed(flatCandles);
      await runScan({ db, feed, config, now: () => MONDAY_NOON + run * 20 * 60_000, force: true });
      for (const call of feed.candleCalls) seen.add(call.split('|')[0]!);
    }

    expect([...seen].sort()).toEqual(['A/USD', 'B/USD', 'C/USD', 'D/USD', 'E/USD']);
  });

  it('the cursor wraps rather than running off the end', async () => {
    const db = new FakeDb();
    db.cursor = 1;
    const config = smallConfig({ symbols: ['A/USD', 'B/USD'], maxCreditsPerRun: 50 });

    const feed = new FakeFeed(flatCandles);
    const result = await runScan({ db, feed, config, now: () => MONDAY_NOON, force: true });

    // Started at B, wrapped to A.
    expect(feed.candleCalls.map((c) => c.split('|')[0])).toEqual(['B/USD', 'A/USD']);
    expect(result.nextOffset).toBe(1);
  });

  it('does not report budget trouble when there is room', async () => {
    const db = new FakeDb();
    const result = await runScan({
      db,
      feed: new FakeFeed(flatCandles),
      config: smallConfig({ maxCreditsPerRun: 50 }),
      now: () => MONDAY_NOON,
    });
    expect(result.budgetExhausted).toBe(false);
  });

  it('counts a frozen pair as covered, so freezing does not stall the cursor', async () => {
    const db = new FakeDb();
    db.pending = [pendingSignal({ symbol: 'A/USD' })];
    const feed = new FakeFeed(flatCandles);
    feed.prices.set('A/USD', 1.101); // stays open

    const result = await runScan({
      db,
      feed,
      config: smallConfig({ symbols: ['A/USD', 'B/USD'], maxCreditsPerRun: 50 }),
      now: () => MONDAY_NOON,
    });

    expect(result.nextOffset).toBe(0); // both covered, wrapped back to the start
  });

  it('reports what it spent', async () => {
    const db = new FakeDb();
    const feed = new FakeFeed(longSetupCandles);
    const result = await runScan({ db, feed, config: smallConfig(), now: () => MONDAY_NOON });
    expect(result.creditsUsed).toBe(feed.credits);
    expect(result.creditsUsed).toBeGreaterThan(0);
  });
});

describe('runScan — a whole trade lifecycle', () => {
  it('signals, freezes, then closes at a target', async () => {
    const db = new FakeDb();
    const config = smallConfig({ symbols: ['EUR/USD'] });

    // 1. Signal.
    const opened = await runScan({ db, feed: new FakeFeed(longSetupCandles), config, now: () => MONDAY_NOON, force: true });
    expect(opened.emitted).toBe(1);
    const row = db.recorded[0]!;

    // The scanner wrote a ticket; the database would now hold it as pending.
    db.pending = [
      pendingSignal({
        id: row.id,
        symbol: row.symbol,
        direction: row.direction,
        entry: row.entry,
        stop_loss: row.stop_loss,
        take_profit1: row.take_profit1,
        take_profit2: row.take_profit2,
        take_profit3: row.take_profit3,
      }),
    ];

    // 2. Price reaches TP1 → stop moves to entry, trade stays open.
    const feed2 = new FakeFeed(longSetupCandles);
    feed2.prices.set('EUR/USD', row.take_profit1! + 0.0001);
    const atTp1 = await runScan({ db, feed: feed2, config, now: () => MONDAY_NOON + 3_600_000, force: true });
    expect(db.breakevens).toEqual([row.id]);
    expect(atTp1.closed).toBe(0);

    // 3. Price reaches TP3 → closed as a win.
    const feed3 = new FakeFeed(longSetupCandles);
    feed3.prices.set('EUR/USD', row.take_profit3! + 0.0001);
    const atTp3 = await runScan({ db, feed: feed3, config, now: () => MONDAY_NOON + 7_200_000, force: true });
    expect(atTp3.closed).toBe(1);
    expect(db.closes.at(-1)).toMatchObject({ id: row.id, outcome: 'tp3' });
  });
});

/**
 * StrategyEngine — runs the EMA-50 touch strategy across every scanner pair.
 *
 *   start(tf)
 *     │
 *     ├─ scan()  ── per symbol ──▶ marketDataService.getCandles()   ← cached & de-duped
 *     │                             └─▶ analyseEma50Touch()
 *     │                                   ├─ historical touches ─▶ signal log
 *     │                                   └─ current level ──────▶ live watch list
 *     │
 *     ├─ every candleRefreshMs ─▶ scan() again (new bars move the EMA)
 *     │
 *     └─ marketDataService.onQuotes() ─▶ checkLiveTouch() on every tick
 *            └─ fires the moment price reaches the band, between scans,
 *               for ZERO extra provider credits (the quote stream is
 *               already running for the scanner).
 *
 * COST NOTE: a scan costs one candle request per symbol (1 Twelve Data credit
 * each). It reuses MarketDataService's candle cache, so a pair
 * chart that is already open is not fetched twice.
 *
 * BUDGET DISCIPLINE — three rules learned the hard way. On a free Twelve Data
 * key (8 credits/min) a 7-pair quote poll already costs 7, so:
 *   1. Only `symbolsPerScan` pairs are scanned per cycle, round-robin, so one
 *      cycle cannot drain the minute's budget.
 *   2. Candle requests are marked `background`, so the provider's credit meter
 *      SKIPS them when the window is full instead of sleeping on it. Sleeping
 *      is what let a scan hold credits a price update was waiting for.
 *   3. A cycle never starts while the previous one is still running, and the
 *      first cycle waits for prices to paint. Without the guard, a stalled
 *      scan piled up a new overlapping scan every interval.
 *
 * Signals are keyed by (symbol, timeframe, bar), so re-scanning the same bar
 * never duplicates one — and a 'candle' result upgrades the 'live' signal
 * fired earlier on that bar, because the closed bar knows the outcome.
 */
import { STRATEGY_CONFIG } from '../../config/strategy';
import { DEFAULT_TIMEFRAME, type Timeframe } from '../../config/timeframes';
import { APP_CONFIG } from '../../config/app';
import { marketDataService } from '../marketData';
import { toProviderError, type Quote } from '../marketData/types';
import { marketStore } from '../../state/marketStore';
import { signalStore } from '../../state/signalStore';
import { analyseEma50Touch, checkLiveTouch, touchTimeMs } from './ema50Touch';
import type { TouchSignal, WatchLevel } from './types';

/** Newest first, de-duplicated by id; a candle result replaces a live one. */
export function mergeSignals(existing: readonly TouchSignal[], incoming: readonly TouchSignal[], cap: number): TouchSignal[] {
  if (incoming.length === 0) return existing as TouchSignal[];
  const byId = new Map(existing.map((s) => [s.id, s]));
  let changed = false;
  for (const s of incoming) {
    const prev = byId.get(s.id);
    if (prev && !(prev.source === 'live' && s.source === 'candle')) continue;
    byId.set(s.id, prev ? { ...s, detectedAt: prev.detectedAt } : s);
    changed = true;
  }
  if (!changed) return existing as TouchSignal[];
  // Newest touch first, by market time — a fresh live tick outranks a bar
  // that closed an hour ago, whichever order the scan happened to find them.
  return [...byId.values()].sort((a, b) => touchTimeMs(b) - touchTimeMs(a) || b.barTime - a.barTime).slice(0, cap);
}

export class StrategyEngine {
  private timeframe: Timeframe = DEFAULT_TIMEFRAME;
  private session = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private levels = new Map<string, WatchLevel>();
  private running = false;
  private scanning = false;
  /** Round-robin cursor into the symbol list. */
  private cursor = 0;
  private firstScanTimer?: ReturnType<typeof setTimeout>;
  private sawQuotes = false;

  /**
   * Cycle cadence. Short on purpose: each cycle only asks for
   * `symbolsPerScan` pairs and most of those hit MarketDataService's candle
   * cache, so a cycle is usually free. When the provider has no credits left
   * the request is skipped, and the pair comes round again next cycle — the
   * meter paces the work, not this interval.
   */
  get scanIntervalMs(): number {
    return Math.max(10_000, Math.round(marketDataService.capabilities.pollIntervalMs / 4));
  }

  start(timeframe: Timeframe): void {
    if (this.running && this.timeframe === timeframe) return;
    this.stop();
    this.running = true;
    this.timeframe = timeframe;
    const session = ++this.session;

    signalStore.reset(timeframe);
    signalStore.set({ status: 'WARMING' });

    this.cursor = 0;
    this.sawQuotes = false;
    this.unsubscribe = marketDataService.onQuotes((quotes) => this.onQuotes(quotes));

    // Prices first: the strategy only starts spending candle requests once the
    // scanner has quotes (or after a grace period, if the feed is down).
    const begin = () => {
      if (session !== this.session) return;
      void this.scan(session);
      this.timer = setInterval(() => void this.scan(session), this.scanIntervalMs);
    };
    const waitForQuotes = (waited: number) => {
      if (session !== this.session) return;
      if (this.sawQuotes || waited >= STRATEGY_CONFIG.firstScanDelayMs) return begin();
      this.firstScanTimer = setTimeout(() => waitForQuotes(waited + 250), 250);
    };
    waitForQuotes(0);
  }

  stop(): void {
    this.running = false;
    this.session++;
    clearInterval(this.timer);
    clearTimeout(this.firstScanTimer);
    this.timer = undefined;
    this.firstScanTimer = undefined;
    this.scanning = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.levels.clear();
  }

  /** Switch timeframe: everything is timeframe-specific, so this is a restart. */
  setTimeframe(timeframe: Timeframe): void {
    if (timeframe === this.timeframe && this.running) return;
    this.start(timeframe);
  }

  /**
   * One cycle: the next `symbolsPerScan` pairs, round-robin. Sequential within
   * the cycle so the provider's meter paces the requests rather than a burst.
   */
  private async scan(session: number): Promise<void> {
    if (this.scanning) return; // a slow cycle must not stack another on top
    this.scanning = true;
    try {
      await this.scanBatch(session);
    } finally {
      if (session === this.session) this.scanning = false;
    }
  }

  private async scanBatch(session: number): Promise<void> {
    // The scanner's symbol list, published by MarketDataService.
    const symbols = marketStore.get().symbols;
    if (symbols.length === 0) return;

    const batch: string[] = [];
    const size = Math.min(Math.max(1, STRATEGY_CONFIG.symbolsPerScan), symbols.length);
    for (let i = 0; i < size; i++) {
      batch.push(symbols[(this.cursor + i) % symbols.length]!);
    }
    this.cursor = (this.cursor + size) % symbols.length;

    const notices: Record<string, string> = {};
    let found: TouchSignal[] = [];
    let failures = 0;

    for (const symbol of batch) {
      if (session !== this.session) return;
      try {
        const candles = await marketDataService.getCandles(symbol, this.timeframe, APP_CONFIG.chartCandleCount, {
          background: true,
        });
        if (session !== this.session) return;
        const { signals, level, reason } = analyseEma50Touch(candles, symbol, this.timeframe);
        if (reason === 'not-enough-bars') {
          notices[symbol] = `Needs ${STRATEGY_CONFIG.ema50Touch.minBars} ${this.timeframe} candles, got ${candles.length}`;
          this.levels.delete(symbol);
          continue;
        }
        found = found.concat(signals);
        if (level) this.levels.set(symbol, level);
      } catch (err) {
        failures++;
        const e = toProviderError(err);
        // A skipped background request is not a failure — the pair is simply
        // retried on a later cycle, so its last known level is kept.
        notices[symbol] = e.kind === 'rate_limit' ? `Waiting for credits: ${e.message}` : e.message;
        if (e.kind !== 'rate_limit') this.levels.delete(symbol);
      }
    }
    if (session !== this.session) return;

    const allFailed = failures === batch.length && this.levels.size === 0;
    signalStore.set((s) => ({
      // READY once anything has been analysed, so the UI stops saying
      // "loading" while the remaining pairs trickle in over later cycles.
      status: allFailed ? 'ERROR' : this.levels.size > 0 ? 'READY' : s.status,
      signals: mergeSignals(s.signals, found, STRATEGY_CONFIG.maxSignals),
      levels: Object.fromEntries(this.levels),
      // Merge, not replace: this cycle only saw part of the symbol list.
      notices: { ...s.notices, ...notices },
      lastScanAt: Date.now(),
      scanError: allFailed ? 'No candles available for any pair' : null,
      scannedSymbols: Math.min(symbols.length, this.levels.size),
      totalSymbols: symbols.length,
    }));
  }

  /** Live path: a tick that reaches the band signals immediately. */
  private onQuotes(quotes: Quote[]): void {
    this.sawQuotes = true;
    if (quotes.length === 0) return;
    const fired: TouchSignal[] = [];
    let observable = false;

    for (const quote of quotes) {
      const level = this.levels.get(quote.symbol);
      if (!level) continue;
      const { signal, level: next } = checkLiveTouch(level, quote.price, quote.receivedAt);
      this.levels.set(quote.symbol, next);
      // checkLiveTouch always returns a fresh object (it stamps updatedAt), so
      // comparing identity would publish on every single tick and re-render
      // the whole dashboard. Only a change the UI can actually show counts.
      if (next.side !== level.side || next.armed !== level.armed) observable = true;
      if (signal) fired.push(signal);
    }
    if (!observable && fired.length === 0) return;

    signalStore.set((s) => ({
      signals: mergeSignals(s.signals, fired, STRATEGY_CONFIG.maxSignals),
      levels: Object.fromEntries(this.levels),
    }));
  }
}

export const strategyEngine = new StrategyEngine();

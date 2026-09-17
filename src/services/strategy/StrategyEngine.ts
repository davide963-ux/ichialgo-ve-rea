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
 * each, free on OANDA). It reuses MarketDataService's candle cache, so a pair
 * chart that is already open is not fetched twice.
 *
 * Signals are keyed by (symbol, timeframe, bar), so re-scanning the same bar
 * never duplicates one — and a 'candle' result upgrades the 'live' signal
 * fired earlier on that bar, because the closed bar knows the outcome.
 */
import { STRATEGY_CONFIG } from '../../config/strategy';
import type { Timeframe } from '../../config/timeframes';
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
  private timeframe: Timeframe = '15M';
  private session = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private levels = new Map<string, WatchLevel>();
  private running = false;

  get scanIntervalMs(): number {
    return Math.max(60_000, marketDataService.capabilities.candleRefreshMs);
  }

  start(timeframe: Timeframe): void {
    if (this.running && this.timeframe === timeframe) return;
    this.stop();
    this.running = true;
    this.timeframe = timeframe;
    const session = ++this.session;

    signalStore.reset(timeframe);
    signalStore.set({ status: 'WARMING' });

    this.unsubscribe = marketDataService.onQuotes((quotes) => this.onQuotes(quotes));
    void this.scan(session);
    this.timer = setInterval(() => void this.scan(session), this.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    this.session++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.levels.clear();
  }

  /** Switch timeframe: everything is timeframe-specific, so this is a restart. */
  setTimeframe(timeframe: Timeframe): void {
    if (timeframe === this.timeframe && this.running) return;
    this.start(timeframe);
  }

  /** One pass over every symbol. Sequential on purpose: it lets the provider's
   *  credit meter pace the requests instead of bursting the per-minute limit. */
  private async scan(session: number): Promise<void> {
    // The scanner's symbol list, published by MarketDataService.
    const symbols = marketStore.get().symbols;
    const notices: Record<string, string> = {};
    let found: TouchSignal[] = [];
    let failures = 0;

    for (const symbol of symbols) {
      if (session !== this.session) return;
      try {
        const candles = await marketDataService.getCandles(symbol, this.timeframe, APP_CONFIG.chartCandleCount);
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
        notices[symbol] = toProviderError(err).message;
        this.levels.delete(symbol);
      }
    }
    if (session !== this.session) return;

    const allFailed = symbols.length > 0 && failures === symbols.length;
    signalStore.set((s) => ({
      status: allFailed ? 'ERROR' : 'READY',
      signals: mergeSignals(s.signals, found, STRATEGY_CONFIG.maxSignals),
      levels: Object.fromEntries(this.levels),
      notices,
      lastScanAt: Date.now(),
      scanError: allFailed ? 'No candles available for any pair' : null,
    }));
  }

  /** Live path: a tick that reaches the band signals immediately. */
  private onQuotes(quotes: Quote[]): void {
    if (quotes.length === 0) return;
    const fired: TouchSignal[] = [];
    let levelsChanged = false;

    for (const quote of quotes) {
      const level = this.levels.get(quote.symbol);
      if (!level) continue;
      const { signal, level: next } = checkLiveTouch(level, quote.price, quote.receivedAt);
      if (next !== level) {
        this.levels.set(quote.symbol, next);
        levelsChanged = true;
      }
      if (signal) fired.push(signal);
    }
    if (!levelsChanged && fired.length === 0) return;

    signalStore.set((s) => ({
      signals: mergeSignals(s.signals, fired, STRATEGY_CONFIG.maxSignals),
      levels: Object.fromEntries(this.levels),
    }));
  }
}

export const strategyEngine = new StrategyEngine();

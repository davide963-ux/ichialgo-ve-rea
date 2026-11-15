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
 *     ├─ every scanTickMs ─▶ re-check which pairs are DUE (arithmetic only)
 *     │                        └─▶ fetch only those whose bar has closed
 *     │
 *     └─ marketDataService.onQuotes() ─▶ checkLiveTouch() on every tick
 *            └─ fires the moment price reaches the band, between scans,
 *               for ZERO extra provider credits (the quote stream is
 *               already running for the scanner).
 *
 * WHY IT FETCHES ON BAR BOUNDARIES, NOT ON A FIXED INTERVAL
 * ────────────────────────────────────────────────────────
 * It used to scan every `candleRefreshMs` — a number TwelveDataProvider
 * computes from its CREDIT budget. Two things made that wasteful once candles
 * started coming from Yahoo for nothing:
 *
 *   1. MarketDataService caches candles for `candleRefreshMs / 2`, which is
 *      exactly half the old scan interval — so the cache had always expired
 *      by the next scan and every scan re-fetched every pair. By construction.
 *   2. The data it re-fetched was almost always identical. On 30M a bar closes
 *      twice an hour; the old loop asked thirty times an hour. Measured on the
 *      default config: 210 requests an hour across 7 pairs, 196 of them (93%)
 *      returning the same bars as the request before.
 *
 * A pair's candles cannot change until its current bar closes, so that is when
 * it is asked for. Between closes the level already in hand is correct, and
 * intrabar movement is covered by the quote stream for free. On 30M this is
 * 2 fetches an hour per pair instead of 30; on 4H it is one every four hours.
 *
 * The analysis itself is not what costs anything — re-running all of it over
 * 300 bars for 7 pairs measures 1.05 ms, so there is nothing to save there.
 *
 * Signals are keyed by (symbol, timeframe, bar), so re-scanning the same bar
 * never duplicates one — and a 'candle' result upgrades the 'live' signal
 * fired earlier on that bar, because the closed bar knows the outcome.
 */
import { STRATEGY_CONFIG } from '../../config/strategy';
import { TIMEFRAME_SECONDS, type Timeframe } from '../../config/timeframes';
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

/** What the engine remembers about one pair between ticks. */
export interface PairState {
  /** Open time of the newest bar we have, in UNIX seconds. */
  newestBarTime: number;
  /** When we last got candles for it. */
  fetchedAt: number;
}

/**
 * Does this pair need new candles?
 *
 * Pure, so the schedule can be tested without a provider, a clock or a store.
 * Two reasons to say yes:
 *
 *   1. We have nothing yet.
 *   2. Its newest bar has closed, plus a grace period — providers publish a
 *      closed bar late, and asking early just returns the same data.
 *
 * …but never sooner than `minRefetchMs` after the last fetch. That floor is
 * what stops a LATE provider from being hammered: while its newest bar has not
 * advanced, the bar stays past its close, so rule 2 on its own would say "due"
 * on every tick forever. The floor turns that into a retry every two minutes,
 * and it stops mattering the moment the provider catches up.
 */
export function candlesAreDue(
  now: number,
  state: PairState | undefined,
  barSeconds: number,
  lagMs: number,
  minRefetchMs: number,
): boolean {
  if (!state) return true;
  if (now - state.fetchedAt < minRefetchMs) return false;
  const barClosesAt = (state.newestBarTime + barSeconds) * 1000;
  return now >= barClosesAt + lagMs;
}

export class StrategyEngine {
  private timeframe: Timeframe = STRATEGY_CONFIG.scanTimeframe;
  private session = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private levels = new Map<string, WatchLevel>();
  /** Per pair: the newest bar we hold and when we got it. Drives the schedule. */
  private pairs = new Map<string, PairState>();
  /** Kept across ticks, because a tick only touches the pairs it refetched. */
  private notices = new Map<string, string>();
  private running = false;

  /** How often the due-check runs — not how often anything is fetched. */
  get scanIntervalMs(): number {
    return STRATEGY_CONFIG.scanTickMs;
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
    this.pairs.clear();
    this.notices.clear();
  }

  /** Switch timeframe: everything is timeframe-specific, so this is a restart. */
  setTimeframe(timeframe: Timeframe): void {
    if (timeframe === this.timeframe && this.running) return;
    this.start(timeframe);
  }

  /**
   * One pass over the pairs whose bar has closed.
   *
   * Sequential on purpose. It used to be sequential so the credit meter could
   * pace the requests; now it is so a burst of seven simultaneous requests
   * never hits Yahoo's unofficial endpoint at once, which is what earns a 429.
   * Since bars on one timeframe close at the same instant for every pair, the
   * tick that follows a close is the one that would otherwise burst.
   */
  private async scan(session: number): Promise<void> {
    // The scanner's symbol list, published by MarketDataService.
    const symbols = marketStore.get().symbols;
    const barSeconds = TIMEFRAME_SECONDS[this.timeframe];
    const found: TouchSignal[] = [];
    let fetched = 0;
    let failures = 0;
    let changed = false;

    for (const symbol of symbols) {
      if (session !== this.session) return;
      if (!candlesAreDue(Date.now(), this.pairs.get(symbol), barSeconds, STRATEGY_CONFIG.barCloseLagMs, STRATEGY_CONFIG.minRefetchMs)) {
        continue; // its bars cannot have changed — the level in hand still holds
      }

      fetched++;
      try {
        // `force` because we have decided a bar closed: MarketDataService's own
        // cache would otherwise hand back a copy taken before it did.
        const candles = await marketDataService.getCandles(symbol, this.timeframe, APP_CONFIG.chartCandleCount, { force: true });
        if (session !== this.session) return;
        const { signals, level, reason } = analyseEma50Touch(candles, symbol, this.timeframe);
        changed = true;

        const newest = candles.at(-1);
        if (newest) this.pairs.set(symbol, { newestBarTime: newest.time, fetchedAt: Date.now() });

        if (reason === 'not-enough-bars') {
          this.notices.set(symbol, `Needs ${STRATEGY_CONFIG.ema50Touch.minBars} ${this.timeframe} candles, got ${candles.length}`);
          this.levels.delete(symbol);
          continue;
        }
        this.notices.delete(symbol);
        found.push(...signals);
        if (level) this.levels.set(symbol, level);
      } catch (err) {
        failures++;
        changed = true;
        this.notices.set(symbol, toProviderError(err).message);
        this.levels.delete(symbol);
        // Leave `pairs` untouched so the staleness net retries on a later tick
        // rather than this one hammering a provider that is already failing.
      }
    }
    if (session !== this.session) return;

    // A tick that refetched nothing has nothing to publish: writing the store
    // anyway would re-render every subscriber for no change.
    if (!changed) return;

    const allFailed = fetched > 0 && failures === fetched;
    signalStore.set((s) => ({
      status: allFailed ? 'ERROR' : 'READY',
      signals: mergeSignals(s.signals, found, STRATEGY_CONFIG.maxSignals),
      levels: Object.fromEntries(this.levels),
      notices: Object.fromEntries(this.notices),
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

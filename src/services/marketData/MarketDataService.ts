/**
 * MarketDataService
 * ─────────────────
 * The single gateway between the app and a market-data provider.
 *
 *   start()
 *     │
 *     ├─ LOADING ─▶ provider.assertConfigured()
 *     │               └─ fails (config/auth) ─▶ ERROR (halt, wait for retry())
 *     ├─ pollOnce()  (initial snapshot)
 *     ├─ provider streams?  ── yes ─▶ openStream()
 *     │                              └─ stream dies ─▶ fall back to polling
 *     │                                                + re-open stream with backoff
 *     └─ no ─▶ schedulePoll() loop (rate-limit aware, exponential backoff)
 *
 *   Freshness watchdog (1s): no contact within the allowed window ─▶ OFFLINE.
 *   Prices are never presented as live unless status === 'ONLINE'.
 *
 * The strategy never talks to a provider directly; it is handed candles.
 * Signals are produced by the server-side scanner, not in the browser, so
 * nothing here feeds a strategy — this service exists to keep the UI's prices
 * and charts honest.
 */
import type { Timeframe } from '../../config/timeframes';
import { marketStore } from '../../state/marketStore';
import {
  ProviderError,
  isAbort,
  toProviderError,
  type Candle,
  type MarketDataProvider,
  type Quote,
  type StreamHandle,
} from './types';

const STREAM_STALE_MS = 12_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_STREAM_RETRY_MS = 5 * 60_000;

type QuoteSubscriber = (quotes: Quote[]) => void;

export class MarketDataService {
  private session = 0;
  private halted = false;
  private active: string[];
  private ctrl = new AbortController();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private staleTimer?: ReturnType<typeof setInterval>;
  private streamRetryTimer?: ReturnType<typeof setTimeout>;
  private stream: StreamHandle | null = null;
  private mode: 'stream' | 'poll' | null = null;
  private failures = 0;
  private streamFailures = 0;
  private rateLimitUntil = 0;
  /** True while the tab is in the background and polling is suspended. */
  private suspended = false;
  private detachVisibility: (() => void) | null = null;

  private candleCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
  private candleInflight = new Map<string, Promise<Candle[]>>();
  private quoteSubscribers = new Set<QuoteSubscriber>();

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly symbols: string[],
  ) {
    this.active = [...symbols];
    // A credit-metered provider paces its poll by how many symbols it must
    // price, so it needs the count before the first schedule.
    (provider as { setSymbolCount?: (n: number) => void }).setSymbolCount?.(symbols.length);
    marketStore.init({
      status: 'LOADING',
      statusMessage: null,
      errorKind: null,
      provider: { id: provider.id, label: provider.label, capabilities: provider.capabilities },
      mode: null,
      symbols: [...symbols],
      quotes: {},
      symbolErrors: {},
      lastUpdate: null,
      lastContact: null,
      nextRetryAt: null,
    });
  }

  get capabilities() {
    return this.provider.capabilities;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(): Promise<void> {
    const session = ++this.session;
    this.halted = false;
    this.ctrl = new AbortController();
    this.active = this.symbols.filter((s) => !marketStore.get().symbolErrors[s]);
    marketStore.set({ status: 'LOADING', statusMessage: `Connecting to ${this.provider.label}…`, errorKind: null, nextRetryAt: null });

    clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => this.checkFreshness(), 1000);
    this.watchVisibility();

    try {
      await this.provider.assertConfigured(this.ctrl.signal);
    } catch (err) {
      if (isAbort(err) || session !== this.session) return;
      this.handleError(toProviderError(err));
      return;
    }
    if (session !== this.session) return;

    const ok = await this.pollOnce(session);
    if (session !== this.session || this.halted) return;

    if (this.provider.capabilities.streaming && this.provider.subscribe) {
      if (!ok) this.schedulePoll(session, this.nextDelay());
      this.openStream(session);
    } else {
      this.schedulePoll(session, ok ? this.provider.capabilities.pollIntervalMs : this.nextDelay());
    }
  }

  stop(): void {
    this.session++;
    this.ctrl.abort();
    clearTimeout(this.pollTimer);
    clearTimeout(this.streamRetryTimer);
    clearInterval(this.staleTimer);
    this.detachVisibility?.();
    this.detachVisibility = null;
    this.suspended = false;
    this.stream?.close();
    this.stream = null;
    this.mode = null;
  }

  // ─────────────────── background-tab suspension ───────────────────
  //
  // A backgrounded tab polls exactly as hard as a focused one, and nobody is
  // reading it. On a credit-metered provider that is not merely wasteful, it
  // is the single largest consumer: seven pairs at the default sixty-second
  // interval spend ~420 credits an hour, so one forgotten tab exhausts a
  // 4,000-credit daily budget in under ten hours and every other part of the
  // app — charts, the backtest, the scanner — then fails on an exhausted key.
  //
  // So polling suspends while the tab is hidden and takes ONE fresh reading
  // when it comes back. The returning reading matters: without it the first
  // thing a returning user sees is a stale price with no indication it is
  // stale, which is worse than the cost it saves.
  //
  // Streaming is deliberately left alone. A websocket the provider is already
  // pushing to costs nothing per message, and tearing it down on every tab
  // switch would trade a real reconnect for an imaginary saving.

  private watchVisibility(): void {
    this.detachVisibility?.();
    if (typeof document === 'undefined') return;

    const onChange = () => {
      if (document.visibilityState === 'hidden') this.suspend();
      else this.resume();
    };

    document.addEventListener('visibilitychange', onChange);
    this.detachVisibility = () => document.removeEventListener('visibilitychange', onChange);
  }

  private suspend(): void {
    if (this.suspended || this.isStreaming()) return;
    this.suspended = true;
    clearTimeout(this.pollTimer);
  }

  private resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.halted || this.isStreaming()) return;

    // Read immediately rather than waiting out the remaining interval: the
    // price on screen is however old the tab was hidden for.
    const session = this.session;
    void (async () => {
      const ok = await this.pollOnce(session);
      if (session !== this.session || this.halted || this.isStreaming()) return;
      this.schedulePoll(session, ok ? this.provider.capabilities.pollIntervalMs : this.nextDelay());
    })();
  }

  /** Manual reconnect (UI "Retry" button). Clears per-symbol errors too. */
  retry(): void {
    this.stop();
    this.failures = 0;
    this.streamFailures = 0;
    this.rateLimitUntil = 0;
    marketStore.set({ symbolErrors: {} });
    void this.start();
  }

  /** Hook for anything that wants every live quote batch. */
  onQuotes(cb: QuoteSubscriber): () => void {
    this.quoteSubscribers.add(cb);
    return () => this.quoteSubscribers.delete(cb);
  }

  // ───────────────────────── polling ─────────────────────────

  private async pollOnce(session: number): Promise<boolean> {
    if (this.active.length === 0) {
      marketStore.set({ status: 'ERROR', errorKind: 'invalid_symbol', statusMessage: 'None of the configured pairs are available from this provider.' });
      this.halted = true;
      return false;
    }
    try {
      const batch = await this.provider.getQuotes(this.active, this.ctrl.signal);
      if (session !== this.session) return false;

      if (batch.failed.length) {
        const invalid = new Set(batch.failed.filter((f) => f.error.kind === 'invalid_symbol').map((f) => f.symbol));
        this.active = this.active.filter((s) => !invalid.has(s));
        marketStore.set((s) => ({
          symbolErrors: {
            ...s.symbolErrors,
            ...Object.fromEntries(batch.failed.map((f) => [f.symbol, f.error.message])),
          },
        }));
      }

      if (batch.quotes.length === 0) {
        this.handleError(new ProviderError('no_data', 'Provider returned no prices for the configured pairs'));
        return false;
      }

      this.failures = 0;
      this.applyQuotes(batch.quotes);
      return true;
    } catch (err) {
      if (isAbort(err) || session !== this.session) return false;
      this.handleError(toProviderError(err));
      return false;
    }
  }

  private schedulePoll(session: number, delay: number): void {
    clearTimeout(this.pollTimer);
    if (this.halted || session !== this.session) return;
    // Nothing is scheduled while hidden; `resume()` restarts the loop.
    if (this.suspended) return;
    this.mode = this.mode ?? 'poll';
    if (this.mode === 'poll') marketStore.set({ mode: 'poll' });
    marketStore.set({ nextRetryAt: this.failures > 0 || this.rateLimitUntil > Date.now() ? Date.now() + delay : null });

    this.pollTimer = setTimeout(async () => {
      if (session !== this.session || this.isStreaming()) return;
      await this.pollOnce(session);
      // mode may have changed while awaiting (stream recovered)
      if (session !== this.session || this.isStreaming()) return;
      this.schedulePoll(session, this.nextDelay());
    }, delay);
  }

  private isStreaming(): boolean {
    return this.mode === 'stream';
  }

  private nextDelay(): number {
    const now = Date.now();
    if (this.rateLimitUntil > now) return this.rateLimitUntil - now;
    if (this.failures > 0) return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (this.failures - 1));
    return this.provider.capabilities.pollIntervalMs;
  }

  // ───────────────────────── streaming ─────────────────────────

  private openStream(session: number): void {
    const subscribe = this.provider.subscribe?.bind(this.provider);
    if (!subscribe || session !== this.session || this.halted) return;

    this.stream = subscribe(
      this.active,
      (quotes) => {
        if (session !== this.session) return;
        if (this.mode !== 'stream') {
          // Stream is healthy → stop polling.
          this.mode = 'stream';
          this.streamFailures = 0;
          clearTimeout(this.pollTimer);
          marketStore.set({ mode: 'stream', nextRetryAt: null });
        }
        this.failures = 0;
        if (quotes.length) this.applyQuotes(quotes);
        else this.markContact();
      },
      (err) => {
        if (session !== this.session) return;
        this.stream = null;
        if (err.kind === 'auth' || err.kind === 'config') {
          this.handleError(err);
          return;
        }
        // Degrade gracefully: poll until the stream comes back.
        this.streamFailures++;
        this.mode = 'poll';
        marketStore.set({ mode: 'poll', statusMessage: 'Live stream interrupted — polling for prices' });
        this.schedulePoll(session, 0);
        const wait = Math.min(MAX_STREAM_RETRY_MS, 15_000 * 2 ** (this.streamFailures - 1));
        clearTimeout(this.streamRetryTimer);
        this.streamRetryTimer = setTimeout(() => this.openStream(session), wait);
      },
    );
  }

  // ───────────────────────── state updates ─────────────────────────

  private applyQuotes(quotes: Quote[]): void {
    const now = Date.now();
    marketStore.set((s) => {
      const next = { ...s.quotes };
      let latest = s.lastUpdate ?? 0;
      for (const q of quotes) {
        const prev = next[q.symbol];
        // Keep a known 24h change if this tick doesn't carry one.
        const merged = q.changePct === null && prev ? { ...q, changePct: prev.changePct } : q;
        if (!prev || merged.timestamp >= prev.timestamp) next[q.symbol] = merged;
        if (Number.isFinite(q.timestamp)) latest = Math.max(latest, q.timestamp);
      }
      return {
        quotes: next,
        lastUpdate: latest || null,
        lastContact: now,
        status: 'ONLINE',
        errorKind: null,
        statusMessage: this.rateLimitUntil > now ? s.statusMessage : null,
      };
    });
    this.quoteSubscribers.forEach((cb) => cb(quotes));
  }

  private markContact(): void {
    const s = marketStore.get();
    marketStore.set({
      lastContact: Date.now(),
      ...(s.status !== 'ONLINE' && Object.keys(s.quotes).length ? { status: 'ONLINE' as const, statusMessage: null } : {}),
    });
  }

  private handleError(err: ProviderError): void {
    this.failures++;
    switch (err.kind) {
      case 'config':
      case 'auth':
        this.halted = true;
        clearTimeout(this.pollTimer);
        this.stream?.close();
        this.stream = null;
        marketStore.set({ status: 'ERROR', errorKind: err.kind, statusMessage: err.message, nextRetryAt: null });
        return;
      case 'rate_limit': {
        const wait = err.retryAfterMs ?? 60_000;
        this.rateLimitUntil = Date.now() + wait;
        // Keep current status; the freshness watchdog flips to OFFLINE if data gets old.
        marketStore.set({ errorKind: 'rate_limit', statusMessage: `${err.message}. Retrying in ${Math.round(wait / 1000)}s.` });
        return;
      }
      default: {
        const hasData = Object.keys(marketStore.get().quotes).length > 0;
        marketStore.set({
          status: hasData ? 'OFFLINE' : 'ERROR',
          errorKind: err.kind,
          statusMessage: err.message,
        });
      }
    }
  }

  private checkFreshness(): void {
    const s = marketStore.get();
    if (this.halted || s.status !== 'ONLINE' || s.lastContact === null) return;
    const limit =
      this.mode === 'stream' ? STREAM_STALE_MS : this.provider.capabilities.pollIntervalMs * 2 + 10_000;
    const silent = Date.now() - s.lastContact;
    if (silent > limit) {
      marketStore.set({
        status: 'OFFLINE',
        errorKind: 'network',
        statusMessage: `No market data received for ${Math.round(silent / 1000)}s`,
      });
    }
  }

  // ───────────────────────── candles ─────────────────────────

  /**
   * OHLC candles with a short cache and in-flight de-duplication
   * (several components may ask for the same series at once).
   */
  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    opts: { force?: boolean; background?: boolean } = {},
  ): Promise<Candle[]> {
    const key = `${symbol}|${timeframe}|${count}`;
    const cached = this.candleCache.get(key);
    const maxAge = this.provider.capabilities.candleRefreshMs / 2;
    if (!opts.force && cached && Date.now() - cached.fetchedAt < maxAge) return cached.candles;

    let job = this.candleInflight.get(key);
    if (!job) {
      job = this.provider
        .getCandles(symbol, timeframe, count, undefined, { background: opts.background })
        .then((candles) => {
          this.candleCache.set(key, { candles, fetchedAt: Date.now() });
          return candles;
        })
        .catch((err: unknown) => {
          const e = toProviderError(err);
          if (e.kind === 'rate_limit') this.rateLimitUntil = Date.now() + (e.retryAfterMs ?? 60_000);
          throw e;
        })
        .finally(() => this.candleInflight.delete(key));
      this.candleInflight.set(key, job);
    }
    return job;
  }
}

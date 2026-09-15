/**
 * OANDA v20 provider.
 *
 *  - Real bid/ask from GET  /v3/accounts/{id}/pricing
 *  - Streaming from     GET  /v3/accounts/{id}/pricing/stream   (newline-delimited JSON)
 *  - Candles from       GET  /v3/instruments/{instrument}/candles
 *  - 24H change: OANDA has no "change" field, so we fetch the first M5 candle
 *    at/after (now - 24h) and compare the live mid price to its open.
 *    References are cached for 5 minutes per symbol.
 *
 * All requests go through the same-origin proxy (see vite.config.ts), which
 * injects the bearer token and account id. Nothing secret lives here.
 */
import type { Timeframe } from '../../../config/timeframes';
import { fetchJson, num } from '../http';
import { pipSize } from '../../../lib/pips';
import { parseRfc3339 } from '../../../lib/time';
import {
  ProviderError,
  isAbort,
  toProviderError,
  type Candle,
  type MarketDataProvider,
  type Quote,
  type QuoteBatch,
  type QuoteListener,
  type StreamHandle,
} from '../types';

const REST = '/api/oanda-rest';
const STREAM = '/api/oanda-stream';

const GRANULARITY: Record<Timeframe, string> = {
  '1M': 'M1',
  '5M': 'M5',
  '15M': 'M15',
  '30M': 'M30',
  '1H': 'H1',
  '4H': 'H4',
  '1D': 'D',
};

const REF_TTL_MS = 5 * 60_000;
/** OANDA sends a heartbeat every ~5s. No bytes for this long = dead stream. */
const STREAM_STALL_MS = 12_000;

const toInstrument = (symbol: string) => symbol.replace('/', '_');
const fromInstrument = (instrument: string) => instrument.replace('_', '/');

interface OandaPrice {
  type?: string;
  instrument: string;
  time: string;
  tradeable?: boolean;
  bids?: { price: string }[];
  asks?: { price: string }[];
  closeoutBid?: string;
  closeoutAsk?: string;
}

interface OandaCandle {
  time: string;
  volume?: number;
  complete: boolean;
  mid?: { o: string; h: string; l: string; c: string };
}

export class OandaProvider implements MarketDataProvider {
  readonly id = 'oanda' as const;
  readonly label = 'OANDA v20';
  readonly capabilities = {
    streaming: true,
    bidAsk: true,
    changeBasis: 'rolling-24h' as const,
    pollIntervalMs: 2_000,
    candleRefreshMs: 15_000,
  };

  /** symbol → { price 24h ago, fetchedAt } */
  private refs = new Map<string, { price: number | null; fetchedAt: number }>();
  private refInflight = new Map<string, Promise<void>>();

  async assertConfigured(signal?: AbortSignal): Promise<void> {
    try {
      await fetchJson(`${REST}/account/summary`, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      const e = toProviderError(err);
      if (e.kind === 'auth') {
        throw new ProviderError('auth', 'OANDA rejected the API token. Check OANDA_API_TOKEN and OANDA_ENV in .env, then restart the dev server.');
      }
      if (e.kind === 'invalid_symbol') {
        throw new ProviderError('config', 'OANDA account not found. Check OANDA_ACCOUNT_ID in .env, then restart the dev server.');
      }
      throw e;
    }
  }

  // ───────────────────────── Quotes ─────────────────────────

  async getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    if (symbols.length === 0) return { quotes: [], failed: [] };
    try {
      const prices = await this.fetchPricing(symbols, signal);
      await this.ensureRefs(symbols, signal);
      return { quotes: prices.map((p) => this.toQuote(p)), failed: [] };
    } catch (err) {
      if (isAbort(err)) throw err;
      const e = toProviderError(err);
      // OANDA rejects the WHOLE batch if one instrument is invalid.
      // Isolate the bad symbol(s) with individual requests.
      if (e.kind === 'invalid_symbol' && symbols.length > 1) return this.getQuotesIndividually(symbols, signal);
      if (e.kind === 'invalid_symbol') return { quotes: [], failed: [{ symbol: symbols[0]!, error: e }] };
      throw e;
    }
  }

  private async getQuotesIndividually(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    const batch: QuoteBatch = { quotes: [], failed: [] };
    for (const symbol of symbols) {
      try {
        const [price] = await this.fetchPricing([symbol], signal);
        if (price) {
          await this.ensureRefs([symbol], signal);
          batch.quotes.push(this.toQuote(price));
        } else {
          batch.failed.push({ symbol, error: new ProviderError('no_data', 'No price returned', { symbol }) });
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        const e = toProviderError(err);
        if (e.kind !== 'invalid_symbol' && e.kind !== 'no_data') throw e; // systemic problem
        batch.failed.push({ symbol, error: new ProviderError('invalid_symbol', `${symbol} is not available on OANDA`, { symbol }) });
      }
    }
    return batch;
  }

  private async fetchPricing(symbols: string[], signal?: AbortSignal): Promise<OandaPrice[]> {
    const qs = new URLSearchParams({ instruments: symbols.map(toInstrument).join(',') });
    const body = await fetchJson<{ prices?: OandaPrice[] }>(`${REST}/account/pricing?${qs}`, signal);
    return body.prices ?? [];
  }

  private toQuote(p: OandaPrice): Quote {
    const symbol = fromInstrument(p.instrument);
    const bid = num(p.bids?.[0]?.price) ?? num(p.closeoutBid);
    const ask = num(p.asks?.[0]?.price) ?? num(p.closeoutAsk);
    if (bid === null || ask === null) {
      throw new ProviderError('no_data', `No bid/ask for ${symbol}`, { symbol });
    }
    const mid = (bid + ask) / 2;
    const ref = this.refs.get(symbol)?.price ?? null;
    return {
      symbol,
      price: mid,
      bid,
      ask,
      spreadPips: (ask - bid) / pipSize(symbol),
      changePct: ref ? ((mid - ref) / ref) * 100 : null,
      timestamp: parseRfc3339(p.time),
      receivedAt: Date.now(),
      marketOpen: typeof p.tradeable === 'boolean' ? p.tradeable : null,
    };
  }

  /** Fetch / refresh the "price 24h ago" reference for each symbol. */
  private async ensureRefs(symbols: string[], signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const jobs = symbols
      .filter((s) => {
        const r = this.refs.get(s);
        return !r || now - r.fetchedAt > REF_TTL_MS;
      })
      .map((s) => {
        let job = this.refInflight.get(s);
        if (!job) {
          job = this.fetchRef(s, signal).finally(() => this.refInflight.delete(s));
          this.refInflight.set(s, job);
        }
        return job;
      });
    await Promise.all(jobs);
  }

  private async fetchRef(symbol: string, signal?: AbortSignal): Promise<void> {
    const from = new Date(Date.now() - 24 * 3600_000).toISOString();
    const qs = new URLSearchParams({ granularity: 'M5', price: 'M', count: '1', from });
    try {
      const body = await fetchJson<{ candles?: OandaCandle[] }>(`${REST}/instruments/${toInstrument(symbol)}/candles?${qs}`, signal);
      const open = num(body.candles?.[0]?.mid?.o);
      this.refs.set(symbol, { price: open, fetchedAt: Date.now() });
    } catch (err) {
      if (isAbort(err)) throw err;
      // 24h change is secondary — never block prices on it. Show "—" and retry later.
      this.refs.set(symbol, { price: null, fetchedAt: Date.now() - REF_TTL_MS + 30_000 });
    }
  }

  // ───────────────────────── Candles ─────────────────────────

  async getCandles(symbol: string, timeframe: Timeframe, count: number, signal?: AbortSignal): Promise<Candle[]> {
    const qs = new URLSearchParams({
      granularity: GRANULARITY[timeframe],
      price: 'M',
      count: String(Math.min(Math.max(count, 1), 5000)),
    });
    let body: { candles?: OandaCandle[] };
    try {
      body = await fetchJson(`${REST}/instruments/${toInstrument(symbol)}/candles?${qs}`, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      const e = toProviderError(err);
      if (e.kind === 'invalid_symbol') throw new ProviderError('invalid_symbol', `${symbol} is not available on OANDA`, { symbol });
      throw e;
    }
    const candles: Candle[] = [];
    for (const c of body.candles ?? []) {
      const o = num(c.mid?.o), h = num(c.mid?.h), l = num(c.mid?.l), cl = num(c.mid?.c);
      const t = parseRfc3339(c.time);
      if (o === null || h === null || l === null || cl === null || !Number.isFinite(t)) continue;
      candles.push({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: cl, volume: c.volume ?? null, complete: c.complete });
    }
    return candles;
  }

  // ───────────────────────── Streaming ─────────────────────────

  subscribe(symbols: string[], onQuotes: QuoteListener, onError: (err: ProviderError) => void): StreamHandle {
    const ctrl = new AbortController();
    let closed = false;
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const refTimer = setInterval(() => {
      this.ensureRefs(symbols, ctrl.signal).catch(() => undefined);
    }, REF_TTL_MS);

    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        ctrl.abort();
      }, STREAM_STALL_MS);
    };

    const run = async () => {
      await this.ensureRefs(symbols, ctrl.signal).catch(() => undefined);
      const qs = new URLSearchParams({ instruments: symbols.map(toInstrument).join(',') });
      armWatchdog();
      const res = await fetch(`${STREAM}/account/pricing/stream?${qs}`, { signal: ctrl.signal });
      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'OANDA rejected the stream request');
        if (res.status === 429) throw new ProviderError('rate_limit', 'OANDA stream rate limited', { retryAfterMs: 30_000 });
        throw new ProviderError('network', `Stream unavailable (HTTP ${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new ProviderError('network', 'Price stream ended');
        armWatchdog();
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        const batch: Quote[] = [];
        let heartbeat = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: OandaPrice;
          try {
            msg = JSON.parse(line) as OandaPrice;
          } catch {
            continue;
          }
          if (msg.type === 'HEARTBEAT') heartbeat = true;
          else if (msg.type === 'PRICE') {
            try {
              batch.push(this.toQuote(msg));
            } catch {
              /* skip incomplete tick */
            }
          }
        }
        if (batch.length) onQuotes(batch);
        else if (heartbeat) onQuotes([]);
      }
    };

    run().catch((err) => {
      if (closed) return;
      if (stalled) onError(new ProviderError('network', 'Price stream stalled'));
      else onError(toProviderError(err));
    }).finally(() => {
      clearTimeout(watchdog);
      clearInterval(refTimer);
    });

    return {
      close() {
        closed = true;
        clearTimeout(watchdog);
        clearInterval(refTimer);
        ctrl.abort();
      },
    };
  }
}

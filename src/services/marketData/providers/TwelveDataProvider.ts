/**
 * Twelve Data provider (REST polling).
 *
 *  - Quotes: GET /quote?symbol=EUR/USD,GBP/USD   (1 credit per symbol)
 *      → last price, daily % change vs previous close, market-open flag.
 *      The REST quote has NO bid/ask, so those columns show "—".
 *  - Candles: GET /time_series?symbol=..&interval=..&outputsize=..
 *
 * Free Basic plan = 8 credits/minute AND 800 credits/day PER KEY. With 7 pairs
 * a 60s poll uses 7 credits/min, so one key's daily cap runs out after ~1h50m.
 *
 * MULTIPLE KEYS: the proxy (server/twelveDataKeyPool.mjs) pools one key per
 * Twelve Data account and fails over to the next when one runs out, so the
 * effective budget is `limit × keyCount`. The keys stay server-side; this
 * provider only learns HOW MANY there are, from GET /api/td-rest/_status
 * during assertConfigured(), and scales its local meter accordingly.
 *
 * Every request is metered by CreditBudget and fails fast with a clear
 * rate_limit error instead of silently stalling.
 * WebSocket streaming requires a Pro plan; it can be added later behind
 * `subscribe()` without UI changes.
 *
 * Twelve Data often returns errors with HTTP 200 and `{status:"error", code}`
 * in the body, so we check both.
 */
import type { Timeframe } from '../../../config/timeframes';
import { APP_CONFIG } from '../../../config/app';
import { CreditBudget } from './creditBudget';
import { fetchJson, num } from '../http';
import { isTdError, mapTdError, parseTdSeries, tdSeriesQuery } from './twelveDataSeries';
import {
  ProviderError,
  isAbort,
  toProviderError,
  type Candle,
  type CandleRequestOptions,
  type MarketDataProvider,
  type QuoteBatch,
} from '../types';

const REST = '/api/td-rest';

/**
 * A user-facing request may wait for the per-minute window to free up; a
 * background scan may not. Waiting is what made a strategy scan and a price
 * update fight over the same 8 credits, with whichever slept first winning.
 */
const USER_WAIT_MS = 65_000;
const BACKGROUND_WAIT_MS = 1_500;

/** Hard ceiling on the poll interval, however tight the budget is. */
const MAX_POLL_MS = 300_000;

interface TdQuote {
  symbol: string;
  close?: string;
  percent_change?: string;
  timestamp?: number;
  last_quote_at?: number;
  is_market_open?: boolean;
}

/** GET /api/td-rest/_status — our proxy's key-pool report (costs no credits). */
interface TdPoolStatus {
  keys: number;
  available: number;
  perMinuteTotal: number;
  perDayTotal: number | null;
}

/** Error shape and mapping live in twelveDataSeries, shared with the scanner. */
const isError = isTdError;
const mapError = mapTdError;

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = 'twelvedata' as const;
  readonly label = 'Twelve Data';
  /**
   * Mutable on purpose: `assertConfigured()` learns the pooled credit budget
   * from the proxy and re-sizes the poll interval to fit it. MarketDataService
   * re-reads these on every schedule, so more API keys mean faster polling
   * with no config change.
   */
  readonly capabilities = {
    streaming: false,
    bidAsk: false,
    changeBasis: 'daily-close' as const,
    pollIntervalMs: APP_CONFIG.twelveDataPollMs,
    // Each chart refresh costs a credit; keep well under the free-plan budget.
    candleRefreshMs: Math.max(120_000, APP_CONFIG.twelveDataPollMs * 2),
  };

  private readonly budget = new CreditBudget({
    perMinute: APP_CONFIG.twelveDataCreditsPerMinute,
    perDay: APP_CONFIG.twelveDataCreditsPerDay,
  });

  /**
   * Asks the proxy how many API keys are pooled and widens the local credit
   * meter to the pooled budget. This hits OUR server only — no Twelve Data
   * call, so it costs no credits. Missing/invalid keys still surface on the
   * first quote request as 'auth'.
   *
   * Only a genuine "no keys configured" answer is fatal; any other failure
   * (old deployment without /_status, transient network error) leaves the
   * single-key defaults from APP_CONFIG in place rather than halting the app.
   */
  async assertConfigured(signal?: AbortSignal): Promise<void> {
    let status: TdPoolStatus;
    try {
      status = await fetchJson<TdPoolStatus>(`${REST}/_status`, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      const e = toProviderError(err);
      if (e.kind === 'config' && e.code === 'NOT_CONFIGURED') throw e;
      return; // degrade to the per-key defaults
    }
    if (!status || typeof status.keys !== 'number' || status.keys < 1) return;
    this.budget.setLimits({
      perMinute: status.perMinuteTotal,
      perDay: status.perDayTotal,
      poolSize: status.keys,
    });
    this.applyBudgetToPolling(status.perMinuteTotal);
  }

  /**
   * Make sure the quote poll alone fits the per-minute budget.
   *
   * /quote costs 1 credit PER SYMBOL, so 7 pairs cost 7 credits per refresh.
   * On one free key (8/min) that fits a 60s poll with ~1 credit/min to spare;
   * 12 pairs would not fit at all, and polling on the configured interval
   * would just feed the rate limiter.
   *
   *   floor = symbols × 60s ÷ perMinuteTotal      (7 pairs, 1 key → 53s)
   *   poll  = max(configured, floor)
   *
   * PRICES WIN: the interval is never stretched beyond what the budget
   * actually requires, because stale prices are worse than a strategy that
   * warms up over a few minutes. Candles (charts + strategy) then live off
   * whatever credits are left, and their requests are marked `background`
   * so they skip rather than queue in front of a price update.
   */
  applyBudgetToPolling(perMinuteTotal: number, symbolCount = this.symbolCount): void {
    if (!Number.isFinite(perMinuteTotal) || perMinuteTotal <= 0 || symbolCount <= 0) return;
    const floorMs = Math.ceil((symbolCount * 60_000) / perMinuteTotal);
    this.capabilities.pollIntervalMs = Math.min(MAX_POLL_MS, Math.max(APP_CONFIG.twelveDataPollMs, floorMs));
    this.capabilities.candleRefreshMs = Math.max(120_000, this.capabilities.pollIntervalMs * 2);
  }

  /** Symbols the scanner polls, needed to size the interval. Set by the service. */
  private symbolCount = 1;

  setSymbolCount(count: number): void {
    this.symbolCount = Math.max(1, count);
  }

  async getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    if (symbols.length === 0) return { quotes: [], failed: [] };
    const qs = new URLSearchParams({ symbol: symbols.join(','), interval: '1day', timezone: 'UTC' });
    await this.budget.reserve(symbols.length, signal); // 1 credit per symbol

    let body: unknown;
    try {
      body = await fetchJson<unknown>(`${REST}/quote?${qs}`, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw toProviderError(err);
    }
    if (isError(body)) throw mapError(body, symbols.length === 1 ? symbols[0] : undefined);

    // Single symbol → quote object. Multiple → { "EUR/USD": quote, ... }
    const entries: [string, unknown][] =
      symbols.length === 1 ? [[symbols[0]!, body]] : symbols.map((s) => [s, (body as Record<string, unknown>)[s]]);

    const batch: QuoteBatch = { quotes: [], failed: [] };
    const receivedAt = Date.now();
    for (const [symbol, raw] of entries) {
      if (!raw) {
        batch.failed.push({ symbol, error: new ProviderError('no_data', `No data for ${symbol}`, { symbol }) });
        continue;
      }
      if (isError(raw)) {
        const e = mapError(raw, symbol);
        if (e.kind === 'auth' || e.kind === 'rate_limit') throw e; // systemic
        batch.failed.push({ symbol, error: e });
        continue;
      }
      const q = raw as TdQuote;
      const price = num(q.close);
      if (price === null) {
        batch.failed.push({ symbol, error: new ProviderError('no_data', `No price for ${symbol}`, { symbol }) });
        continue;
      }
      const ts = q.last_quote_at ?? q.timestamp;
      batch.quotes.push({
        symbol,
        price,
        bid: null,
        ask: null,
        spreadPips: null,
        changePct: num(q.percent_change),
        timestamp: ts ? ts * 1000 : receivedAt,
        receivedAt,
        marketOpen: typeof q.is_market_open === 'boolean' ? q.is_market_open : null,
      });
    }
    return batch;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    signal?: AbortSignal,
    opts?: CandleRequestOptions,
  ): Promise<Candle[]> {
    const qs = tdSeriesQuery(symbol, timeframe, count);
    // Background scans yield the credit rather than queue behind the window.
    await this.budget.reserve(1, signal, opts?.background ? BACKGROUND_WAIT_MS : USER_WAIT_MS);
    let body: unknown;
    try {
      body = await fetchJson<unknown>(`${REST}/time_series?${qs}`, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw toProviderError(err);
    }
    return parseTdSeries(body, symbol);
  }
}


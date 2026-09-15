/**
 * Provider-agnostic market-data contracts.
 * The UI and state layers ONLY depend on these types — never on a provider.
 */
import type { Timeframe } from '../../config/timeframes';

export type ProviderId = 'oanda' | 'twelvedata';

/** Connection state shown in the UI. */
export type ConnectionStatus = 'LOADING' | 'ONLINE' | 'OFFLINE' | 'ERROR';

export interface Quote {
  symbol: string;
  /** Mid price (or last price if the provider has no bid/ask). */
  price: number;
  bid: number | null;
  ask: number | null;
  /** ask - bid in PIPS; null when bid/ask are not provided. */
  spreadPips: number | null;
  /** Percent change over the provider's change basis (see ProviderCapabilities). */
  changePct: number | null;
  /** Provider timestamp of the price (ms since epoch). */
  timestamp: number;
  /** When our app received it (ms since epoch). */
  receivedAt: number;
  /** false during weekend / holiday closures. null = unknown. */
  marketOpen: boolean | null;
}

export interface Candle {
  /** Candle open time, UNIX seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  complete: boolean;
}

export interface ProviderCapabilities {
  streaming: boolean;
  bidAsk: boolean;
  /** How 24H change is derived — shown to the user in a tooltip. */
  changeBasis: 'rolling-24h' | 'daily-close';
  /** Polling interval in ms (rate-limit aware). Used when streaming is unavailable. */
  pollIntervalMs: number;
  /** Chart refresh interval in ms. */
  candleRefreshMs: number;
}

export interface QuoteBatch {
  quotes: Quote[];
  failed: { symbol: string; error: ProviderError }[];
}

/** Called with price updates. An EMPTY array means "heartbeat: connection alive". */
export type QuoteListener = (quotes: Quote[]) => void;

export interface StreamHandle {
  close(): void;
}

/**
 * The only contract a provider must fulfil.
 * Swap providers without touching UI or state code.
 */
export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /** Throws ProviderError(kind='config' | 'auth') if the provider cannot be used. */
  assertConfigured(signal?: AbortSignal): Promise<void>;

  /**
   * Batch quote request. Unknown symbols are reported in `failed`
   * instead of failing the whole batch.
   */
  getQuotes(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch>;

  getCandles(symbol: string, timeframe: Timeframe, count: number, signal?: AbortSignal): Promise<Candle[]>;

  /**
   * Optional push stream. Must call onError when the stream dies so the
   * service can fall back to polling.
   */
  subscribe?(symbols: string[], onQuotes: QuoteListener, onError: (err: ProviderError) => void): StreamHandle;
}

export type ProviderErrorKind =
  | 'config' // missing credentials / setup
  | 'auth' // rejected credentials
  | 'rate_limit' // 429 / credit exhaustion
  | 'network' // fetch failed, timeout, stream dropped
  | 'invalid_symbol' // provider does not know the instrument
  | 'no_data' // valid request, empty result
  | 'provider'; // anything else from the provider

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs?: number;
  readonly symbol?: string;

  constructor(kind: ProviderErrorKind, message: string, opts: { retryAfterMs?: number; symbol?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = opts.retryAfterMs;
    this.symbol = opts.symbol;
  }
}

export const isAbort = (err: unknown) =>
  (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ProviderError('network', msg || 'Network error');
}

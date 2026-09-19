/**
 * Client for the stored signal history.
 *
 *   write  POST /api/signals   (Bearer <ingest token>)
 *   read   GET  /api/signals?symbol=&timeframe=&outcome=&limit=
 *
 * The browser has no database credentials: the server holds the Supabase
 * service key and the table denies everyone else. All this does is talk to
 * our own API.
 */
import type { TouchSignal } from '../strategy';

export interface HistoryFilters {
  symbol?: string;
  timeframe?: string;
  outcome?: string;
  limit?: number;
}

export interface HistoryResponse {
  signals: TouchSignal[];
  /** False when SUPABASE_URL / SUPABASE_SERVICE_KEY are not set on the server. */
  configured: boolean;
  requiresToken: boolean;
}

export class SignalStoreError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-configured' | 'unauthorized' | 'network' | 'server',
  ) {
    super(message);
    this.name = 'SignalStoreError';
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { errorMessage?: string };
    return body.errorMessage ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchHistory(filters: HistoryFilters = {}, signal?: AbortSignal): Promise<HistoryResponse> {
  const qs = new URLSearchParams();
  if (filters.symbol) qs.set('symbol', filters.symbol);
  if (filters.timeframe) qs.set('timeframe', filters.timeframe);
  if (filters.outcome) qs.set('outcome', filters.outcome);
  if (filters.limit) qs.set('limit', String(filters.limit));

  let res: Response;
  try {
    res = await fetch(`/api/signals?${qs}`, { signal, headers: { Accept: 'application/json' } });
  } catch {
    throw new SignalStoreError('Cannot reach the signal store', 'network');
  }
  if (res.status === 503) throw new SignalStoreError(await readError(res, 'Signal storage is not configured'), 'not-configured');
  if (!res.ok) throw new SignalStoreError(await readError(res, `HTTP ${res.status}`), 'server');
  return (await res.json()) as HistoryResponse;
}

export interface StoreResult {
  stored: number;
  rejected: number;
}

export async function storeSignals(signals: TouchSignal[], token: string): Promise<StoreResult> {
  let res: Response;
  try {
    res = await fetch('/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ signals }),
    });
  } catch {
    throw new SignalStoreError('Cannot reach the signal store', 'network');
  }
  if (res.status === 401) throw new SignalStoreError('The ingest token was rejected', 'unauthorized');
  if (res.status === 503) throw new SignalStoreError(await readError(res, 'Signal storage is not configured'), 'not-configured');
  if (!res.ok) throw new SignalStoreError(await readError(res, `HTTP ${res.status}`), 'server');
  return (await res.json()) as StoreResult;
}

/**
 * What identifies a "version" of a signal for sending purposes.
 *
 * The same bar is re-reported as it resolves — a live tick becomes a forming
 * candle, then a closed one with a real outcome. Keying on id alone would
 * send only the first of those and store a permanently 'pending' row.
 */
export const signalVersion = (s: TouchSignal) => `${s.id}|${s.source}|${s.outcome}`;

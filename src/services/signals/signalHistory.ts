/**
 * Reading stored signals.
 *
 * The browser no longer writes: the scanner produces signals server-side, so
 * this is a read client and nothing more. The ingest token went with the write
 * path.
 */

/** A stored signal, as /api/signals returns it. */
export interface StoredSignal {
  id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  /** Open time of the analysed bar, UNIX seconds. */
  barTime: number;
  detectedAt: number;
  direction: 'long' | 'short';
  signal: string;
  confidence: number;
  marketCondition: string;
  setupStatus: string;
  price: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  stopPips: number | null;
  result: 'pending' | 'tp' | 'sl' | 'expired' | 'invalidated';
  closedPrice: number | null;
  closedAt: number | null;
  /** Result in multiples of risk. Null while open. */
  rMultiple: number | null;
  /** The full structured analysis, so a signal can be re-explained. */
  analysis: Record<string, unknown> | null;
  reasons: string[];
  warnings: string[];
}

export interface HistoryFilters {
  symbol?: string;
  timeframe?: string;
  result?: string;
  direction?: string;
  limit?: number;
}

export class SignalStoreError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-configured' | 'network' | 'server',
  ) {
    super(message);
    this.name = 'SignalStoreError';
  }
}

export interface HistoryResponse {
  signals: StoredSignal[];
  configured: boolean;
}

export async function fetchHistory(filters: HistoryFilters = {}, signal?: AbortSignal): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (filters.symbol) params.set('symbol', filters.symbol);
  if (filters.timeframe) params.set('timeframe', filters.timeframe);
  if (filters.result) params.set('result', filters.result);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.limit) params.set('limit', String(filters.limit));

  let res: Response;
  try {
    res = await fetch(`/api/signals${params.size ? `?${params}` : ''}`, { signal });
  } catch (err) {
    throw new SignalStoreError(`Could not reach the history endpoint (${(err as Error).message})`, 'network');
  }

  const body = (await res.json().catch(() => null)) as (HistoryResponse & { errorMessage?: string }) | null;

  if (res.status === 503) {
    throw new SignalStoreError(body?.errorMessage ?? 'Signal storage is not configured.', 'not-configured');
  }
  if (!res.ok) {
    throw new SignalStoreError(body?.errorMessage ?? `History request failed (HTTP ${res.status})`, 'server');
  }
  return { signals: body?.signals ?? [], configured: body?.configured ?? false };
}

/** Open trades have no result yet and must not count toward any statistic. */
export const isClosed = (s: StoredSignal): boolean => s.result !== 'pending' && s.rMultiple !== null;

/** Human label for a result code. */
export const RESULT_LABEL: Record<StoredSignal['result'], string> = {
  pending: 'Open',
  tp: 'Target hit',
  sl: 'Stopped',
  expired: 'Expired',
  invalidated: 'Invalidated',
};

/**
 * Supabase access for the scanner.
 *
 * Everything goes through PostgREST with the SERVICE ROLE key, which bypasses
 * RLS. That key never leaves the server — the tables have RLS on with no
 * policies, so an anon key cannot read or write them even if it leaks.
 *
 * Writes are RPCs rather than table calls, because the invariants that keep
 * the data honest (idempotent inserts, first-close-wins, R computed from the
 * row's own levels) belong in SQL where two concurrent scanners cannot race
 * around them. See supabase/migrations/.
 */
import type { StrategyAnalysis, TrackedSetup } from '../src/services/strategy';

export interface SignalsDbConfig {
  url: string;
  serviceKey: string;
}

export function readDbConfig(env: Record<string, string | undefined>): SignalsDbConfig {
  return {
    url: (env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (env.SUPABASE_SERVICE_KEY || '').trim(),
  };
}

export const isDbConfigured = (cfg: SignalsDbConfig): boolean => Boolean(cfg.url && cfg.serviceKey);

/** A row of public.signals, in the shape the scanner needs back. */
export interface PendingSignal {
  id: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  bar_time: string;
}

export type Outcome = 'tp' | 'sl' | 'expired' | 'invalidated';

export interface SignalsDb {
  loadSetupState(): Promise<TrackedSetup[]>;
  saveSetupState(setups: readonly TrackedSetup[]): Promise<number>;
  loadPending(): Promise<PendingSignal[]>;
  recordSignals(rows: readonly SignalRow[]): Promise<number>;
  closeSignal(id: string, outcome: Outcome, price: number): Promise<number>;
  lastRunStartedAt(): Promise<number | null>;
  /** Round-robin cursor from the previous run, so the tail is not starved. */
  lastCursor(): Promise<number>;
  startRun(): Promise<number | null>;
  finishRun(id: number | null, summary: RunSummary): Promise<void>;
  expireStale(days: number): Promise<number>;
}

export interface RunSummary {
  ok: boolean;
  scanned: number;
  emitted: number;
  closed: number;
  creditsUsed: number;
  errors: string[];
  detail?: unknown;
}

/** The exact column set public.record_signals expects. */
export interface SignalRow {
  id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  bar_time: string;
  detected_at: string;
  direction: 'long' | 'short';
  signal: string;
  confidence: number;
  market_condition: string;
  setup_status: string;
  price: number;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  stop_pips: number | null;
  analysis: unknown;
  reasons: string[];
  warnings: string[];
}

/**
 * Turn an analysis into a row.
 *
 * The id is DETERMINISTIC — strategy|symbol|timeframe|barTime — which is what
 * makes record_signals idempotent. A cron that fires twice over the same bar
 * produces the same id and the second insert does nothing.
 */
export function toSignalRow(analysis: StrategyAnalysis, strategy: string, detectedAtMs: number): SignalRow | null {
  if (analysis.direction === 'none') return null;
  return {
    id: `${strategy}|${analysis.symbol}|${analysis.timeframe}|${analysis.barTime}`,
    strategy,
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    bar_time: new Date(analysis.barTime * 1000).toISOString(),
    detected_at: new Date(detectedAtMs).toISOString(),
    direction: analysis.direction,
    signal: analysis.signal,
    confidence: analysis.confidence,
    market_condition: analysis.marketCondition,
    setup_status: analysis.status,
    price: analysis.price,
    entry: analysis.risk.entry,
    stop_loss: analysis.risk.stop,
    take_profit: analysis.risk.target,
    stop_pips: analysis.risk.stopPips,
    analysis,
    reasons: analysis.reasons,
    warnings: analysis.warnings,
  };
}


class DbError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DbError';
  }
}

type FetchLike = typeof fetch;

export function createSignalsDb(cfg: SignalsDbConfig, fetchImpl: FetchLike = fetch): SignalsDb {
  const headers = {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetchImpl(`${cfg.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new DbError(`${path} → HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    return (text ? JSON.parse(text) : null) as T;
  }

  const rpc = <T>(fn: string, body: unknown): Promise<T> =>
    call<T>(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });

  return {
    async loadSetupState() {
      const rows = await call<Record<string, unknown>[]>('/rest/v1/setup_state?select=*', { method: 'GET' });
      return (rows ?? []).map((r) => ({
        key: String(r.key),
        symbol: String(r.symbol),
        timeframe: String(r.timeframe),
        direction: r.direction as TrackedSetup['direction'],
        status: r.status as TrackedSetup['status'],
        firstBarTime: r.first_bar_time ? Math.floor(Date.parse(String(r.first_bar_time)) / 1000) : 0,
        lastBarTime: r.last_bar_time ? Math.floor(Date.parse(String(r.last_bar_time)) / 1000) : 0,
        anchor: r.anchor === null || r.anchor === undefined ? null : Number(r.anchor),
        emittedConfidence:
          r.emitted_confidence === null || r.emitted_confidence === undefined ? null : Number(r.emitted_confidence),
        emittedAt: r.emitted_at ? Date.parse(String(r.emitted_at)) : null,
      }));
    },

    async saveSetupState(setups) {
      if (setups.length === 0) return 0;
      const payload = setups.map((s) => ({
        key: s.key,
        symbol: s.symbol,
        timeframe: s.timeframe,
        direction: s.direction,
        status: s.status,
        first_bar_time: new Date(s.firstBarTime * 1000).toISOString(),
        last_bar_time: new Date(s.lastBarTime * 1000).toISOString(),
        anchor: s.anchor,
        emitted_confidence: s.emittedConfidence,
        emitted_at: s.emittedAt === null ? null : new Date(s.emittedAt).toISOString(),
      }));
      return (await rpc<number>('save_setup_state', { payload })) ?? 0;
    },

    async loadPending() {
      const query =
        'select=id,symbol,timeframe,direction,entry,stop_loss,take_profit,bar_time' +
        '&result=eq.pending&order=bar_time.desc&limit=200';
      return (await call<PendingSignal[]>(`/rest/v1/signals?${query}`, { method: 'GET' })) ?? [];
    },

    async recordSignals(rows) {
      if (rows.length === 0) return 0;
      return (await rpc<number>('record_signals', { payload: rows })) ?? 0;
    },

    closeSignal: (id, outcome, price) =>
      rpc<number>('close_signal', { p_signal_id: id, p_outcome: outcome, p_price: price }).then((n) => n ?? 0),


    async lastRunStartedAt() {
      const rows = await call<{ started_at: string }[]>(
        '/rest/v1/scanner_runs?select=started_at&order=started_at.desc&limit=1',
        { method: 'GET' },
      );
      const first = rows?.[0];
      return first ? Date.parse(first.started_at) : null;
    },

    async lastCursor() {
      const rows = await call<{ detail: { nextOffset?: number } | null }[]>(
        '/rest/v1/scanner_runs?select=detail&detail=not.is.null&order=started_at.desc&limit=1',
        { method: 'GET' },
      );
      const offset = rows?.[0]?.detail?.nextOffset;
      return typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 ? offset : 0;
    },

    async startRun() {
      const rows = await call<{ id: number }[]>('/rest/v1/scanner_runs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({}),
      });
      return rows?.[0]?.id ?? null;
    },

    async finishRun(id, summary) {
      if (id === null) return;
      await call(`/rest/v1/scanner_runs?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          finished_at: new Date().toISOString(),
          ok: summary.ok,
          scanned: summary.scanned,
          emitted: summary.emitted,
          closed: summary.closed,
          credits_used: summary.creditsUsed,
          errors: summary.errors,
          detail: summary.detail ?? null,
        }),
      });
    },

    async expireStale(days) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = await call<{ id: string }[]>(
        `/rest/v1/signals?result=eq.pending&bar_time=lt.${cutoff}&select=id`,
        { method: 'GET' },
      );
      let expired = 0;
      for (const row of rows ?? []) {
        expired += await rpc<number>('close_signal', {
          p_signal_id: row.id,
          p_outcome: 'expired',
          p_price: 0,
        }).then((n) => n ?? 0);
      }
      return expired;
    },
  };
}

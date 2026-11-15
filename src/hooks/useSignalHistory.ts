/**
 * The stored signal history, read from /api/signals.
 *
 * This is the one part of the app that does NOT compute its answer from the
 * candles on screen. Everything else — the scanner rows, the pair page, the
 * backtest — is a pure function of bars the browser already holds, which is
 * what makes them impossible to disagree with each other. The history cannot
 * work that way: its whole purpose is to know what happened while nobody had
 * the site open.
 *
 * So it is read-only here. The browser never writes a signal. The server-side
 * scanner is the only writer, which is what stops the table filling up with
 * rows that describe when somebody was looking at the page rather than what
 * the market did.
 *
 * `configured: false` is a normal answer, not an error: it means no database
 * is attached yet. The page says so and explains the setup rather than
 * showing a failure.
 */
import { useCallback, useEffect, useState } from 'react';

/** One row of the history. Times are UNIX seconds, as the API sends them. */
export interface StoredSignal {
  id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  bar_time: number;
  detected_at: number;
  source: 'candle' | 'live';
  price: number;
  ema: number;
  atr: number;
  tolerance_pips: number;
  distance_pips: number;
  approach: 'above' | 'below';
  outcome: string;
  trend: string;
  bias: string;
  counter_trend: boolean;
  ichimoku: { score?: number } | null;
  ichimoku_score: number | null;
  direction: 'LONG' | 'SHORT' | null;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  stop_pips: number | null;
  /** 'open' while price has decided nothing; 'nofill' never became a trade. */
  result: 'open' | 'tp' | 'sl' | 'nofill' | 'expired';
  exit_price: number | null;
  exit_at: number | null;
  bars_held: number | null;
  /** Net pips, before spread. Null until the trade resolves. */
  result_pips: number | null;
}

export interface SymbolStats {
  symbol: string;
  total: number;
  open: number;
  tp: number;
  sl: number;
  nofill: number;
  net_pips: number | null;
  avg_stop_pips: number | null;
}

export interface HistoryState {
  status: 'LOADING' | 'READY' | 'ERROR';
  /** False when no database is attached — not a failure. */
  configured: boolean;
  signals: StoredSignal[];
  stats: SymbolStats[];
  error: string | null;
  reload: () => void;
}

/** Postgres returns numerics as strings over JSON; the UI wants numbers. */
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const toSignal = (r: Record<string, unknown>): StoredSignal =>
  ({
    ...r,
    bar_time: n(r.bar_time) ?? 0,
    detected_at: n(r.detected_at) ?? 0,
    price: n(r.price) ?? 0,
    ema: n(r.ema) ?? 0,
    atr: n(r.atr) ?? 0,
    tolerance_pips: n(r.tolerance_pips) ?? 0,
    distance_pips: n(r.distance_pips) ?? 0,
    ichimoku_score: n(r.ichimoku_score),
    entry: n(r.entry),
    stop_loss: n(r.stop_loss),
    take_profit: n(r.take_profit),
    stop_pips: n(r.stop_pips),
    exit_price: n(r.exit_price),
    exit_at: n(r.exit_at),
    bars_held: n(r.bars_held),
    result_pips: n(r.result_pips),
  }) as StoredSignal;

const toStats = (r: Record<string, unknown>): SymbolStats => ({
  symbol: String(r.symbol),
  total: n(r.total) ?? 0,
  open: n(r.open) ?? 0,
  tp: n(r.tp) ?? 0,
  sl: n(r.sl) ?? 0,
  nofill: n(r.nofill) ?? 0,
  net_pips: n(r.net_pips),
  avg_stop_pips: n(r.avg_stop_pips),
});

export function useSignalHistory(limit = 300): HistoryState {
  const [state, setState] = useState<Omit<HistoryState, 'reload'>>({
    status: 'LOADING',
    configured: false,
    signals: [],
    stats: [],
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    const ac = new AbortController();

    // Two requests rather than one: the stats are an aggregate the database
    // computes far faster than the browser could over a truncated page of
    // rows, and the rows are capped for display.
    Promise.all([
      fetch(`/api/signals?limit=${limit}`, { signal: ac.signal }).then((r) => r.json()),
      fetch('/api/signals?stats=1', { signal: ac.signal }).then((r) => r.json()),
    ])
      .then(([rows, agg]) => {
        if (ac.signal.aborted) return;
        if (rows?.error) throw new Error(rows.errorMessage || rows.error);
        setState({
          status: 'READY',
          configured: Boolean(rows?.configured),
          signals: (rows?.signals ?? []).map(toSignal),
          stats: (agg?.stats ?? []).map(toStats),
          error: null,
        });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setState({
          status: 'ERROR',
          configured: false,
          signals: [],
          stats: [],
          error: e instanceof Error ? e.message : String(e),
        });
      });

    return () => ac.abort();
  }, [limit, nonce]);

  return { ...state, reload };
}

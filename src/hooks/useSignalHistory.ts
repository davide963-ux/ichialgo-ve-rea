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
  kumo: 'above' | 'below' | null;
  kijun: number | null;
  tenkan: number | null;
  senkou_a: number | null;
  senkou_b: number | null;
  /** The cloud 26 bars ahead, as computed at the signal bar. */
  senkou_ahead_a: number | null;
  senkou_ahead_b: number | null;
  distance_pips: number | null;
  /** The 26-bar range in pips — what the stop is a fraction of. */
  range_pips: number | null;
  /** Cloud thickness in pips. A thick cloud is stronger support/resistance. */
  cloud_pips: number | null;
  /** Checks that passed. Every stored row met its strategy's required ones. */
  score: number | null;
  /** How many there were. A 3/3 and a 3/5 are not the same statement. */
  checks_total: number | null;
  /**
   * The conditions the detector stated, in its own words. Null on rows
   * written before strategies could differ — see 0003_strategies.sql.
   */
  checks: { label: string; pass: boolean | null; detail: string; required: boolean }[] | null;
  direction: 'LONG' | 'SHORT' | null;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  stop_pips: number | null;
  /** Which entry fired: 'breakout' or 'pullback'. Null on retired rows. */
  entry_type: string | null;
  /**
   * 'open' while price has decided nothing; 'expired' when the entry bar
   * scrolled out of the candle window before it did.
   *
   * 'nofill' is in the union only because rows from the retired EMA50-touch
   * strategy use it. The current strategy enters at the signal bar's close,
   * which is a price that traded by definition, so it cannot produce one —
   * and /api/signals filters by strategy, so one should never arrive here.
   */
  result: 'open' | 'tp' | 'sl' | 'nofill' | 'expired';
  exit_price: number | null;
  exit_at: number | null;
  bars_held: number | null;
  /** Net pips, before spread. Null until the trade resolves. */
  result_pips: number | null;
}

export interface SymbolStats {
  strategy: string;
  /**
   * Which entry produced these rows: 'breakout' or 'pullback'. Null on rows
   * from the retired strategies that had only one entry.
   *
   * The stats are grouped by it, not merely tagged with it, and that is the
   * point: the two entries place their stops differently — Kijun for a
   * pullback, the far cloud edge for a breakout — so the pullback risks
   * roughly a third of what the breakout does. A net-pips figure that pooled
   * them would be adding a 12-pip bet to a 40-pip bet and reporting the sum.
   */
  entry_type: string | null;
  symbol: string;
  total: number;
  open: number;
  tp: number;
  sl: number;
  expired: number;
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
    kijun: n(r.kijun),
    tenkan: n(r.tenkan),
    senkou_a: n(r.senkou_a),
    senkou_b: n(r.senkou_b),
    senkou_ahead_a: n(r.senkou_ahead_a),
    senkou_ahead_b: n(r.senkou_ahead_b),
    distance_pips: n(r.distance_pips),
    range_pips: n(r.range_pips),
    cloud_pips: n(r.cloud_pips),
    score: n(r.score),
    checks_total: n(r.checks_total),
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
  strategy: String(r.strategy),
  entry_type: r.entry_type == null ? null : String(r.entry_type),
  symbol: String(r.symbol),
  total: n(r.total) ?? 0,
  open: n(r.open) ?? 0,
  tp: n(r.tp) ?? 0,
  sl: n(r.sl) ?? 0,
  expired: n(r.expired) ?? 0,
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

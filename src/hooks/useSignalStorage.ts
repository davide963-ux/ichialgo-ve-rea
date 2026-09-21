/**
 * Reading the stored signal history.
 *
 * The persistence hook that used to live here is gone: signals are produced by
 * the server-side scanner now, so there is nothing for a browser to push. What
 * remains is a read hook and the derived performance report.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SignalStoreError,
  fetchHistory,
  type HistoryFilters,
  type StoredSignal,
} from '../services/signals/signalHistory';
import { buildReport, type MeasuredTrade, type PerformanceReport } from '../services/strategy/performance';

export interface HistoryState {
  status: 'LOADING' | 'READY' | 'OFF' | 'ERROR';
  signals: StoredSignal[];
  error: string | null;
  configured: boolean;
  reload: () => void;
}

/** Reads stored signals for the history and performance views. */
export function useSignalHistory(filters: HistoryFilters): HistoryState {
  const [state, setState] = useState<Omit<HistoryState, 'reload'>>({
    status: 'LOADING',
    signals: [],
    error: null,
    configured: true,
  });
  const [nonce, setNonce] = useState(0);
  const { symbol, timeframe, result, direction, limit } = filters;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((p) => ({ ...p, status: 'LOADING' }));
    fetchHistory({ symbol, timeframe, result, direction, limit }, ctrl.signal)
      .then((res) => setState({ status: 'READY', signals: res.signals, error: null, configured: res.configured }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const e = err as SignalStoreError;
        setState({
          status: e.kind === 'not-configured' ? 'OFF' : 'ERROR',
          signals: [],
          error: e.message,
          configured: false,
        });
      });
    return () => ctrl.abort();
  }, [symbol, timeframe, result, direction, limit, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/**
 * The performance report for a set of stored signals.
 *
 * Trades are reversed before measuring: the API returns newest first, and
 * drawdown is path-dependent, so it has to walk the trades in the order they
 * actually happened.
 */
export function usePerformance(signals: readonly StoredSignal[]): PerformanceReport {
  return useMemo(() => {
    const trades: MeasuredTrade[] = [...signals].reverse().map((s) => ({
      direction: s.direction,
      timeframe: s.timeframe,
      marketCondition: s.marketCondition,
      signal: s.signal,
      outcome: s.result,
      rMultiple: s.rMultiple,
      confidence: s.confidence,
      symbol: s.symbol,
    }));
    return buildReport(trades);
  }, [signals]);
}

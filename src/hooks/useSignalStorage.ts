/**
 * Persisting signals, and reading the history back.
 *
 *   signalStore ──(batched, every flushMs)──▶ POST /api/signals ──▶ Supabase
 *   History page ──▶ GET /api/signals ──▶ rows
 *
 * Writes are batched rather than sent per signal: a scan can resolve several
 * touches at once, and the endpoint takes an array. Each signal is sent again
 * when its VERSION changes (live → forming → resolved), so a row that was
 * stored as 'pending' is later updated with the outcome it actually had.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SignalStoreError,
  fetchHistory,
  signalVersion,
  storeSignals,
  type HistoryFilters,
} from '../services/signals/signalHistory';
import type { TouchSignal } from '../services/strategy';
import { useIngestToken } from '../state/ingestStore';
import { useSignalStore } from '../state/signalStore';

const FLUSH_MS = 5_000;
const BATCH = 100;

export type StorageState = 'off' | 'no-token' | 'saving' | 'saved' | 'error';

export interface SignalStorage {
  state: StorageState;
  /** Rows written in this session. */
  stored: number;
  error: string | null;
  lastSavedAt: number | null;
}

/**
 * Runs once for the whole app. Watches the live signal log and writes new or
 * changed signals to the store.
 */
export function useSignalPersistence(): SignalStorage {
  const signals = useSignalStore((s) => s.signals);
  const token = useIngestToken();
  const [status, setStatus] = useState<SignalStorage>({ state: 'off', stored: 0, error: null, lastSavedAt: null });

  /** Versions already accepted by the server, so nothing is sent twice. */
  const sent = useRef(new Set<string>());
  const pending = useRef(new Map<string, TouchSignal>());
  const inFlight = useRef(false);

  // Queue anything new or changed. Cheap: this only diffs against a Set.
  useEffect(() => {
    for (const s of signals) {
      const version = signalVersion(s);
      if (sent.current.has(version)) continue;
      pending.current.set(version, s);
    }
  }, [signals]);

  useEffect(() => {
    if (!token) {
      setStatus((p) => ({ ...p, state: 'no-token' }));
      return;
    }
    let cancelled = false;

    const flush = async () => {
      if (cancelled || inFlight.current || pending.current.size === 0) return;
      const batch = [...pending.current.entries()].slice(0, BATCH);
      inFlight.current = true;
      setStatus((p) => ({ ...p, state: 'saving' }));
      try {
        await storeSignals(batch.map(([, s]) => s), token);
        if (cancelled) return;
        // Only forget them once the server has them.
        for (const [version] of batch) {
          pending.current.delete(version);
          sent.current.add(version);
        }
        setStatus((p) => ({
          state: 'saved',
          stored: p.stored + batch.length,
          error: null,
          lastSavedAt: Date.now(),
        }));
      } catch (err) {
        if (cancelled) return;
        const e = err as SignalStoreError;
        // Left in `pending`, so a transient failure retries on the next tick.
        setStatus((p) => ({ ...p, state: e.kind === 'not-configured' ? 'off' : 'error', error: e.message }));
      } finally {
        inFlight.current = false;
      }
    };

    void flush();
    const timer = setInterval(() => void flush(), FLUSH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  return status;
}

export interface HistoryState {
  status: 'LOADING' | 'READY' | 'OFF' | 'ERROR';
  signals: TouchSignal[];
  error: string | null;
  configured: boolean;
  reload: () => void;
}

/** Reads stored signals for the history view. */
export function useSignalHistory(filters: HistoryFilters): HistoryState {
  const [state, setState] = useState<Omit<HistoryState, 'reload'>>({
    status: 'LOADING',
    signals: [],
    error: null,
    configured: true,
  });
  const [nonce, setNonce] = useState(0);
  const { symbol, timeframe, outcome, limit } = filters;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((p) => ({ ...p, status: 'LOADING' }));
    fetchHistory({ symbol, timeframe, outcome, limit }, ctrl.signal)
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
  }, [symbol, timeframe, outcome, limit, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

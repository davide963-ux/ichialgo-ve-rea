/**
 * Signal Store — the strategy layer's counterpart to marketStore.
 *
 *   StrategyEngine ──set()──▶ signalStore ──useSignalStore()──▶ UI
 *
 * Holds the signal log (newest first), the live levels the engine watches,
 * and per-symbol notices. Same immutable external-store pattern as
 * marketStore: selectors must return primitives or stable references.
 */
import { useSyncExternalStore } from 'react';
import type { Timeframe } from '../config/timeframes';
import type { TouchSignal, WatchLevel } from '../services/strategy/types';

export type StrategyStatus = 'IDLE' | 'WARMING' | 'READY' | 'ERROR';

export interface SignalState {
  status: StrategyStatus;
  /** Timeframe the strategy is evaluated on. */
  timeframe: Timeframe;
  /** Newest first, capped by STRATEGY_CONFIG.maxSignals. */
  signals: TouchSignal[];
  /** Current EMA level per symbol. */
  levels: Readonly<Record<string, WatchLevel>>;
  /** Why a symbol produces nothing (too few candles, fetch failed…). */
  notices: Readonly<Record<string, string>>;
  lastScanAt: number | null;
  scanError: string | null;
}

type Listener = () => void;

const EMPTY: SignalState = {
  status: 'IDLE',
  timeframe: '15M',
  signals: [],
  levels: {},
  notices: {},
  lastScanAt: null,
  scanError: null,
};

let state: SignalState = EMPTY;
const listeners = new Set<Listener>();

export const signalStore = {
  get(): SignalState {
    return state;
  },
  set(patch: Partial<SignalState> | ((s: SignalState) => Partial<SignalState>)) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  },
  reset(timeframe: Timeframe) {
    state = { ...EMPTY, timeframe };
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSignalStore<T>(selector: (s: SignalState) => T): T {
  return useSyncExternalStore(
    signalStore.subscribe,
    () => selector(signalStore.get()),
    () => selector(signalStore.get()),
  );
}

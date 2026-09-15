/**
 * Market Data State — a tiny immutable external store.
 *
 *   MarketDataService ──setState()──▶ marketStore ──useMarketStore()──▶ UI
 *
 * UI components never talk to the service's provider; they read this state.
 * Selectors must return existing references (or primitives) to stay stable.
 */
import { useSyncExternalStore } from 'react';
import type { ConnectionStatus, ProviderCapabilities, ProviderErrorKind, ProviderId, Quote } from '../services/marketData/types';

export interface MarketState {
  status: ConnectionStatus;
  /** Human-readable reason for the current status (errors, rate limits…). */
  statusMessage: string | null;
  errorKind: ProviderErrorKind | null;
  provider: { id: ProviderId; label: string; capabilities: ProviderCapabilities };
  /** 'stream' | 'poll' once connected. */
  mode: 'stream' | 'poll' | null;
  symbols: string[];
  quotes: Readonly<Record<string, Quote>>;
  /** Per-symbol problems (invalid symbol, no data). */
  symbolErrors: Readonly<Record<string, string>>;
  /** Last time ANY price changed (ms). */
  lastUpdate: number | null;
  /** Last successful contact with the provider incl. heartbeats (ms). */
  lastContact: number | null;
  nextRetryAt: number | null;
}

type Listener = () => void;

let state: MarketState;
const listeners = new Set<Listener>();

export const marketStore = {
  init(initial: MarketState) {
    state = initial;
  },
  get(): MarketState {
    return state;
  },
  set(patch: Partial<MarketState> | ((s: MarketState) => Partial<MarketState>)) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useMarketStore<T>(selector: (s: MarketState) => T): T {
  return useSyncExternalStore(
    marketStore.subscribe,
    () => selector(marketStore.get()),
    () => selector(marketStore.get()),
  );
}

/** Prices are only "live" when the connection is ONLINE. */
export const isLive = (s: MarketState) => s.status === 'ONLINE';

/**
 * Account settings — balance and risk per trade, shared by the calculator
 * and the strategy's trade plans.
 *
 * Lives outside React (same external-store pattern as marketStore) because
 * the strategy layer needs it too, and is persisted to localStorage so the
 * numbers survive a reload. Nothing here is sent anywhere.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ichialgo.account';

export interface AccountState {
  /** Account balance in USD (the calculator's account currency). */
  balance: number;
  /** Percent of balance risked on one trade. */
  riskPct: number;
}

export const DEFAULT_ACCOUNT: AccountState = { balance: 10_000, riskPct: 1 };

type Listener = () => void;
const listeners = new Set<Listener>();

function load(): AccountState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ACCOUNT;
    const parsed = JSON.parse(raw) as Partial<AccountState>;
    return {
      balance: Number.isFinite(parsed.balance) && parsed.balance! > 0 ? parsed.balance! : DEFAULT_ACCOUNT.balance,
      riskPct:
        Number.isFinite(parsed.riskPct) && parsed.riskPct! > 0 && parsed.riskPct! <= 100
          ? parsed.riskPct!
          : DEFAULT_ACCOUNT.riskPct,
    };
  } catch {
    return DEFAULT_ACCOUNT; // private mode, blocked storage, corrupt value
  }
}

let state: AccountState = load();

export const accountStore = {
  get(): AccountState {
    return state;
  },
  set(patch: Partial<AccountState>) {
    const next = { ...state, ...patch };
    if (next.balance === state.balance && next.riskPct === state.riskPct) return;
    state = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable — in-memory settings still work for this session */
    }
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useAccount<T>(selector: (s: AccountState) => T): T {
  return useSyncExternalStore(
    accountStore.subscribe,
    () => selector(accountStore.get()),
    () => selector(DEFAULT_ACCOUNT),
  );
}

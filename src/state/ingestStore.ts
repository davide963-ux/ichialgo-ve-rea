/**
 * The ingest token, kept in localStorage.
 *
 * The app has no login, so the write endpoint is protected by a shared secret
 * that you set on the server and paste in here once. It is deliberately NOT
 * baked into the bundle: a VITE_ variable would be readable by anyone who
 * opens the deployed site, which would defeat the point.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ichialgo.ingestToken';

type Listener = () => void;
const listeners = new Set<Listener>();

function load(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return ''; // private mode, blocked storage
  }
}

let token = load();

export const ingestStore = {
  get: () => token,
  set(next: string) {
    const trimmed = next.trim();
    if (trimmed === token) return;
    token = trimmed;
    try {
      if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable — the token still works for this session */
    }
    listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const useIngestToken = (): string =>
  useSyncExternalStore(ingestStore.subscribe, ingestStore.get, () => '');

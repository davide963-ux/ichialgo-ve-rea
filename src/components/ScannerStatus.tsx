/**
 * Whether the 24/7 scanner is actually running.
 *
 * This exists because the failure mode is SILENT: if the cron stops firing, or
 * the token is wrong, or the credits run out, the app looks completely normal
 * — the dashboard still shows live prices and live analysis — while nothing is
 * being recorded. The only visible symptom would be a history that quietly
 * stops growing, which is exactly the kind of thing you notice a month late.
 *
 * It infers liveness from the newest stored signal rather than calling the
 * scanner: triggering a scan from the browser would spend credits every time
 * someone opened the page, and the scanner endpoint needs a secret the browser
 * must not have.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHistory, SignalStoreError } from '../services/signals/signalHistory';

type State =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ok'; lastAt: number; total: number };

/** Older than this and the scanner is probably not running. */
const STALE_MS = 6 * 60 * 60 * 1000;

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ScannerStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchHistory({ limit: 1 }, ctrl.signal)
      .then((res) => {
        const newest = res.signals[0];
        setState(newest ? { kind: 'ok', lastAt: newest.detectedAt, total: res.signals.length } : { kind: 'empty' });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const e = err as SignalStoreError;
        setState(e.kind === 'not-configured' ? { kind: 'off' } : { kind: 'error', message: e.message });
      });
    return () => ctrl.abort();
  }, []);

  if (state.kind === 'loading') return <span className="muted">Checking the scanner…</span>;

  if (state.kind === 'off') {
    return (
      <span className="muted">
        Scanner off — set <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_KEY</code> and <code>SCANNER_TOKEN</code>
      </span>
    );
  }

  if (state.kind === 'error') return <span className="neg">Scanner: {state.message}</span>;

  if (state.kind === 'empty') {
    return <span className="muted">Scanner configured — no signals recorded yet</span>;
  }

  const stale = Date.now() - state.lastAt > STALE_MS;
  return (
    <span className={stale ? 'neg' : undefined}>
      {stale ? '⚠ Scanner may be stalled — ' : 'Scanner live · '}
      last signal {ago(state.lastAt)} · <Link to="/history">history</Link>
    </span>
  );
}

import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { SignalTable } from '../components/SignalTable';
import { PAIRS } from '../config/pairs';
import { TIMEFRAMES } from '../config/timeframes';
import { useSignalHistory } from '../hooks/useSignalStorage';
import { formatNumber } from '../lib/format';
import { ingestStore, useIngestToken } from '../state/ingestStore';

const OUTCOMES = ['bounce', 'cross', 'inside', 'pending'] as const;

/**
 * Every signal the strategy has ever produced, read back from the database.
 *
 * The live scanner keeps its log in memory and loses it on refresh; this is
 * the record that accumulates. Over time it is what makes the strategy
 * measurable rather than merely plausible — how often a touch actually held,
 * per pair, per timeframe, split by Ichimoku agreement.
 */
export function History() {
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [outcome, setOutcome] = useState('');
  const { status, signals, error, reload } = useSignalHistory({
    symbol: symbol || undefined,
    timeframe: timeframe || undefined,
    outcome: outcome || undefined,
    limit: 500,
  });

  const resolved = signals.filter((s) => s.outcome === 'bounce' || s.outcome === 'cross');
  const held = resolved.filter((s) => s.outcome === 'bounce').length;
  const confluent = signals.filter((s) => s.ichimoku?.agrees).length;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Signal history</h1>
          <p>Every EMA50 touch the strategy has recorded, kept across sessions.</p>
        </div>
      </div>

      {status === 'OFF' && <TokenPanel message={error} />}

      {status !== 'OFF' && (
        <>
          <section className="stat-row" aria-label="History summary">
            <MetricCard label="Signals stored" value={signals.length} hint={symbol || timeframe || outcome ? 'matching the filters' : 'all time'} />
            <MetricCard
              label="Resolved"
              value={resolved.length}
              hint={`${signals.length - resolved.length} still forming or undecided`}
            />
            <MetricCard
              label="EMA held"
              value={resolved.length ? `${formatNumber((held / resolved.length) * 100, 1)}%` : '—'}
              hint={`${held} bounced / ${resolved.length - held} crossed`}
              accent={resolved.length > 0 && held / resolved.length > 0.5}
            />
            <MetricCard
              label="Ichimoku confluent"
              value={confluent}
              hint={signals.length ? `of ${signals.length} stored` : 'none stored yet'}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Stored signals</h2>
                <span className="panel-sub">Newest first, by the bar the touch happened on.</span>
              </div>
              <div className="filter-row">
                <select className="input" aria-label="Filter by pair" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  <option value="">All pairs</option>
                  {PAIRS.map((p) => (
                    <option key={p.symbol}>{p.symbol}</option>
                  ))}
                </select>
                <select className="input" aria-label="Filter by timeframe" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                  <option value="">All timeframes</option>
                  {TIMEFRAMES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <select className="input" aria-label="Filter by result" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">Any result</option>
                  {OUTCOMES.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                <button className="btn btn-ghost" onClick={reload} disabled={status === 'LOADING'}>
                  Refresh
                </button>
              </div>
            </div>

            {status === 'LOADING' && (
              <div className="panel-body">
                <MarketStatus status="LOADING" />
              </div>
            )}
            {status === 'ERROR' && (
              <div className="banner danger" role="alert">
                <div className="banner-body">
                  <strong>Could not read the history</strong>
                  {error}
                </div>
              </div>
            )}
            {status === 'READY' && (
              <SignalTable
                signals={signals}
                emptyHint="Nothing stored yet. Signals are written as the scanner finds them, once an ingest token is set."
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** Shown when the server has no database configured. */
function TokenPanel({ message }: { message: string | null }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Storage not configured</h2>
      </div>
      <div className="panel-body">
        <EmptyState icon="plug" title="No database connected" compact>
          {message ?? 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY on the server, then reload.'}
        </EmptyState>
      </div>
    </section>
  );
}

/**
 * Ingest token entry. Lives on the dashboard rather than here, because that is
 * where signals are produced and where you notice they are not being saved.
 */
export function IngestTokenField() {
  const token = useIngestToken();
  const [draft, setDraft] = useState(token);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button className="inline-link" onClick={() => { setDraft(token); setOpen(true); }}>
        {token ? 'Change ingest token' : 'Set ingest token'}
      </button>
    );
  }
  return (
    <form
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        ingestStore.set(draft);
        setOpen(false);
      }}
    >
      <input
        className="input"
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="INGEST_TOKEN"
        aria-label="Ingest token"
        autoFocus
      />
      <button className="btn btn-primary" type="submit">Save</button>
      <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/**
 * Signal history — every trade the scanner has produced, and what happened to it.
 *
 * The table is deliberately about OUTCOMES rather than observations. The old
 * page listed EMA touches and whether price bounced; that could never answer
 * whether the signals were any good. Each row here is a trade with a result
 * and an R multiple, and a row can be expanded to see exactly why the engine
 * took it.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { PAIRS } from '../config/pairs';
import { TIMEFRAMES } from '../config/timeframes';
import { useSignalHistory } from '../hooks/useSignalStorage';
import { RESULT_LABEL, isClosed, type StoredSignal } from '../services/signals/signalHistory';

const RESULTS = ['pending', 'tp1', 'tp2', 'tp3', 'sl', 'be', 'expired'] as const;

const fmt = (v: number | null, symbol: string): string => {
  if (v === null) return '—';
  return v.toFixed(symbol.toUpperCase().endsWith('/JPY') ? 3 : 5);
};

const timeLabel = (barTime: number): string => {
  const d = new Date(barTime * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Colour a result by what it means for the account, not by its name. */
function resultTone(result: StoredSignal['result']): string {
  if (result === 'tp1' || result === 'tp2' || result === 'tp3') return 'ok';
  if (result === 'sl') return 'danger';
  if (result === 'be') return 'neutral';
  return 'muted';
}

export function History() {
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [result, setResult] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filters = useMemo(
    () => ({ symbol: symbol || undefined, timeframe: timeframe || undefined, result: result || undefined, limit: 500 }),
    [symbol, timeframe, result],
  );
  const { status, signals, error, reload } = useSignalHistory(filters);

  const closed = signals.filter(isClosed);
  const open = signals.filter((s) => s.result === 'pending');
  const wins = closed.filter((s) => (s.rMultiple ?? 0) > 0).length;
  const decided = closed.filter((s) => s.result !== 'be').length;
  const totalR = closed.reduce((sum, s) => sum + (s.rMultiple ?? 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Signal history</h1>
          <p>
            Every trade the scanner has produced, with its outcome. See{' '}
            <Link to="/performance">Performance</Link> for the breakdown by regime and strength.
          </p>
        </div>
      </div>

      <section className="stat-row">
        <MetricCard label="Signals" value={signals.length} hint={`${open.length} still open`} />
        <MetricCard label="Closed" value={closed.length} hint="resolved by price" />
        <MetricCard
          label="Win rate"
          value={decided === 0 ? '—' : `${((wins / decided) * 100).toFixed(0)}%`}
          hint={decided === 0 ? 'no decided trades yet' : `${wins} of ${decided} decided`}
          accent={decided > 0 && wins / decided > 0.5}
        />
        <MetricCard
          label="Total R"
          value={closed.length === 0 ? '—' : `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R`}
          hint={closed.length === 0 ? 'nothing closed yet' : `${(totalR / closed.length).toFixed(2)}R average`}
          accent={totalR > 0}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Trades</h2>
            <span className="panel-sub">Newest first, by the bar the setup confirmed on.</span>
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
            <select className="input" aria-label="Filter by result" value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Any result</option>
              {RESULTS.map((r) => (
                <option key={r} value={r}>
                  {RESULT_LABEL[r]}
                </option>
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

        {status === 'OFF' && (
          <div className="panel-body empty">
            <strong>Signal storage is not configured.</strong>
            <p>
              Set <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_KEY</code> on the server, then point a cron
              service at <code>/api/scanner</code> so signals start being recorded.
            </p>
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

        {status === 'READY' && signals.length === 0 && (
          <div className="panel-body empty">
            <strong>No signals yet.</strong>
            <p>
              The scanner records a signal only when a setup CONFIRMS — a pullback into the EMA50/Kijun zone with a
              closed bar rejecting it, inside a trending regime. That is meant to be rare.
            </p>
          </div>
        )}

        {status === 'READY' && signals.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Pair</th>
                  <th>TF</th>
                  <th>Signal</th>
                  <th>Conf</th>
                  <th>Regime</th>
                  <th className="num">Entry</th>
                  <th className="num">Stop</th>
                  <th>Result</th>
                  <th className="num">R</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <Row key={s.id} signal={s} expanded={expanded === s.id} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ signal: s, expanded, onToggle }: { signal: StoredSignal; expanded: boolean; onToggle: () => void }) {
  const long = s.direction === 'long';
  return (
    <>
      <tr>
        <td className="mono">{timeLabel(s.barTime)}</td>
        <td className="strong">{s.symbol}</td>
        <td>
          <span className="chip">{s.timeframe}</span>
        </td>
        <td>
          <span className={`tag ${long ? 'tag-long' : 'tag-short'}`}>
            {long ? '▲' : '▼'} {s.signal.replace('_', ' ')}
          </span>
        </td>
        <td className="num mono">{s.confidence}</td>
        <td className="muted small">{s.marketCondition.replace('TRENDING_', '').toLowerCase()}</td>
        <td className="num mono">{fmt(s.entry, s.symbol)}</td>
        <td className="num mono">{fmt(s.stopLoss, s.symbol)}</td>
        <td>
          <span className={`badge badge-${resultTone(s.result)}`}>{RESULT_LABEL[s.result]}</span>
        </td>
        <td className={`num mono ${(s.rMultiple ?? 0) > 0 ? 'pos' : (s.rMultiple ?? 0) < 0 ? 'neg' : ''}`}>
          {s.rMultiple === null ? '—' : `${s.rMultiple > 0 ? '+' : ''}${s.rMultiple.toFixed(2)}`}
        </td>
        <td>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Why?'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={11}>
            <div className="detail-grid">
              <div>
                <h4>Why this signal</h4>
                {s.reasons.length === 0 ? (
                  <p className="muted">No reasons recorded.</p>
                ) : (
                  <ul className="reason-list">
                    {s.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>What reduced confidence</h4>
                {s.warnings.length === 0 ? (
                  <p className="muted">Nothing flagged.</p>
                ) : (
                  <ul className="reason-list warn">
                    {s.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>Ticket</h4>
                <dl className="kv">
                  <dt>Entry</dt>
                  <dd className="mono">{fmt(s.entry, s.symbol)}</dd>
                  <dt>Stop</dt>
                  <dd className="mono">
                    {fmt(s.stopLoss, s.symbol)} {s.stopPips === null ? '' : `(${s.stopPips.toFixed(0)} pips)`}
                  </dd>
                  <dt>TP1 / TP2 / TP3</dt>
                  <dd className="mono">
                    {fmt(s.takeProfit1, s.symbol)} · {fmt(s.takeProfit2, s.symbol)} · {fmt(s.takeProfit3, s.symbol)}
                  </dd>
                  {s.tp1Hit && (
                    <>
                      <dt>TP1</dt>
                      <dd>hit — stop moved to entry</dd>
                    </>
                  )}
                  {s.closedPrice !== null && (
                    <>
                      <dt>Closed at</dt>
                      <dd className="mono">{fmt(s.closedPrice, s.symbol)}</dd>
                    </>
                  )}
                </dl>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

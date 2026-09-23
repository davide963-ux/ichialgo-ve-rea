/**
 * Results — everything that happened, and whether it was any good.
 *
 * WHY ONE PAGE INSTEAD OF THREE
 * ─────────────────────────────
 * This replaces History, Performance and Equity Curve. They were three nav
 * items computing overlapping views of one dataset: win rate and trade count
 * appeared on all three, profit factor and drawdown on two, and History
 * hand-rolled its own arithmetic while Performance used `computeMetrics` — so
 * the same trades could print two different win rates on adjacent pages.
 * Equity Curve was worse: a Phase-1 mockup wired to nothing, showing hardcoded
 * $0.00 forever in a navbar slot that looked like a real page.
 *
 * One dataset, one page, one set of numbers, computed once.
 *
 * THE ORDER IS THE ARGUMENT
 * ─────────────────────────
 * Plain verdict → money → the curve → the numbers → every trade → the
 * breakdowns, folded away. A reader who stops after the first line still has
 * the answer. The old Performance page opened with Average R and Profit
 * factor, which is a quiz, not an answer.
 *
 * MONEY IS DERIVED, NOT STORED
 * ────────────────────────────
 * R multiples are what the database records, because a 40-pip win on USD/JPY
 * and a 12-pip win on EUR/CHF are not comparable in pips. Money is computed
 * here from a balance and risk percentage the reader controls, as a FIXED
 * fraction of the starting balance rather than compounded — the conservative
 * reading, and one that can be stated in a single line.
 */
import { useMemo, useState } from 'react';
import { EquityCurve, type EquityPoint } from '../components/EquityCurve';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { PAIRS } from '../config/pairs';
import { TIMEFRAMES } from '../config/timeframes';
import { useSignalHistory, usePerformance } from '../hooks/useSignalStorage';
import { MIN_RELIABLE_TRADES, type Group } from '../services/strategy';
import { RESULT_LABEL, isClosed, type StoredSignal } from '../services/signals/signalHistory';

const RESULTS = ['pending', 'tp', 'sl', 'expired'] as const;

const DEFAULT_BALANCE = 10_000;
const DEFAULT_RISK_PCT = 1;

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(0)}%`);
const r = (v: number | null, digits = 2): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}R`);

/** Profit factor, in words where a symbol would not help. */
const pf = (v: number | null): string => (v === null ? '—' : v === Infinity ? 'no losses' : v.toFixed(2));

const money = (v: number): string =>
  `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;

const price = (v: number | null, symbol: string): string =>
  v === null ? '—' : v.toFixed(symbol.toUpperCase().endsWith('/JPY') ? 3 : 5);

const timeLabel = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Colour a result by what it means for the account, not by its name. */
function resultTone(result: StoredSignal['result']): string {
  if (result === 'tp') return 'ok';
  if (result === 'sl') return 'danger';
  return 'muted';
}

export function Results() {
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [result, setResult] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [balance, setBalance] = useState(String(DEFAULT_BALANCE));
  const [riskPct, setRiskPct] = useState(String(DEFAULT_RISK_PCT));

  const filters = useMemo(
    () => ({ symbol: symbol || undefined, timeframe: timeframe || undefined, result: result || undefined, limit: 1000 }),
    [symbol, timeframe, result],
  );
  const { status, signals, error, reload } = useSignalHistory(filters);
  const report = usePerformance(signals);
  const { overall } = report;

  const startingBalance = Number(balance) > 0 ? Number(balance) : DEFAULT_BALANCE;
  const risk = Number(riskPct) > 0 ? Number(riskPct) : DEFAULT_RISK_PCT;
  const riskPerTrade = (startingBalance * risk) / 100;

  // Oldest first, by the time each trade CLOSED — the order the account
  // actually experienced. Sorting by entry would draw a curve whose drawdown
  // never happened in that sequence.
  const closedTrades = useMemo(
    () => signals.filter(isClosed).sort((a, b) => (a.closedAt ?? a.barTime) - (b.closedAt ?? b.barTime)),
    [signals],
  );

  const curve = useMemo<EquityPoint[]>(() => {
    let running = startingBalance;
    return closedTrades.map((t, i) => {
      running += (t.rMultiple ?? 0) * riskPerTrade;
      return {
        n: i + 1,
        balance: running,
        r: t.rMultiple ?? 0,
        label: `${t.direction === 'long' ? 'Long' : 'Short'} ${t.symbol} · ${RESULT_LABEL[t.result]}`,
      };
    });
  }, [closedTrades, riskPerTrade, startingBalance]);

  const netMoney = overall.totalR * riskPerTrade;
  const returnPct = (netMoney / startingBalance) * 100;
  const openCount = signals.length - overall.closed;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Results</h1>
          <p>Every trade the scanner has produced, and what it added up to.</p>
        </div>
        <div className="filter-row">
          <button className="btn btn-ghost" onClick={reload} disabled={status === 'LOADING'}>
            Refresh
          </button>
        </div>
      </div>

      {status === 'LOADING' && <MarketStatus status="LOADING" />}

      {status === 'OFF' && (
        <section className="panel">
          <div className="panel-body empty">
            <strong>Signal storage is not configured.</strong>
            <p>
              Set <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_KEY</code> and <code>SCANNER_TOKEN</code>, then
              point a cron service at <code>/api/scanner</code>.
            </p>
          </div>
        </section>
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
        <section className="panel">
          <div className="panel-body empty">
            <strong>No signals recorded yet.</strong>
            <p>
              The scanner is running but nothing has been scored. Once a strategy is configured and a setup confirms,
              trades appear here with their outcomes.
            </p>
          </div>
        </section>
      )}

      {status === 'READY' && signals.length > 0 && (
        <>
          {/* ── The answer, in one sentence ─────────────────────────────── */}
          <div className={`verdict ${netMoney > 0 ? 'pos' : netMoney < 0 ? 'neg' : ''}`}>
            <div className="verdict-line">
              <strong>{overall.closed}</strong> trade{overall.closed === 1 ? '' : 's'} finished.{' '}
              <strong>{overall.wins}</strong> won, <strong>{overall.losses}</strong> lost
              {overall.breakeven > 0 && <>, {overall.breakeven} broke even</>}.
            </div>
            <div className="verdict-money">{overall.closed === 0 ? '—' : money(netMoney)}</div>
            <div className="verdict-sub">
              on a ${startingBalance.toLocaleString()} account risking {risk}% (${Math.round(riskPerTrade)}) per trade
              {overall.closed > 0 && (
                <>
                  {' — '}
                  <strong>
                    {returnPct > 0 ? '+' : ''}
                    {returnPct.toFixed(1)}%
                  </strong>
                </>
              )}
              .
            </div>
            {openCount > 0 && (
              <div className="verdict-note">
                {openCount} trade{openCount === 1 ? ' is' : 's are'} still open and not counted — an open position
                cannot flatter the numbers by staying open.
              </div>
            )}
            <div className="filter-row" style={{ marginTop: 12 }}>
              <label className="field-inline">
                Account
                <input
                  className="input input-sm"
                  inputMode="decimal"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  aria-label="Starting balance"
                />
              </label>
              <label className="field-inline">
                Risk %
                <input
                  className="input input-sm"
                  inputMode="decimal"
                  value={riskPct}
                  onChange={(e) => setRiskPct(e.target.value)}
                  aria-label="Risk percent per trade"
                />
              </label>
            </div>
          </div>

          {/* ── The shape of it ─────────────────────────────────────────── */}
          {curve.length > 1 && (
            <section className="chart-block">
              <h3 className="panel-title">Account balance, trade by trade</h3>
              <EquityCurve points={curve} startingBalance={startingBalance} />
            </section>
          )}

          {/* ── The numbers, with plain labels ──────────────────────────── */}
          <section className="stat-row">
            <MetricCard
              label="Won"
              value={pct(overall.winRatePct)}
              hint={`${overall.wins} of ${overall.wins + overall.losses} trades that had a winner or loser`}
              accent={(overall.winRatePct ?? 0) > 50}
            />
            <MetricCard
              label="Average trade"
              value={overall.closed === 0 ? '—' : money((overall.averageR ?? 0) * riskPerTrade)}
              hint={`${r(overall.averageR)} — what a typical trade made or lost`}
              accent={(overall.averageR ?? 0) > 0}
            />
            <MetricCard
              label="Worst dip"
              value={overall.closed === 0 ? '—' : money(-overall.maxDrawdownR * riskPerTrade)}
              hint="how far below the peak the account fell before recovering"
            />
            <MetricCard
              label="Won vs lost"
              value={pf(overall.profitFactor)}
              hint={
                overall.profitFactor === Infinity
                  ? 'nothing has been lost yet'
                  : 'money made ÷ money lost. Above 1 means the winners paid for the losers'
              }
              accent={(overall.profitFactor ?? 0) > 1}
            />
          </section>

          {overall.closed > 0 && !overall.reliable && (
            <div className="banner" role="note">
              <div className="banner-body">
                <strong>Too few trades to draw a conclusion.</strong>
                {overall.closed} finished trade{overall.closed === 1 ? '' : 's'} is below the {MIN_RELIABLE_TRADES}{' '}
                this page treats as a minimum. Treat it as a sanity check, not evidence.
              </div>
            </div>
          )}

          {/* ── Every trade ─────────────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Every trade</h2>
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
                  {RESULTS.map((res) => (
                    <option key={res} value={res}>
                      {RESULT_LABEL[res]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Opened</th>
                    <th>Pair</th>
                    <th>Direction</th>
                    <th className="num">Entry</th>
                    <th className="num">Stop</th>
                    <th>How it ended</th>
                    <th className="num">Result</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <Row
                      key={s.id}
                      signal={s}
                      riskPerTrade={riskPerTrade}
                      expanded={expanded === s.id}
                      onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Everything else, out of the way ─────────────────────────── */}
          {overall.closed > 0 && (
            <details className="advanced">
              <summary>Detailed breakdown</summary>
              <p className="panel-sub" style={{ marginTop: 10 }}>
                Results split by the conditions in force. <strong>R</strong> is the amount risked on one trade, so
                +2R means the trade made twice what it risked.
              </p>
              <Breakdown
                title="By market conditions"
                note="If these rows look the same, the regime filter is not earning its place."
                groups={report.byRegimeFamily}
                riskPerTrade={riskPerTrade}
              />
              <Breakdown
                title="By signal grade"
                note="Strong should beat Standard. If it does not, the extra conditions are noise."
                groups={report.bySignalStrength}
                riskPerTrade={riskPerTrade}
              />
              <Breakdown
                title="By timeframe"
                note="Where the edge actually lives."
                groups={report.byTimeframe}
                riskPerTrade={riskPerTrade}
              />
              <Breakdown
                title="By pair"
                note="Thin samples per pair — read the counts before the percentages."
                groups={report.bySymbol}
                riskPerTrade={riskPerTrade}
              />
              <Breakdown
                title="Buys vs sells"
                note="A wide gap usually says more about the period than about the strategy."
                groups={report.byDirection}
                riskPerTrade={riskPerTrade}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  signal: s,
  riskPerTrade,
  expanded,
  onToggle,
}: {
  signal: StoredSignal;
  riskPerTrade: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const long = s.direction === 'long';
  const pnl = s.rMultiple === null ? null : s.rMultiple * riskPerTrade;

  return (
    <>
      <tr>
        <td className="mono">{timeLabel(s.barTime)}</td>
        <td className="strong">{s.symbol}</td>
        <td>
          <span className={`tag ${long ? 'tag-long' : 'tag-short'}`}>{long ? '▲ Buy' : '▼ Sell'}</span>
        </td>
        <td className="num mono">{price(s.entry, s.symbol)}</td>
        <td className="num mono">{price(s.stopLoss, s.symbol)}</td>
        <td>
          <span className={`badge badge-${resultTone(s.result)}`}>{RESULT_LABEL[s.result]}</span>
        </td>
        <td className={`num mono ${(pnl ?? 0) > 0 ? 'pos' : (pnl ?? 0) < 0 ? 'neg' : ''}`}>
          {pnl === null ? '—' : money(pnl)}
        </td>
        <td>
          <button className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Why?'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={8}>
            <div className="detail-grid">
              <div>
                <h4>Why this signal</h4>
                {s.reasons.length === 0 ? (
                  <p className="muted">No reasons recorded.</p>
                ) : (
                  <ul className="reason-list">
                    {s.reasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
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
                  <dt>Timeframe</dt>
                  <dd className="mono">{s.timeframe}</dd>
                  <dt>Confidence</dt>
                  <dd className="mono">{s.confidence}</dd>
                  <dt>Entry</dt>
                  <dd className="mono">{price(s.entry, s.symbol)}</dd>
                  <dt>Stop</dt>
                  <dd className="mono">
                    {price(s.stopLoss, s.symbol)} {s.stopPips === null ? '' : `(${s.stopPips.toFixed(0)} pips)`}
                  </dd>
                  <dt>Target</dt>
                  <dd className="mono">{price(s.takeProfit, s.symbol)}</dd>
                  {s.closedPrice !== null && (
                    <>
                      <dt>Closed at</dt>
                      <dd className="mono">{price(s.closedPrice, s.symbol)}</dd>
                    </>
                  )}
                  {s.rMultiple !== null && (
                    <>
                      <dt>Result</dt>
                      <dd className="mono">{r(s.rMultiple)}</dd>
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

function Breakdown({
  title,
  note,
  groups,
  riskPerTrade,
}: {
  title: string;
  note: string;
  groups: Group[];
  riskPerTrade: number;
}) {
  const measurable = groups.filter((g) => g.closed > 0);
  if (measurable.length === 0) return null;

  return (
    <>
      <h4 className="breakdown-title">{title}</h4>
      <p className="panel-sub">{note}</p>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{title.replace('By ', '')}</th>
              <th className="num">Trades</th>
              <th className="num">Won</th>
              <th className="num">Net</th>
              <th className="num">Avg</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {measurable.map((g) => (
              <tr key={g.key} className={g.reliable ? '' : 'row-dim'}>
                <td className="strong">{label(g.key)}</td>
                <td className="num mono">{g.closed}</td>
                <td className="num mono">{pct(g.winRatePct)}</td>
                <td className={`num mono ${g.totalR > 0 ? 'pos' : g.totalR < 0 ? 'neg' : ''}`}>
                  {money(g.totalR * riskPerTrade)}
                </td>
                <td className="num mono muted">{r(g.averageR)}</td>
                <td>{!g.reliable && <span className="badge badge-muted">few trades</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Turn a raw enum key into something readable, leaving pairs alone. */
function label(key: string): string {
  if (key.includes('/')) return key;
  if (key === key.toUpperCase() && key.includes('_')) {
    return key
      .toLowerCase()
      .split('_')
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' ');
  }
  return key;
}

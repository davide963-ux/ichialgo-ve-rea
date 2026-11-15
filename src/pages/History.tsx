/**
 * Signal history — what the scanner recorded while nobody was watching.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE DASHBOARD
 * ────────────────────────────────────────────
 * The dashboard shows what the strategy says about the candles on screen. It
 * is recomputed on every load, so it has no memory: close the tab and the
 * evening's signals are gone. This page shows rows a server-side scanner
 * wrote at the time, including overnight and at the weekend.
 *
 * WHY THE TOTALS ARE PER PAIR AND NEVER MERGED
 * ────────────────────────────────────────────
 * The same reason the backtest flags a mixed selection: a USD/JPY pip is 0.01
 * and a EUR/USD pip is 0.0001, so one overall "net pips" figure would be a
 * sum of unlike things. The database groups by symbol and this page shows it
 * that way — there is deliberately no grand total to misread.
 *
 * WHY 'NO FILL' IS SHOWN RATHER THAN HIDDEN
 * ─────────────────────────────────────────
 * Entry is a resting limit at the EMA and the touch band is wider than the
 * line, so plenty of touches never trade there. Those are not wins, losses,
 * or missing data — they are the strategy declining to trade, and the
 * backtest counts them the same way. Hiding them would make the scanner look
 * far busier than the strategy actually is.
 */
import { useMemo, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { EMA50_TOUCH, ICHIMOKU_CONFLUENCE } from '../config/strategy';
import { useSignalHistory, type StoredSignal } from '../hooks/useSignalHistory';
import { formatNumber } from '../lib/format';
import { ICHIMOKU_CHECKS } from '../services/strategy';

const ROWS = 80;

const pips = (v: number | null, digits = 1) =>
  v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

const stamp = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** How a result reads, and which colour it gets. */
const RESULT: Record<StoredSignal['result'], { label: string; tone: string; hint: string }> = {
  open: { label: 'OPEN', tone: '', hint: 'price has not reached the stop or the target yet' },
  tp: { label: 'TP', tone: 'pos', hint: 'closed at the target' },
  sl: { label: 'SL', tone: 'neg', hint: 'closed at the stop' },
  nofill: { label: 'NO FILL', tone: 'muted', hint: 'the bar never traded at the EMA, so no position was taken' },
  expired: { label: 'EXPIRED', tone: 'muted', hint: 'aged out before price decided' },
};

export function History() {
  const { status, configured, signals, stats, error, reload } = useSignalHistory();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const symbols = useMemo(() => [...new Set(stats.map((s) => s.symbol))].sort(), [stats]);
  const filtered = useMemo(
    () => (symbol ? signals.filter((s) => s.symbol === symbol) : signals),
    [signals, symbol],
  );
  const shown = showAll ? filtered : filtered.slice(0, ROWS);

  const totals = useMemo(
    () =>
      stats.reduce(
        (a, s) => ({
          total: a.total + s.total,
          open: a.open + s.open,
          closed: a.closed + s.tp + s.sl,
          nofill: a.nofill + s.nofill,
          wins: a.wins + s.tp,
        }),
        { total: 0, open: 0, closed: 0, nofill: 0, wins: 0 },
      ),
    [stats],
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Signal history</h1>
          <p className="page-sub">
            Every EMA{EMA50_TOUCH.period} touch the scanner recorded, with the ticket it implied and what price did
            next. Written by the server on a schedule, so it keeps running when this page is closed.
          </p>
        </div>
        {status === 'READY' && configured && (
          <button className="btn btn-ghost" onClick={reload}>
            Refresh
          </button>
        )}
      </div>

      {status === 'LOADING' && (
        <section className="panel">
          <p className="panel-body muted">Loading the history…</p>
        </section>
      )}

      {status === 'ERROR' && <div className="banner error">Could not load the history: {error}</div>}

      {status === 'READY' && !configured && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">No database attached yet</h2>
              <span className="panel-sub">
                The scanner and the API are deployed; they just have nowhere to write. Three steps:
              </span>
            </div>
          </div>
          <ol className="panel-body msg-list">
            <li>
              In the Vercel dashboard, open <strong>Storage → Create Database → Neon</strong> and attach it to this
              project. Vercel adds <code>DATABASE_URL</code> to the environment itself.
            </li>
            <li>
              Create the tables: <code>npm run migrate</code> with that <code>DATABASE_URL</code> in your environment.
            </li>
            <li>
              Add a <code>SCANNER_TOKEN</code> to both the Vercel project and the repository&rsquo;s GitHub Actions
              secrets, so the scheduled workflow is allowed to trigger a scan.
            </li>
          </ol>
        </section>
      )}

      {status === 'READY' && configured && signals.length === 0 && (
        <section className="panel">
          <div className="panel-body">
            <p className="muted">
              The database is connected but empty. The scanner writes a row the first time it runs after a bar closes —
              run the <strong>scan</strong> workflow by hand from the repository&rsquo;s Actions tab if you do not want
              to wait for the schedule.
            </p>
          </div>
        </section>
      )}

      {status === 'READY' && configured && signals.length > 0 && (
        <>
          <section className="metric-strip" aria-label="History summary">
            <MetricCard label="Recorded" value={totals.total} hint="touches the scanner has stored" />
            <MetricCard label="Traded" value={totals.closed + totals.open} hint={`${totals.nofill} never filled`} />
            <MetricCard label="Still open" value={totals.open} hint="waiting on price" />
            <MetricCard
              label="Resolved"
              value={totals.closed}
              hint={totals.closed > 0 ? `${((totals.wins / totals.closed) * 100).toFixed(1)}% hit target` : 'none yet'}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">By pair</h2>
                <span className="panel-sub">
                  Net pips is per pair and never summed: a JPY pip and a EUR/USD pip are different amounts of money, so
                  one overall total would be a sum of unlike things. Figures exclude spread.
                </span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>PAIR</th>
                    <th className="num">RECORDED</th>
                    <th className="num">NO FILL</th>
                    <th className="num">OPEN</th>
                    <th className="num">TP</th>
                    <th className="num">SL</th>
                    <th className="num">AVG STOP</th>
                    <th className="num">NET PIPS</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.symbol}>
                      <td>{s.symbol}</td>
                      <td className="num muted">{s.total}</td>
                      <td className="num muted">{s.nofill}</td>
                      <td className="num">{s.open}</td>
                      <td className="num pos">{s.tp}</td>
                      <td className="num neg">{s.sl}</td>
                      <td className="num muted">
                        {s.avg_stop_pips === null ? '—' : s.avg_stop_pips.toFixed(1)}
                      </td>
                      <td
                        className={`num ${(s.net_pips ?? 0) > 0 ? 'pos' : (s.net_pips ?? 0) < 0 ? 'neg' : 'muted'}`}
                      >
                        {pips(s.net_pips, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Every signal</h2>
                <span className="panel-sub">Newest first, by the bar that touched.</span>
              </div>
              {filtered.length > ROWS && (
                <button className="btn btn-ghost" onClick={() => setShowAll((s) => !s)}>
                  {showAll ? `Show first ${ROWS}` : `Show all ${filtered.length}`}
                </button>
              )}
            </div>

            <div className="panel-body backtest-controls">
              <fieldset className="control-group">
                <legend>Pair</legend>
                <div className="chip-row">
                  <label className={`chip${symbol === null ? ' on' : ''}`}>
                    <input type="radio" name="hsym" checked={symbol === null} onChange={() => setSymbol(null)} />
                    all
                  </label>
                  {symbols.map((s) => (
                    <label key={s} className={`chip${symbol === s ? ' on' : ''}`}>
                      <input type="radio" name="hsym" checked={symbol === s} onChange={() => setSymbol(s)} />
                      {s}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>BAR</th>
                    <th>PAIR</th>
                    <th>SIDE</th>
                    <th className="num">ENTRY</th>
                    <th className="num">STOP</th>
                    <th className="num">TARGET</th>
                    <th className="num">ICHI</th>
                    <th>RESULT</th>
                    <th className="num">STOP PIPS</th>
                    <th className="num">PIPS</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    const r = RESULT[s.result] ?? RESULT.open;
                    return (
                      <tr key={s.id}>
                        <td className="muted">{stamp(s.bar_time)}</td>
                        <td>{s.symbol}</td>
                        <td>
                          {s.direction && (
                            <span className={`tag ${s.direction === 'LONG' ? 'pos' : 'neg'}`}>{s.direction}</span>
                          )}
                          {s.counter_trend && (
                            <span className="tag warn" title="Against the EMA trend">
                              COUNTER
                            </span>
                          )}
                        </td>
                        <td className="num">{s.entry === null ? '—' : formatNumber(s.entry, 5)}</td>
                        <td className="num muted">{s.stop_loss === null ? '—' : formatNumber(s.stop_loss, 5)}</td>
                        <td className="num muted">{s.take_profit === null ? '—' : formatNumber(s.take_profit, 5)}</td>
                        <td className="num muted">
                          {s.ichimoku_score === null ? '—' : `${s.ichimoku_score}/${ICHIMOKU_CHECKS}`}
                        </td>
                        <td>
                          <span className={`tag ${r.tone}`} title={r.hint}>
                            {r.label}
                          </span>
                        </td>
                        <td className="num muted">{s.stop_pips === null ? '—' : s.stop_pips.toFixed(1)}</td>
                        <td
                          className={`num ${(s.result_pips ?? 0) > 0 ? 'pos' : (s.result_pips ?? 0) < 0 ? 'neg' : 'muted'}`}
                        >
                          {pips(s.result_pips)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">How to read this</h2>
              </div>
            </div>
            <ul className="panel-body msg-list">
              <li>
                <strong>These totals are not the backtest&rsquo;s totals, and should not be compared to them.</strong>{' '}
                The backtest simulates an account: one position at a time, so a touch arriving while a trade is already
                running is skipped. This page records <em>every</em> signal the strategy produced, including
                overlapping ones, because its job is to be a complete record you can filter afterwards rather than a
                tradeable sequence. Taking every signal needs more margin than taking one at a time, and the two
                answer different questions.
              </li>
              <li>
                <strong>Pips exclude spread.</strong> The backtest charges one pip by default because it is asking
                whether the strategy would have made money; this page is recording what price did. Subtract your own
                spread before comparing the two.
              </li>
              <li>
                <strong>&ldquo;Expired&rdquo; means the record ran out, not that the trade did.</strong> Each run
                fetches a fixed window of recent candles. A trade still undecided when its entry bar scrolls out of
                that window can no longer be resolved from the data on hand, so it is retired rather than left open
                for ever. No pip figure is recorded, because none was observed.
              </li>
              <li>
                <strong>No fill is a real outcome.</strong> Entry is a resting limit at the EMA, and the touch band is
                wider than the line, so a bar can touch without ever trading there. Those rows are the strategy
                declining to trade, not missing data.
              </li>
              <li>
                <strong>Every signal is recorded, not just the good ones.</strong> The live dashboard applies the{' '}
                {ICHIMOKU_CONFLUENCE.agreeThreshold}/{ICHIMOKU_CHECKS} Ichimoku default; the scanner stores the
                Ichimoku score and leaves the filtering to you, so the history can answer what a different threshold
                would have done.
              </li>
              <li>
                <strong>A gap in the dates is a gap in the scanner, not in the market.</strong> The schedule runs on
                GitHub Actions, which disables a workflow after 60 days without a commit — the Actions tab is the first
                place to look.
              </li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

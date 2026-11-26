/**
 * Backtest — what the Ichimoku system did on real candles.
 *
 * ONE SYSTEM, TWO ENTRIES
 * ───────────────────────
 * The breakout and the pullback are measured TOGETHER, because the article
 * describes them as parts of one system rather than as alternatives. They are
 * still reported apart — every trade records which entry opened it — so the
 * split can be read without being traded separately.
 *
 * An earlier version of this page offered three selectable strategies and ran
 * a contest between them. That measured the parts of the system against each
 * other instead of measuring the system.
 *
 * THE ORDER IS THE ARGUMENT
 * ─────────────────────────
 * Verdict first, in words, with its confidence interval. Then the curve, then
 * the numbers, then every trade. A reader who stops after the first line has
 * the answer, and the answer is allowed to be "nothing measurable" — which is
 * what the unfiltered rule actually says.
 *
 * WHY THE HEADLINE IS A SENTENCE AND NOT A NUMBER
 * ───────────────────────────────────────────────
 * "+0.5 pips per trade" reads as a small edge. "Indistinguishable from zero —
 * the interval spans it" is the same fact and the correct conclusion. This
 * project has already spent three rounds of tuning on the difference, so the
 * page states the conclusion and shows the number underneath it.
 *
 * COSTS ARE ON BY DEFAULT
 * ───────────────────────
 * One pip. The stop is about ten pips, so the spread is a tenth of the bet
 * given away on every trade — the commonest reason a backtest does not
 * survive contact with a broker. Showing the zero-cost number first would be
 * flattering the strategy by default.
 *
 * EVERY NUMBER IS IN PIPS, AND THE AVERAGE STOP IS SHOWN NEXT TO IT
 * ─────────────────────────────────────────────────────────────────
 * Pips are checkable against the chart, which is why they are here. But the
 * stop is a fraction of the 26-bar range, so trades risk different amounts
 * and the pip average is an average over unequal bets — and across JPY and
 * non-JPY pairs it adds two different pip values outright. Neither is hidden:
 * the average stop sits beside the average result, and
 * `portfolio.mixesPipValues` drives a note above the totals whenever the
 * selection spans both kinds of pair.
 *
 * THE CHIKOU CONTROL RE-RUNS THE RULE, IT DOES NOT FILTER THE OUTPUT
 * ─────────────────────────────────────────────────────────────────
 * The article attaches the Chikou filter explicitly to the breakout, while
 * describing the four approaches as working together. Applying it to the
 * pullback as well is the "work together" reading, and the control switches
 * between the two so the literal reading can be measured rather than argued
 * about. It re-runs the DETECTOR, because a filter applied to finished output
 * could only remove trades and never show the ones a looser rule would have
 * taken instead.
 */
import { useMemo, useState } from 'react';
import { EquityCurve, type EquityPoint } from '../components/EquityCurve';
import { MetricCard } from '../components/MetricCard';
import { ICHIMOKU } from '../config/ichimokuStrategy';
import { BARS_PER_FIXTURE, FIXTURE_PAIRS, UNTESTED_PAIRS, useBacktest } from '../hooks/useBacktest';
import { formatNumber } from '../lib/format';
import type { BacktestFilters, BacktestMetrics, EntryType } from '../services/strategy';

const DEFAULT_COST_PIPS = 1;
const TRADE_ROWS = 60;

/** Signed pips. The unit is in the column heading, so it is not repeated per cell. */
const p = (v: number | null, digits = 1) =>
  v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

/** Signed pips with the unit, for prose and for cards that stand alone. */
const pips = (v: number | null, digits = 1) => (v === null ? '—' : `${p(v, digits)} pips`);
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const pf = (v: number | null) => (v === null ? '—' : v === Infinity ? 'no losses' : v.toFixed(2));

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const stamp = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The verdict, in words. The interval decides it, not the average — which is
 * the whole point of computing an interval.
 */
function verdict(m: BacktestMetrics): { text: string; tone: 'pos' | 'neg' | 'muted' } {
  if (m.trades < 2) return { text: 'Not enough trades to say anything.', tone: 'muted' };
  if (!m.significant) {
    return {
      text: `No measurable edge. At ${pips(m.averagePips)} a trade the 95% interval runs ${p(m.ciLow)} to ${pips(m.ciHigh)} — it spans zero, so the sign is noise.`,
      tone: 'muted',
    };
  }
  return m.averagePips! > 0
    ? {
        text: `Profitable on this sample: ${pips(m.averagePips)} a trade, 95% interval ${p(m.ciLow)} to ${pips(m.ciHigh)} — clear of zero.`,
        tone: 'pos',
      }
    : {
        text: `Loses money on this sample: ${pips(m.averagePips)} a trade, 95% interval ${p(m.ciLow)} to ${pips(m.ciHigh)} — clear of zero.`,
        tone: 'neg',
      };
}

export function Backtest() {
  const [symbols, setSymbols] = useState<string[]>(FIXTURE_PAIRS.map((p) => p.symbol));
  const [chikouBoth, setChikouBoth] = useState(ICHIMOKU.chikouFiltersPullback);
  const [costPips, setCostPips] = useState(DEFAULT_COST_PIPS);
  const [showAll, setShowAll] = useState(false);

  const filters = useMemo<BacktestFilters>(
    () => ({ costPips, config: { ...ICHIMOKU, chikouFiltersPullback: chikouBoth } }),
    [chikouBoth, costPips],
  );
  const { status, error, results, portfolio, span } = useBacktest(symbols, filters);

  /** The two entries, reported apart without being run apart. */
  const byEntry = useMemo(() => {
    const out: Record<EntryType, { n: number; pips: number; wins: number }> = {
      breakout: { n: 0, pips: 0, wins: 0 },
      pullback: { n: 0, pips: 0, wins: 0 },
    };
    for (const t of portfolio?.trades ?? []) {
      if (t.pips === null) continue;
      const e = out[t.entryType];
      e.n += 1;
      e.pips += t.pips;
      if (t.pips > 0) e.wins += 1;
    }
    return out;
  }, [portfolio]);

  const metrics = portfolio?.metrics;
  const points = useMemo<EquityPoint[]>(() => {
    if (!portfolio) return [];
    let n = 0;
    let cum = 0;
    return portfolio.trades
      .filter((t) => t.pips !== null)
      .map((t) => {
        n += 1;
        cum += t.pips!;
        return { n, cumPips: cum, pips: t.pips!, label: `${t.symbol} ${t.direction}` };
      });
  }, [portfolio]);

  const toggle = (symbol: string) =>
    setSymbols((prev) => (prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]));

  const totals = results.reduce(
    (acc, res) => ({
      signals: acc.signals + res.signals,
      skipped: acc.skipped + res.skippedWhileOpen,
      filtered: acc.filtered + res.filtered,
    }),
    { signals: 0, skipped: 0, filtered: 0 },
  );

  const shown = portfolio ? (showAll ? portfolio.trades : portfolio.trades.slice(0, TRADE_ROWS)) : [];
  const v = metrics ? verdict(metrics) : null;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p className="page-sub">
            OANDA's Ichimoku system replayed over real OANDA candles — a Kumo breakout and a Tenkan/Kijun pullback,
            both validated by Chikou, entry at the signal bar's close, stop beyond the structure the entry relied
            on, target {ICHIMOKU.rewardMultiple}× the risk.
            {span && ` ${day(span.from)} – ${day(span.to)}, 1H.`}
          </p>
        </div>
      </div>

      {status === 'ERROR' && <div className="banner error">Could not load the market fixtures: {error}</div>}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Settings</h2>
            <span className="panel-sub">
              Same detector and same ticket levels the live page uses — there is no backtest-only version of the
              rules.
            </span>
          </div>
        </div>
        <div className="panel-body backtest-controls">
          <fieldset className="control-group">
            <legend>Pairs</legend>
            <div className="chip-row">
              {FIXTURE_PAIRS.map((p) => (
                <label key={p.symbol} className={`chip${symbols.includes(p.symbol) ? ' on' : ''}`}>
                  <input type="checkbox" checked={symbols.includes(p.symbol)} onChange={() => toggle(p.symbol)} />
                  {p.symbol}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="control-group">
            <legend>Chikou filter</legend>
            <div className="chip-row">
              {[
                [true, 'both entries'],
                [false, 'breakout only'],
              ].map(([v, label]) => (
                <label key={String(v)} className={`chip${chikouBoth === v ? ' on' : ''}`}>
                  <input type="radio" name="chikou" checked={chikouBoth === v} onChange={() => setChikouBoth(v as boolean)} />
                  {label as string}
                </label>
              ))}
            </div>
            <span className="panel-sub">
              The article attaches it to the breakout and says the four approaches work together. "Both" is the
              work-together reading; "breakout only" is the literal one. This re-runs the detector, so the looser
              setting really does produce the extra signals.
            </span>
          </fieldset>

          <fieldset className="control-group">
            <legend>Cost per trade</legend>
            <div className="chip-row">
              {[0, 0.5, 1, 2, 3].map((n) => (
                <label key={n} className={`chip${costPips === n ? ' on' : ''}`}>
                  <input type="radio" name="cost" checked={costPips === n} onChange={() => setCostPips(n)} />
                  {n === 0 ? 'none' : `${n} pip${n === 1 ? '' : 's'}`}
                </label>
              ))}
            </div>
            <span className="panel-sub">
              Spread, taken straight off the result. The stop averages around ten pips, so each pip of spread is
              roughly a tenth of the bet.
            </span>
          </fieldset>

        </div>
      </section>

      {status === 'LOADING' && (
        <section className="panel">
          {/* Counted, not written down: a hardcoded total is exactly what
              went stale when a pair's fixture was deleted. */}
          <p className="panel-body muted">
            Loading {formatNumber(FIXTURE_PAIRS.length * BARS_PER_FIXTURE, 0)} candles…
          </p>
        </section>
      )}

      {metrics && v && (
        <>
          <section className="panel">
            <div className="panel-body">
              <p className={`verdict ${v.tone}`}>{v.text}</p>
              <p className="panel-sub">
                {metrics.trades} trades from {totals.signals} signals — {totals.filtered} filtered out and{' '}
                {totals.skipped} skipped because a position was already open. Entry is the signal bar's close, so
                every trade taken filled. Win rate {pct(metrics.winRatePct)} against the{' '}
                {pct(metrics.breakEvenWinRatePct)} this payoff needs to break even.
              </p>
            </div>
          </section>

          {portfolio?.mixesPipValues && (
            <p className="panel-sub backtest-unit-note">
              <strong>These totals add JPY and non-JPY pips together.</strong> A USD/JPY pip is 0.01 and a EUR/USD pip
              is 0.0001 — different amounts of money, and JPY pairs usually travel further in pips for the same risk.
              Read the by-pair table below for figures that are in one unit, or deselect one group of pairs above.
            </p>
          )}

          <section className="metric-strip" aria-label="Backtest summary">
            <MetricCard label="Trades" value={metrics.trades} hint={`${metrics.wins}W / ${metrics.losses}L`} />
            <MetricCard
              label="Average"
              value={pips(metrics.averagePips, 2)}
              hint={`95% CI ${p(metrics.ciLow, 2)} … ${p(metrics.ciHigh, 2)}`}
              accent={metrics.significant && (metrics.averagePips ?? 0) > 0}
            />
            {/* The denominator of the line above it: a result is only good or
                bad relative to what was risked to get it. */}
            <MetricCard
              label="Average stop"
              value={metrics.averageStopPips === null ? '—' : `${metrics.averageStopPips.toFixed(1)} pips`}
              hint="what each trade risked"
            />
            <MetricCard label="Total" value={pips(metrics.totalPips, 0)} hint="sum of every closed trade" />
            <MetricCard label="Profit factor" value={pf(metrics.profitFactor)} hint="gross won ÷ gross lost" />
            <MetricCard label="Max drawdown" value={pips(-metrics.maxDrawdownPips, 0)} hint="deepest fall from a peak" />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Equity curve</h2>
                <span className="panel-sub">
                  Cumulative pips, trade by trade, pairs merged and ordered by exit. In pips rather than money, so
                  the shape does not depend on a balance or a risk-per-trade choice.
                </span>
              </div>
            </div>
            <div className="panel-body">
              {points.length > 1 ? <EquityCurve points={points} /> : <p className="muted">Not enough closed trades to draw a curve.</p>}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">By entry</h2>
                <span className="panel-sub">
                  The two halves of the system, reported apart without being traded apart. A breakout bets a trend
                  is starting and stops beyond the whole cloud; a pullback bets one is resuming and stops beyond
                  Kijun. Different bets, different risk, and worth seeing separately.
                </span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ENTRY</th>
                    <th className="num">TRADES</th>
                    <th className="num">WIN</th>
                    <th className="num">AVG PIPS</th>
                    <th className="num">TOTAL PIPS</th>
                  </tr>
                </thead>
                <tbody>
                  {(['breakout', 'pullback'] as const).map((k) => {
                    const e = byEntry[k];
                    const avg = e.n > 0 ? e.pips / e.n : null;
                    return (
                      <tr key={k}>
                        <td>{k === 'breakout' ? 'Kumo breakout' : 'Tenkan/Kijun pullback'}</td>
                        <td className="num">{e.n}</td>
                        <td className="num">{e.n > 0 ? pct((e.wins / e.n) * 100) : '—'}</td>
                        <td className={`num ${(avg ?? 0) > 0 ? 'pos' : (avg ?? 0) < 0 ? 'neg' : ''}`}>
                          {p(avg, 2)}
                        </td>
                        <td className={`num ${e.pips > 0 ? 'pos' : e.pips < 0 ? 'neg' : ''}`}>{p(e.pips, 0)}</td>
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
                <h2 className="panel-title">By pair</h2>
                <span className="panel-sub">
                  A strategy that only works on one pair has found that pair's last nine months, not an edge.
                </span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>PAIR</th>
                    <th className="num">SIGNALS</th>
                    <th className="num">SKIPPED</th>
                    <th className="num">TRADES</th>
                    <th className="num">WIN</th>
                    <th className="num">AVG PIPS</th>
                    <th className="num">AVG STOP</th>
                    <th className="num">TOTAL PIPS</th>
                    <th className="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((res) => (
                    <tr key={res.symbol}>
                      <td>{res.symbol}</td>
                      <td className="num muted">{res.signals}</td>
                      <td className="num muted">{res.skippedWhileOpen}</td>
                      <td className="num">{res.metrics.trades}</td>
                      <td className="num">{pct(res.metrics.winRatePct)}</td>
                      <td className={`num ${(res.metrics.averagePips ?? 0) > 0 ? 'pos' : (res.metrics.averagePips ?? 0) < 0 ? 'neg' : ''}`}>
                        {p(res.metrics.averagePips, 2)}
                      </td>
                      <td className="num muted">
                        {res.metrics.averageStopPips === null ? '—' : res.metrics.averageStopPips.toFixed(1)}
                      </td>
                      <td className={`num ${res.metrics.totalPips > 0 ? 'pos' : res.metrics.totalPips < 0 ? 'neg' : ''}`}>
                        {p(res.metrics.totalPips, 0)}
                      </td>
                      <td className="num muted">{pf(res.metrics.profitFactor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Every trade</h2>
                <span className="panel-sub">Oldest first, by the time the trade closed.</span>
              </div>
              {portfolio && portfolio.trades.length > TRADE_ROWS && (
                <button className="btn btn-ghost" onClick={() => setShowAll((s) => !s)}>
                  {showAll ? `Show first ${TRADE_ROWS}` : `Show all ${portfolio.trades.length}`}
                </button>
              )}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ENTERED</th>
                    <th>PAIR</th>
                    <th>SIDE</th>
                    <th className="num">ENTRY</th>
                    <th className="num">STOP</th>
                    <th className="num">TARGET</th>
                    <th>ENTRY</th>
                    <th className="num">SCORE</th>
                    <th className="num">BARS</th>
                    <th>EXIT</th>
                    <th className="num">STOP PIPS</th>
                    <th className="num">PIPS</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id}>
                      <td className="muted">{stamp(t.entryTime)}</td>
                      <td>{t.symbol}</td>
                      <td>
                        <span className={`tag ${t.direction === 'LONG' ? 'pos' : 'neg'}`}>{t.direction}</span>
                      </td>
                      <td className="num">{formatNumber(t.entry, 5)}</td>
                      <td className="num muted">{formatNumber(t.stop, 5)}</td>
                      <td className="num muted">{formatNumber(t.target, 5)}</td>
                      <td className="muted">{t.entryType === 'breakout' ? 'BREAK' : 'PULLBACK'}</td>
                      <td className="num muted">{t.score}/{t.checksTotal}</td>
                      <td className="num muted">{t.exit === 'open' ? '—' : t.barsHeld}</td>
                      <td>
                        <span className={`tag ${t.exit === 'tp' ? 'pos' : t.exit === 'sl' ? 'neg' : ''}`}>
                          {t.exit === 'open' ? 'STILL OPEN' : t.exit.toUpperCase()}
                        </span>
                      </td>
                      <td className="num muted">{t.stopPips.toFixed(1)}</td>
                      <td className={`num ${(t.pips ?? 0) > 0 ? 'pos' : (t.pips ?? 0) < 0 ? 'neg' : 'muted'}`}>
                        {p(t.pips)}
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
                <h2 className="panel-title">What this does not prove</h2>
              </div>
            </div>
            <ul className="panel-body msg-list">
              {UNTESTED_PAIRS.length > 0 && (
                <li>
                  <strong>It does not cover every pair you trade.</strong> {UNTESTED_PAIRS.join(' and ')}{' '}
                  {UNTESTED_PAIRS.length === 1 ? 'is scanned' : 'are scanned'} live but {UNTESTED_PAIRS.length === 1 ? 'has' : 'have'}{' '}
                  no checked-in candles, so nothing here says anything about{' '}
                  {UNTESTED_PAIRS.length === 1 ? 'it' : 'them'}. These numbers describe{' '}
                  {FIXTURE_PAIRS.length} of the {FIXTURE_PAIRS.length + UNTESTED_PAIRS.length} pairs on the scanner.
                </li>
              )}
              <li>
                <strong>One period.</strong> {span && `${day(span.from)} – ${day(span.to)}`} is about nine months. A
                rule can fit nine months of one regime and fail the next.
              </li>
              <li>
                <strong>The pairs are correlated.</strong> EUR/USD, GBP/USD and AUD/USD are largely the same dollar
                trade, so {metrics.trades} trades are worth fewer than {metrics.trades} independent observations — the
                interval above is narrower than it should be.
              </li>
              <li>
                <strong>It is all in-sample.</strong> Every setting on this page was chosen after seeing these candles.
                Trying filters until one looks good is how noise gets promoted to a strategy.
              </li>
              <li>
                <strong>Costs are a flat estimate.</strong> Real spreads widen at the open, on news and overnight,
                exactly when Kijun tends to get retested. Swap on positions held overnight is not modelled at all.
              </li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

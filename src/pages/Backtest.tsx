/**
 * Backtest — what the EMA50 touch strategy did on real candles.
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
 * "+0.05R per trade" reads as a small edge. "Indistinguishable from zero —
 * the interval spans it" is the same fact and the correct conclusion. This
 * project has already spent three rounds of tuning on the difference, so the
 * page states the conclusion and shows the number underneath it.
 *
 * COSTS ARE ON BY DEFAULT
 * ───────────────────────
 * One pip, charged against the risk. The stop is about ten pips, so the
 * spread is a tenth of R on every trade — the commonest reason a backtest
 * does not survive contact with a broker. Showing the zero-cost number first
 * would be flattering the strategy by default.
 */
import { useMemo, useState } from 'react';
import { EquityCurve, type EquityPoint } from '../components/EquityCurve';
import { MetricCard } from '../components/MetricCard';
import { EMA50_TOUCH, ICHIMOKU_CONFLUENCE, TRADE_PLAN } from '../config/strategy';
import { FIXTURE_PAIRS, useBacktest } from '../hooks/useBacktest';
import { formatNumber } from '../lib/format';
import { ICHIMOKU_CHECKS, type BacktestFilters, type BacktestMetrics } from '../services/strategy';

const DEFAULT_COST_PIPS = 1;
const TRADE_ROWS = 60;

const r = (v: number | null, digits = 2) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}R`);
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
      text: `No measurable edge. At ${r(m.averageR)} a trade the 95% interval runs ${r(m.ciLow)} to ${r(m.ciHigh)} — it spans zero, so the sign is noise.`,
      tone: 'muted',
    };
  }
  return m.averageR! > 0
    ? {
        text: `Profitable on this sample: ${r(m.averageR)} a trade, 95% interval ${r(m.ciLow)} to ${r(m.ciHigh)} — clear of zero.`,
        tone: 'pos',
      }
    : {
        text: `Loses money on this sample: ${r(m.averageR)} a trade, 95% interval ${r(m.ciLow)} to ${r(m.ciHigh)} — clear of zero.`,
        tone: 'neg',
      };
}

export function Backtest() {
  const [symbols, setSymbols] = useState<string[]>(FIXTURE_PAIRS.map((p) => p.symbol));
  const [minIchimoku, setMinIchimoku] = useState(0);
  const [skipCounterTrend, setSkipCounterTrend] = useState(false);
  const [costPips, setCostPips] = useState(DEFAULT_COST_PIPS);
  const [showAll, setShowAll] = useState(false);

  const filters = useMemo<BacktestFilters>(
    () => ({ minIchimoku, skipCounterTrend, costPips }),
    [minIchimoku, skipCounterTrend, costPips],
  );
  const { status, error, results, portfolio, span } = useBacktest(symbols, filters);

  const metrics = portfolio?.metrics;
  const points = useMemo<EquityPoint[]>(() => {
    if (!portfolio) return [];
    let n = 0;
    let cum = 0;
    return portfolio.trades
      .filter((t) => t.rMultiple !== null)
      .map((t) => {
        n += 1;
        cum += t.rMultiple!;
        return { n, cumR: cum, r: t.rMultiple!, label: `${t.symbol} ${t.direction}` };
      });
  }, [portfolio]);

  const toggle = (symbol: string) =>
    setSymbols((prev) => (prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]));

  const totals = results.reduce(
    (acc, res) => ({ touches: acc.touches + res.touches, noFill: acc.noFill + res.noFill, filtered: acc.filtered + res.filtered }),
    { touches: 0, noFill: 0, filtered: 0 },
  );

  const shown = portfolio ? (showAll ? portfolio.trades : portfolio.trades.slice(0, TRADE_ROWS)) : [];
  const v = metrics ? verdict(metrics) : null;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p className="page-sub">
            The EMA{EMA50_TOUCH.period} touch strategy replayed over real OANDA candles — entry at the EMA, stop{' '}
            {TRADE_PLAN.stopAtrMultiple}× ATR beyond it, target {TRADE_PLAN.rewardMultiple}R.
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
              Same detector and same ticket levels the live page uses — there is no backtest-only version of the rules.
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
            <legend>Ichimoku agreement</legend>
            <div className="chip-row">
              {[0, 2, 3, 4, 5].map((n) => (
                <label key={n} className={`chip${minIchimoku === n ? ' on' : ''}`}>
                  <input type="radio" name="ichi" checked={minIchimoku === n} onChange={() => setMinIchimoku(n)} />
                  {n === 0 ? 'any' : `≥ ${n}/${ICHIMOKU_CHECKS}`}
                </label>
              ))}
            </div>
            <span className="panel-sub">Live default is {ICHIMOKU_CONFLUENCE.agreeThreshold}/{ICHIMOKU_CHECKS}.</span>
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
              Spread, charged against the risk. The stop is ~10 pips, so a pip is ~0.1R off every trade.
            </span>
          </fieldset>

          <fieldset className="control-group">
            <legend>Direction</legend>
            <label className="overlay-toggle">
              <input type="checkbox" checked={skipCounterTrend} onChange={(e) => setSkipCounterTrend(e.target.checked)} />
              Skip touches against the EMA trend
            </label>
          </fieldset>
        </div>
      </section>

      {status === 'LOADING' && (
        <section className="panel">
          <p className="panel-body muted">Loading 30,000 candles…</p>
        </section>
      )}

      {metrics && v && (
        <>
          <section className="panel">
            <div className="panel-body">
              <p className={`verdict ${v.tone}`}>{v.text}</p>
              <p className="panel-sub">
                {metrics.trades} trades from {totals.touches} touches — {totals.filtered} filtered out,{' '}
                {totals.noFill} never reached the entry, and a touch arriving while a position was already open is
                skipped. Win rate {pct(metrics.winRatePct)} against the {pct(metrics.breakEvenWinRatePct)} this payoff
                needs to break even.
              </p>
            </div>
          </section>

          <section className="metric-strip" aria-label="Backtest summary">
            <MetricCard label="Trades" value={metrics.trades} hint={`${metrics.wins}W / ${metrics.losses}L`} />
            <MetricCard
              label="Average"
              value={r(metrics.averageR)}
              hint={`95% CI ${r(metrics.ciLow)} … ${r(metrics.ciHigh)}`}
              accent={metrics.significant && (metrics.averageR ?? 0) > 0}
            />
            <MetricCard label="Total" value={r(metrics.totalR, 1)} hint="sum of every closed trade" />
            <MetricCard label="Profit factor" value={pf(metrics.profitFactor)} hint="gross won ÷ gross lost" />
            <MetricCard label="Max drawdown" value={r(-metrics.maxDrawdownR, 1)} hint="deepest fall from a peak" />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Equity curve</h2>
                <span className="panel-sub">
                  Cumulative R, trade by trade, pairs merged and ordered by exit. In R rather than money, so the shape
                  does not depend on a position-sizing choice.
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
                    <th className="num">TOUCHES</th>
                    <th className="num">NO FILL</th>
                    <th className="num">TRADES</th>
                    <th className="num">WIN</th>
                    <th className="num">AVERAGE</th>
                    <th className="num">TOTAL</th>
                    <th className="num">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((res) => (
                    <tr key={res.symbol}>
                      <td>{res.symbol}</td>
                      <td className="num muted">{res.touches}</td>
                      <td className="num muted">{res.noFill}</td>
                      <td className="num">{res.metrics.trades}</td>
                      <td className="num">{pct(res.metrics.winRatePct)}</td>
                      <td className={`num ${(res.metrics.averageR ?? 0) > 0 ? 'pos' : (res.metrics.averageR ?? 0) < 0 ? 'neg' : ''}`}>
                        {r(res.metrics.averageR)}
                      </td>
                      <td className={`num ${res.metrics.totalR > 0 ? 'pos' : res.metrics.totalR < 0 ? 'neg' : ''}`}>
                        {r(res.metrics.totalR, 1)}
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
                    <th className="num">ICHI</th>
                    <th className="num">BARS</th>
                    <th>EXIT</th>
                    <th className="num">R</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id}>
                      <td className="muted">{stamp(t.entryTime)}</td>
                      <td>{t.symbol}</td>
                      <td>
                        <span className={`tag ${t.direction === 'LONG' ? 'pos' : 'neg'}`}>{t.direction}</span>
                        {t.counterTrend && <span className="tag warn" title="Against the EMA trend">COUNTER</span>}
                      </td>
                      <td className="num">{formatNumber(t.entry, 5)}</td>
                      <td className="num muted">{formatNumber(t.stop, 5)}</td>
                      <td className="num muted">{formatNumber(t.target, 5)}</td>
                      <td className="num muted">{t.ichimokuScore === null ? '—' : `${t.ichimokuScore}/${ICHIMOKU_CHECKS}`}</td>
                      <td className="num muted">{t.exit === 'open' ? '—' : t.barsHeld}</td>
                      <td>
                        <span className={`tag ${t.exit === 'tp' ? 'pos' : t.exit === 'sl' ? 'neg' : ''}`}>
                          {t.exit === 'open' ? 'STILL OPEN' : t.exit.toUpperCase()}
                        </span>
                      </td>
                      <td className={`num ${(t.rMultiple ?? 0) > 0 ? 'pos' : (t.rMultiple ?? 0) < 0 ? 'neg' : 'muted'}`}>
                        {t.rMultiple === null ? '—' : r(t.rMultiple)}
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
                exactly when the EMA tends to get touched. Swap on positions held overnight is not modelled at all.
              </li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

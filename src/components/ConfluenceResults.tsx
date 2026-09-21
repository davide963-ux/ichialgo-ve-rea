/**
 * Confluence backtest results.
 *
 * Reported in R, and broken down the way the spec asks: by regime, by signal
 * strength, by direction. Those breakdowns are the point — a single headline
 * number tells you nothing about WHERE an edge lives, and a strategy that
 * makes all its money in one regime is a different proposition from one that
 * works everywhere.
 *
 * The page refuses to call anything profitable. It reports what happened over
 * the range requested and says plainly when the sample is too small to mean
 * anything, because a backtest over a few dozen in-sample trades is a
 * hypothesis, not a result.
 */
import { MIN_RELIABLE_TRADES, type Group } from '../services/strategy/performance';
import type { ConfluenceBacktestResult, ConfluenceTrade } from '../services/strategy/confluenceBacktest';
import { MetricCard } from './MetricCard';

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(0)}%`);
const r = (v: number | null, digits = 2): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}R`);
const pf = (v: number | null): string => (v === null ? '—' : v === Infinity ? '∞' : v.toFixed(2));

const EXIT_LABEL: Record<ConfluenceTrade['exit'], string> = {
  tp1: 'TP1',
  tp2: 'TP2',
  tp3: 'TP3',
  sl: 'Stopped',
  be: 'Breakeven',
  open: 'Still open',
};

export function ConfluenceResults({ result }: { result: ConfluenceBacktestResult }) {
  const { overall } = result.report;
  const price = (v: number) => v.toFixed(result.symbol.toUpperCase().endsWith('/JPY') ? 3 : 5);

  if (result.trades.length === 0) {
    return (
      <div className="empty">
        <strong>No setup confirmed over this range.</strong>
        <p>
          {result.note} The engine analysed {result.barsAnalysed} bars. A confirmed setup needs a trending regime, a
          pullback into the EMA50/Kijun zone, and a closed bar rejecting it — all at once.
        </p>
      </div>
    );
  }

  return (
    <>
      <section className="stat-row">
        <MetricCard
          label="Trades"
          value={result.trades.length}
          hint={`${overall.closed} closed · ${result.barsAnalysed} bars analysed`}
        />
        <MetricCard label="Win rate" value={pct(overall.winRatePct)} hint={`${overall.wins}W / ${overall.losses}L / ${overall.breakeven}BE`} accent={(overall.winRatePct ?? 0) > 50} />
        <MetricCard label="Average R" value={r(overall.averageR)} hint="per closed trade" accent={(overall.averageR ?? 0) > 0} />
        <MetricCard label="Total R" value={r(overall.totalR, 1)} hint="sum of every closed trade" accent={overall.totalR > 0} />
        <MetricCard label="Profit factor" value={pf(overall.profitFactor)} hint="above 1 pays" accent={(overall.profitFactor ?? 0) > 1} />
        <MetricCard label="Max drawdown" value={r(-overall.maxDrawdownR, 1)} hint="deepest fall of the R curve" />
      </section>

      {!overall.reliable && (
        <div className="banner" role="note">
          <div className="banner-body">
            <strong>Too few trades to conclude anything.</strong>
            {overall.closed} closed trade{overall.closed === 1 ? '' : 's'} is below the {MIN_RELIABLE_TRADES} this page
            treats as a floor, and this is in-sample besides. Widen the range or test other pairs before reading a
            result into it.
          </div>
        </div>
      )}

      {result.skippedWhileInTrade > 0 && (
        <p className="panel-sub">
          {result.skippedWhileInTrade} further setup{result.skippedWhileInTrade === 1 ? '' : 's'} confirmed while a
          position was already open and were skipped — one position per pair, as live.
        </p>
      )}

      <Breakdown title="By market regime" groups={result.report.byRegimeFamily} />
      <Breakdown title="By signal strength" groups={result.report.bySignalStrength} />
      <Breakdown title="Long vs short" groups={result.report.byDirection} />

      <h3 className="panel-title" style={{ marginTop: 18 }}>
        Trades
      </h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Entry</th>
              <th>Dir</th>
              <th>Signal</th>
              <th className="num">Conf</th>
              <th>Regime</th>
              <th className="num">Price</th>
              <th className="num">Stop</th>
              <th>Exit</th>
              <th className="num">Bars</th>
              <th className="num">R</th>
            </tr>
          </thead>
          <tbody>
            {result.trades.map((t) => (
              <tr key={t.id}>
                <td className="mono">{new Date(t.entryTime * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
                <td>
                  <span className={`tag ${t.direction === 'long' ? 'tag-long' : 'tag-short'}`}>
                    {t.direction === 'long' ? '▲' : '▼'}
                  </span>
                </td>
                <td className="small">{t.signal.replace('_', ' ')}</td>
                <td className="num mono">{t.confidence}</td>
                <td className="muted small">{t.marketCondition.replace('TRENDING_', '').toLowerCase()}</td>
                <td className="num mono">{price(t.entry)}</td>
                <td className="num mono">{price(t.initialStop)}</td>
                <td>
                  <span className={`badge badge-${t.exit === 'sl' ? 'danger' : t.exit === 'open' ? 'muted' : t.exit === 'be' ? 'neutral' : 'ok'}`}>
                    {EXIT_LABEL[t.exit]}
                  </span>
                </td>
                <td className="num mono">{t.barsHeld}</td>
                <td className={`num mono ${(t.rMultiple ?? 0) > 0 ? 'pos' : (t.rMultiple ?? 0) < 0 ? 'neg' : ''}`}>
                  {t.rMultiple === null ? '—' : `${t.rMultiple > 0 ? '+' : ''}${t.rMultiple.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Breakdown({ title, groups }: { title: string; groups: Group[] }) {
  const measurable = groups.filter((g) => g.closed > 0);
  if (measurable.length === 0) return null;

  return (
    <>
      <h3 className="panel-title" style={{ marginTop: 18 }}>
        {title}
      </h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{title.replace('By ', '')}</th>
              <th className="num">Trades</th>
              <th className="num">Win rate</th>
              <th className="num">Avg R</th>
              <th className="num">Total R</th>
              <th className="num">Profit factor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {measurable.map((g) => (
              <tr key={g.key} className={g.reliable ? '' : 'row-dim'}>
                <td className="strong">{g.key}</td>
                <td className="num mono">{g.closed}</td>
                <td className="num mono">{pct(g.winRatePct)}</td>
                <td className={`num mono ${(g.averageR ?? 0) > 0 ? 'pos' : 'neg'}`}>{r(g.averageR)}</td>
                <td className={`num mono ${g.totalR > 0 ? 'pos' : g.totalR < 0 ? 'neg' : ''}`}>{r(g.totalR, 1)}</td>
                <td className="num mono">{pf(g.profitFactor)}</td>
                <td>{!g.reliable && <span className="badge badge-muted">small sample</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

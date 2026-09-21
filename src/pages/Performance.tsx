/**
 * Performance — does this edge actually pay?
 *
 * Everything is in R, multiples of the risk taken, because that is the only
 * unit in which a USD/JPY trade and a EUR/CHF trade are comparable. Money
 * would smuggle position size into a question about the strategy.
 *
 * The breakdown by market condition is the point of the page. The strategy's
 * whole premise is that a pullback into confluence works in a trend and not in
 * chop; if the ranging bucket performs as well as the trending one, the regime
 * filter is not earning its place and should be questioned rather than trusted.
 *
 * Small samples are labelled, not hidden. A 100% win rate over three trades is
 * noise, and a page that presents it as a headline teaches you to trust noise.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { useSignalHistory, usePerformance } from '../hooks/useSignalStorage';
import { MIN_RELIABLE_TRADES, type Group } from '../services/strategy/performance';

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(0)}%`);
const r = (v: number | null, digits = 2): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}R`);
const pf = (v: number | null): string => (v === null ? '—' : v === Infinity ? '∞' : v.toFixed(2));

export function PerformancePage() {
  const [timeframe, setTimeframe] = useState('');
  const filters = useMemo(() => ({ timeframe: timeframe || undefined, limit: 1000 }), [timeframe]);
  const { status, signals, error, reload } = useSignalHistory(filters);
  const report = usePerformance(signals);
  const { overall } = report;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Performance</h1>
          <p>
            Measured in R — multiples of the risk taken — so pairs and timeframes are comparable. Open trades are
            counted but never scored. <Link to="/history">See the trades</Link>.
          </p>
        </div>
        <div className="filter-row">
          <select className="input" aria-label="Filter by timeframe" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            <option value="">All timeframes</option>
            {report.byTimeframe.map((g) => (
              <option key={g.key}>{g.key}</option>
            ))}
          </select>
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

      {status === 'READY' && (
        <>
          <section className="stat-row">
            <MetricCard
              label="Closed trades"
              value={overall.closed}
              hint={overall.reliable ? 'enough to read' : `under ${MIN_RELIABLE_TRADES} — treat as noise`}
            />
            <MetricCard
              label="Win rate"
              value={pct(overall.winRatePct)}
              hint={`${overall.wins}W / ${overall.losses}L / ${overall.breakeven}BE`}
              accent={(overall.winRatePct ?? 0) > 50}
            />
            <MetricCard
              label="Average R"
              value={r(overall.averageR)}
              hint="per closed trade — the headline number"
              accent={(overall.averageR ?? 0) > 0}
            />
            <MetricCard
              label="Profit factor"
              value={pf(overall.profitFactor)}
              hint="gross won ÷ gross lost; above 1 pays"
              accent={(overall.profitFactor ?? 0) > 1}
            />
            <MetricCard
              label="Max drawdown"
              value={r(-overall.maxDrawdownR)}
              hint="deepest fall of the R curve"
            />
          </section>

          {overall.closed === 0 && (
            <section className="panel">
              <div className="panel-body empty">
                <strong>Nothing has closed yet.</strong>
                <p>
                  {signals.length === 0
                    ? 'The scanner has not recorded any signals. Check that the cron is hitting /api/scanner.'
                    : `${signals.length} signal${signals.length === 1 ? '' : 's'} recorded, all still open. Statistics appear once trades resolve.`}
                </p>
              </div>
            </section>
          )}

          {overall.closed > 0 && (
            <>
              <Breakdown
                title="By market regime"
                subtitle="The strategy's core claim: pullbacks pay in a trend and not in chop. If these read the same, the regime filter is not earning its place."
                groups={report.byRegimeFamily}
              />
              <Breakdown
                title="By signal strength"
                subtitle="Strong means all seven conditions aligned. It should outperform Standard — if it does not, the extra conditions are noise."
                groups={report.bySignalStrength}
              />
              <Breakdown title="By timeframe" subtitle="Where the edge actually lives." groups={report.byTimeframe} />
              <Breakdown
                title="Long vs short"
                subtitle="A large gap usually means a directional bias in the sample, not in the strategy."
                groups={report.byDirection}
              />
              <Breakdown title="By pair" subtitle="Thin samples per pair — read the counts." groups={report.bySymbol} />
              <Breakdown
                title="By market condition (detail)"
                subtitle="The full seven-way classification behind the regime split above."
                groups={report.byMarketCondition}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Breakdown({ title, subtitle, groups }: { title: string; subtitle: string; groups: Group[] }) {
  const measurable = groups.filter((g) => g.closed > 0);
  if (measurable.length === 0) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          <span className="panel-sub">{subtitle}</span>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{title.replace('By ', '').replace(' (detail)', '')}</th>
              <th className="num">Trades</th>
              <th className="num">Win rate</th>
              <th className="num">Avg R</th>
              <th className="num">Total R</th>
              <th className="num">Profit factor</th>
              <th className="num">Max DD</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {measurable.map((g) => (
              <GroupRow key={g.key} group={g} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GroupRow({ group: g }: { group: Group }) {
  const positive = (g.averageR ?? 0) > 0;
  return (
    <tr className={g.reliable ? '' : 'row-dim'}>
      <td className="strong">{label(g.key)}</td>
      <td className="num mono">{g.closed}</td>
      <td className="num mono">{pct(g.winRatePct)}</td>
      <td className={`num mono ${positive ? 'pos' : 'neg'}`}>{r(g.averageR)}</td>
      <td className={`num mono ${g.totalR > 0 ? 'pos' : g.totalR < 0 ? 'neg' : ''}`}>{r(g.totalR, 1)}</td>
      <td className="num mono">{pf(g.profitFactor)}</td>
      <td className="num mono">{r(-g.maxDrawdownR, 1)}</td>
      <td>
        {!g.reliable && (
          <span className="badge badge-muted" title={`Fewer than ${MIN_RELIABLE_TRADES} closed trades`}>
            small sample
          </span>
        )}
      </td>
    </tr>
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


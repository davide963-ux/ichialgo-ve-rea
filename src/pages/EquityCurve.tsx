import { EmptyState } from '../components/EmptyState';
import { MetricCard } from '../components/MetricCard';
import { TradeTable } from '../components/TradeTable';

/**
 * Phase 1: structure only. No performance numbers are shown until the
 * strategy produces real trades — zero / empty values, never fake data.
 */
const STATS = [
  { label: 'Net profit', value: '$0.00' },
  { label: 'Total trades', value: '0' },
  { label: 'Win rate', value: '—' },
  { label: 'Profit factor', value: '—' },
  { label: 'Max drawdown', value: '0.00%' },
  { label: 'Average R', value: '—' },
];

export function EquityCurve() {
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Equity curve</h1>
          <p>Account growth and drawdown from Ichialgo signals.</p>
        </div>
      </div>

      <section className="panel">
        <EmptyState title="No trading data yet">
          Strategy and signal tracking will appear here once the Ichialgo strategy is connected.
        </EmptyState>
      </section>

      <section className="stat-row" aria-label="Performance statistics">
        {STATS.map((s) => (
          <MetricCard key={s.label} label={s.label} value={s.value} />
        ))}
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Equity</h2>
            <span className="panel-sub">Balance over time</span>
          </div>
          <div style={{ paddingTop: 18 }}>
            <div className="chart-empty"><span>No equity data</span></div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Drawdown</h2>
            <span className="panel-sub">Distance from equity peak</span>
          </div>
          <div style={{ paddingTop: 18 }}>
            <div className="chart-empty"><span>No drawdown data</span></div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Trade history</h2>
          <span className="panel-sub">0 trades</span>
        </div>
        <TradeTable trades={[]} />
      </section>
    </main>
  );
}

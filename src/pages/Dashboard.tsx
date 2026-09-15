import { useSearchParams } from 'react-router-dom';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ForexTable } from '../components/ForexTable';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { TimeframeSelector } from '../components/TimeframeSelector';
import { DEFAULT_TIMEFRAME, isTimeframe, type Timeframe } from '../config/timeframes';
import { useNow } from '../hooks/useNow';
import { formatAgo, formatClock } from '../lib/time';
import { useMarketStore } from '../state/marketStore';

/**
 * Strategy signals do not exist in Phase 1.
 * These will be read from the Signal Store once the StrategyEngine is connected.
 */
const SIGNALS = { active: 0, today: 0 } as const;

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const tfParam = params.get('tf');
  const timeframe: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TIMEFRAME;
  const setTimeframe = (tf: Timeframe) => setParams({ tf }, { replace: true });

  const symbols = useMarketStore((s) => s.symbols);
  const quoteCount = useMarketStore((s) => Object.keys(s.quotes).length);
  const lastUpdate = useMarketStore((s) => s.lastUpdate);
  const lastContact = useMarketStore((s) => s.lastContact);
  const mode = useMarketStore((s) => s.mode);
  const provider = useMarketStore((s) => s.provider.label);
  const now = useNow();

  const modeLabel = mode === 'stream' ? 'Streaming' : mode === 'poll' ? 'Polling' : 'Connecting';

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Market scanner</h1>
          <p>Live prices for the major pairs. Select a pair to open its chart.</p>
        </div>
        <div className="page-head-aside">
          <TimeframeSelector value={timeframe} onChange={setTimeframe} label="Scanner timeframe" />
          <span className="field-hint">Scanner timeframe, used for charts</span>
        </div>
      </div>

      <ConnectionBanner />

      <section className="metric-strip" aria-label="Scanner overview">
        <MetricCard label="Markets" value={symbols.length} hint={`${quoteCount} priced by ${provider}`} />
        <MetricCard label="Active signals" value={SIGNALS.active} hint="Strategy not connected" />
        <MetricCard label="Signals today" value={SIGNALS.today} hint="Strategy not connected" />
        <MetricCard label="Scanner status" value={<MarketStatus />} hint={`${modeLabel}, synced ${formatAgo(lastContact, now)}`} />
        <MetricCard
          label="Last market update"
          value={formatAgo(lastUpdate, now)}
          hint={lastUpdate ? `Last updated: ${formatClock(lastUpdate)}` : 'Waiting for first price'}
          accent={lastUpdate !== null && now - lastUpdate < 10_000}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Forex market</h2>
          <span className="panel-sub">Last updated: {formatAgo(lastContact, now)}</span>
        </div>
        <ForexTable timeframe={timeframe} />
      </section>
    </main>
  );
}

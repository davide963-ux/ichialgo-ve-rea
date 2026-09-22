/**
 * Market scanner — live prices, and an honest account of what the system is
 * doing with them.
 *
 * WHAT CHANGED AND WHY
 * ────────────────────
 * This page used to show "EMA50 touches" as trade ideas. Those came from a
 * retired engine that the 24/7 scanner never ran, so a pair could sit here
 * looking like a textbook setup while the scanner correctly ignored it — the
 * page advertised signals the system would never act on, with nothing saying
 * the two were different.
 *
 * So the rule now: this page shows PRICES, which are facts, and the SCANNER'S
 * OWN STATE, which is the truth about what is being recorded. It does not
 * render a second opinion from anywhere else. Signals are whatever the scanner
 * actually stored, never a parallel calculation done in the browser.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ForexTable } from '../components/ForexTable';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { ScannerStatus } from '../components/ScannerStatus';
import { TimeframeSelector } from '../components/TimeframeSelector';
import { DEFAULT_TIMEFRAME, isTimeframe, type Timeframe } from '../config/timeframes';
import { useNow } from '../hooks/useNow';
import { formatAgo, formatClock } from '../lib/time';
import { useMarketStore } from '../state/marketStore';

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
        <MetricCard label="Connection" value={<MarketStatus />} hint={`${modeLabel}, synced ${formatAgo(lastContact, now)}`} />
        <MetricCard
          label="Last market update"
          value={formatAgo(lastUpdate, now)}
          hint={lastUpdate ? `Last updated: ${formatClock(lastUpdate)}` : 'Waiting for first price'}
          accent={lastUpdate !== null && now - lastUpdate < 10_000}
        />
      </section>

      {/* The one place that says whether signals are being produced at all.
          Stated plainly here rather than left to be inferred from an empty
          table, which is exactly how the old page misled. */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Signals</h2>
            <span className="panel-sub">What the 24/7 scanner is recording.</span>
          </div>
          <ScannerStatus />
        </div>
        <div className="panel-body empty">
          <strong>Signals are recorded by the 24/7 scanner, not by this page.</strong>
          <p>
            Every 15 minutes it reads 4H context, 1H structure and 15M entry timing across all pairs, scores the
            confluence, and records the setups that confirm. See <Link to="/results">Results</Link> for what it has
            produced.
          </p>
        </div>
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

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ForexTable } from '../components/ForexTable';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { SignalTable } from '../components/SignalTable';
import { TimeframeSelector } from '../components/TimeframeSelector';
import { EMA50_TOUCH, ICHIMOKU_CONFLUENCE } from '../config/strategy';
import { DEFAULT_TIMEFRAME, isTimeframe, type Timeframe } from '../config/timeframes';
import { useLastScanAt, useSignals, useSignalSummary, useStrategyStatus } from '../hooks/useSignals';
import { ICHIMOKU_CHECKS } from '../services/strategy';
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
  const signals = useSignals();
  const summary = useSignalSummary();
  const strategyStatus = useStrategyStatus();
  const lastScanAt = useLastScanAt();
  const [confluentOnly, setConfluentOnly] = useState(false);
  const now = useNow();

  // Filtering, not hiding: the toggle is off by default so a weak setup is
  // still visible and can be judged rather than silently dropped.
  const shown = useMemo(
    () => (confluentOnly ? signals.filter((s) => s.ichimoku?.agrees) : signals),
    [signals, confluentOnly],
  );
  const confluentCount = useMemo(() => signals.filter((s) => s.ichimoku?.agrees).length, [signals]);

  const modeLabel = mode === 'stream' ? 'Streaming' : mode === 'poll' ? 'Polling' : 'Connecting';
  const strategyHint =
    strategyStatus === 'READY'
      ? `EMA${EMA50_TOUCH.period} touch on ${timeframe}`
      : strategyStatus === 'ERROR'
        ? 'Strategy has no candles'
        : 'Loading candles…';

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
        <MetricCard
          label="At the EMA now"
          value={summary.active}
          hint={strategyStatus === 'READY' ? `Pairs inside the EMA${EMA50_TOUCH.period} band` : strategyHint}
          accent={summary.active > 0}
        />
        <MetricCard label="Touches today" value={summary.today} hint={strategyHint} />
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

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">EMA{EMA50_TOUCH.period} touches</h2>
            <span className="panel-sub">
              Fires when price reaches the EMA{EMA50_TOUCH.period} on the {timeframe} chart, within a
              volatility-scaled band. One signal per approach, not per bar.
            </span>
          </div>
          <div className="page-head-aside">
            <label className="overlay-toggle">
              <input type="checkbox" checked={confluentOnly} onChange={(e) => setConfluentOnly(e.target.checked)} />
              Ichimoku confluent only
            </label>
            <span className="panel-sub">
              {confluentCount} of {signals.length} confluent · scanned {formatAgo(lastScanAt, now)}
            </span>
          </div>
        </div>
        <SignalTable
          signals={shown}
          limit={25}
          emptyHint={
            confluentOnly && signals.length > 0
              ? `None of the ${signals.length} touches reach ${ICHIMOKU_CONFLUENCE.agreeThreshold}/${ICHIMOKU_CHECKS} Ichimoku agreement. Untick the filter to see them all.`
              : strategyStatus === 'READY'
                ? `Watching ${symbols.length} pairs on ${timeframe}. Nothing has reached its EMA${EMA50_TOUCH.period} yet.`
                : strategyHint
          }
        />
      </section>
    </main>
  );
}

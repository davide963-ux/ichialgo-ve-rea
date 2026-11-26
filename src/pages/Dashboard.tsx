/**
 * Market scanner — live prices, and where each pair sits against its Kijun.
 *
 * The signals shown here are computed IN THE BROWSER from the candles the
 * charts already hold. An earlier version had a server-side scanner writing
 * its own opinion to a database while the page computed another, and the two
 * could disagree with nothing saying which was right. One source now.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ForexTable } from '../components/ForexTable';
import { MarketStatus } from '../components/MarketStatus';
import { MetricCard } from '../components/MetricCard';
import { SignalTable } from '../components/SignalTable';
import { TimeframeSelector } from '../components/TimeframeSelector';
import { DEFAULT_STRATEGY, DETECTORS, STRATEGY_IDS, isStrategyId } from '../services/strategy';
import { DEFAULT_TIMEFRAME, isTimeframe, type Timeframe } from '../config/timeframes';
import { useLastScanAt, useSignals, useSignalSummary, useStrategyStatus } from '../hooks/useSignals';
import { useNow } from '../hooks/useNow';
import { formatAgo, formatClock } from '../lib/time';
import { useMarketStore } from '../state/marketStore';

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const tfParam = params.get('tf');
  const timeframe: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TIMEFRAME;
  const sParam = params.get('s');
  const strategy = isStrategyId(sParam) ? sParam : DEFAULT_STRATEGY;
  const detector = DETECTORS[strategy];
  const setTimeframe = (tf: Timeframe) => setParams({ tf, s: strategy }, { replace: true });
  const setStrategy = (s: string) => setParams({ tf: timeframe, s }, { replace: true });

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
  const [side, setSide] = useState<'all' | 'LONG' | 'SHORT'>('all');
  const now = useNow();

  /**
   * Only a direction filter now, and there is a reason there is nothing else.
   *
   * This panel used to carry an "Ichimoku confluent only" toggle, because the
   * old strategy showed every touch and scored it afterwards. The score is
   * now the gate: a setup that does not reach it produces no signal at all,
   * so a filter for "the confluent ones" would always match everything and
   * tell the reader it had done something.
   */
  const shown = useMemo(() => (side === 'all' ? signals : signals.filter((s) => s.direction === side)), [signals, side]);
  const longs = useMemo(() => signals.filter((s) => s.direction === 'LONG').length, [signals]);

  const modeLabel = mode === 'stream' ? 'Streaming' : mode === 'poll' ? 'Polling' : 'Connecting';
  const strategyHint =
    strategyStatus === 'READY'
      ? `${detector.name} on ${timeframe}`
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
          label="In the zone now"
          value={summary.active}
          hint={strategyStatus === 'READY' ? 'Pairs in the Kijun band, clear of the cloud' : strategyHint}
          accent={summary.active > 0}
        />
        <MetricCard label="Signals today" value={summary.today} hint={strategyHint} />
        <MetricCard label="Connection" value={<MarketStatus />} hint={`${modeLabel}, synced ${formatAgo(lastContact, now)}`} />
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
            <h2 className="panel-title">{detector.name}</h2>
            <span className="panel-sub">
              {detector.blurb} Rules by {detector.source}. The cloud decides the direction; one signal per setup,
              not per bar.
            </span>
            <div className="chip-row">
              {STRATEGY_IDS.map((id) => (
                <label key={id} className={`chip${strategy === id ? ' on' : ''}`}>
                  <input type="radio" name="strategy" checked={strategy === id} onChange={() => setStrategy(id)} />
                  {DETECTORS[id].name}
                </label>
              ))}
            </div>
          </div>
          <div className="page-head-aside">
            <div className="chip-row">
              {(['all', 'LONG', 'SHORT'] as const).map((v) => (
                <label key={v} className={`chip${side === v ? ' on' : ''}`}>
                  <input type="radio" name="side" checked={side === v} onChange={() => setSide(v)} />
                  {v === 'all' ? 'both' : v.toLowerCase()}
                </label>
              ))}
            </div>
            <span className="panel-sub">
              {longs} long · {signals.length - longs} short · scanned {formatAgo(lastScanAt, now)}
            </span>
          </div>
        </div>
        <SignalTable
          signals={shown}
          limit={25}
          emptyHint={
            side !== 'all' && signals.length > 0
              ? `None of the ${signals.length} signals are ${side.toLowerCase()}s. Switch to both to see them.`
              : strategyStatus === 'READY'
                ? `Watching ${symbols.length} pairs on ${timeframe}. Nothing has met ${detector.name}'s conditions yet.`
                : strategyHint
          }
        />
      </section>
    </main>
  );
}

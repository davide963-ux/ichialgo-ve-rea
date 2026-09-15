import { useState } from 'react';
import { BacktestPanel, type BacktestRequest } from '../components/BacktestPanel';
import { EmptyState } from '../components/EmptyState';
import { formatMoney } from '../lib/format';

/**
 * Phase 1: no strategy / engine. RUN BACKTEST validates the form and
 * reports that the strategy is not configured. No results are generated.
 */
export function Backtest() {
  const [lastRequest, setLastRequest] = useState<BacktestRequest | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p>Test the Ichialgo strategy on historical candles.</p>
        </div>
      </div>

      <div className="grid-side">
        <BacktestPanel onRun={setLastRequest} />

        <section className="panel" aria-live="polite">
          <div className="panel-head">
            <h2 className="panel-title">Results</h2>
          </div>
          {lastRequest ? (
            <div className="panel-body form-grid">
              <div className="banner danger" role="alert">
                <div className="banner-body">
                  <strong>Strategy not configured yet.</strong>
                  The backtest engine will run once the Ichialgo strategy is added. No results were generated.
                </div>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
                Requested: {lastRequest.pair} on {lastRequest.timeframe}, {lastRequest.startDate} to {lastRequest.endDate}, starting with{' '}
                {formatMoney(lastRequest.startingBalance)} at {lastRequest.riskPct}% risk per trade.
              </p>
            </div>
          ) : (
            <EmptyState icon="flask" title="No backtest run yet">
              Choose a pair, timeframe and date range, then run the backtest.
            </EmptyState>
          )}
          <div className="chart-empty" style={{ marginTop: 4 }}>
            <span>Equity curve appears here after a run</span>
          </div>
        </section>
      </div>
    </main>
  );
}

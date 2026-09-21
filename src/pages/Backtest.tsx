import { BacktestPanel } from '../components/BacktestPanel';
import { BacktestResults } from '../components/BacktestResults';
import { ConfluenceResults } from '../components/ConfluenceResults';
import { EmptyState } from '../components/EmptyState';
import { MarketStatus } from '../components/MarketStatus';
import { useBacktest } from '../hooks/useBacktest';

/**
 * Runs a strategy over historical candles, through the SAME code the live
 * scanner uses — so a backtested trade and a live signal cannot diverge.
 *
 * Both strategies are available. The confluence engine is what the scanner
 * runs; the EMA50 touch is kept because it is still on the dashboard and
 * removing it would throw away the comparison.
 */
export function Backtest() {
  const { status, result, confluence, error, request, run } = useBacktest();
  const isConfluence = request?.strategy === 'confluence';

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p>
            What the strategy would have done on real past prices. Pick a pair and a date range, and it replays every
            candle through the same engine that produces live signals.
          </p>
          <p className="panel-sub">
            One pair over one period is a sanity check, not proof. A strategy can look good on a lucky stretch.
          </p>
        </div>
      </div>

      <div className="grid-side">
        <BacktestPanel onRun={(req) => void run(req)} busy={status === 'RUNNING'} />

        <section className="panel" aria-live="polite">
          <div className="panel-head">
            <h2 className="panel-title">Results</h2>
            {request && status === 'DONE' && (
              <span className="panel-sub">
                {request.pair} {request.timeframe} · {request.startDate} to {request.endDate} ·{' '}
                {isConfluence ? 'Ichimoku + EMA50 confluence' : 'EMA50 touch'}
                {!isConfluence && request.confluentOnly && ' · Ichimoku-confluent only'}
              </span>
            )}
          </div>

          {status === 'IDLE' && (
            <EmptyState icon="flask" title="No backtest run yet">
              Choose a pair, timeframe and date range, then run the backtest.
            </EmptyState>
          )}

          {status === 'RUNNING' && (
            <div className="panel-body">
              <MarketStatus status="LOADING" />
              <p className="panel-sub" style={{ marginTop: 10 }}>
                Fetching history for {request?.pair} on {request?.timeframe}…
              </p>
            </div>
          )}

          {status === 'ERROR' && (
            <div className="banner danger" role="alert">
              <div className="banner-body">
                <strong>Could not run the backtest</strong>
                {error}
              </div>
            </div>
          )}

          {status === 'DONE' && confluence && (
            <div className="panel-body">
              <ConfluenceResults
                result={confluence}
                startingBalance={request?.startingBalance ?? 10_000}
                riskPct={request?.riskPct ?? 1}
              />
            </div>
          )}

          {status === 'DONE' && result && (
            <div className="panel-body">
              <BacktestResults result={result} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

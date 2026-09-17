import { BacktestPanel } from '../components/BacktestPanel';
import { BacktestResults } from '../components/BacktestResults';
import { EmptyState } from '../components/EmptyState';
import { MarketStatus } from '../components/MarketStatus';
import { EMA50_TOUCH } from '../config/strategy';
import { useBacktest } from '../hooks/useBacktest';

/**
 * Runs the EMA50 touch strategy over historical candles, through the same
 * detector the live scanner uses, so a backtested trade and a live signal
 * come from identical code.
 */
export function Backtest() {
  const { status, result, error, request, run } = useBacktest();

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p>
            EMA{EMA50_TOUCH.period} touch on historical candles. Entry at the EMA, stop {EMA50_TOUCH.atrPeriod}-period
            ATR based, target at 2R, one position at a time.
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
                {request.pair} {request.timeframe} · {request.startDate} to {request.endDate}
                {request.confluentOnly && ' · Ichimoku-confluent only'}
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

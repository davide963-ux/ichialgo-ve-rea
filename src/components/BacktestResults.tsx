import { MetricCard } from './MetricCard';
import { EquityChart } from './EquityChart';
import { EmptyState } from './EmptyState';
import { getPair } from '../config/pairs';
import { formatMoney, formatNumber, formatPct } from '../lib/format';
import { formatStamp } from '../lib/time';
import type { BacktestResult } from '../services/strategy';

const stamp = (t: number | null) => (t === null ? '—' : formatStamp(t * 1000));

/** Stats, equity curve and the trade list for one backtest run. */
export function BacktestResults({ result }: { result: BacktestResult }) {
  const { stats, trades, equity, skipped } = result;
  const digits = getPair(result.symbol).digits;
  const price = (v: number | null) => (v === null ? '—' : v.toFixed(digits));
  const skippedTotal = skipped.positionOpen + skipped.notConfluent + skipped.unsizable;

  return (
    <div className="form-grid" style={{ gap: 18 }}>
      {result.warnings.length > 0 && (
        <ul className="msg-list" role="status">
          {result.warnings.map((w) => (
            <li key={w} className="warn">{w}</li>
          ))}
        </ul>
      )}

      <section className="stat-row" aria-label="Backtest statistics">
        <MetricCard
          label="Net profit"
          value={formatMoney(stats.netProfit)}
          hint={`${formatPct(stats.returnPct)} on ${formatMoney(stats.startingBalance)}`}
          accent={stats.netProfit > 0}
        />
        <MetricCard label="Trades" value={stats.closed} hint={skippedTotal > 0 ? `${skippedTotal} touches not traded` : 'all touches traded'} />
        <MetricCard
          label="Win rate"
          // Also unsigned: a 50% win rate is not "+50%".
          value={stats.winRatePct === null ? '—' : `${formatNumber(stats.winRatePct, 1)}%`}
          hint={`${stats.wins}W / ${stats.losses}L`}
        />
        <MetricCard
          label="Profit factor"
          value={stats.profitFactor === null ? '—' : formatNumber(stats.profitFactor, 2)}
          hint={`${formatMoney(stats.grossProfit)} won / ${formatMoney(stats.grossLoss)} lost`}
        />
        <MetricCard
          label="Max drawdown"
          // A drawdown is a magnitude, so it carries no sign — formatPct
          // would render a fall as "+2.0%".
          value={`${formatNumber(stats.maxDrawdownPct, 1)}%`}
          hint={`${formatMoney(stats.maxDrawdown)} peak to trough`}
        />
        <MetricCard
          label="Average R"
          value={stats.averageR === null ? '—' : formatNumber(stats.averageR, 2)}
          hint={stats.expectancy === null ? 'per trade' : `${formatMoney(stats.expectancy)} per trade`}
        />
      </section>

      {skippedTotal > 0 && (
        <p className="panel-sub" style={{ margin: 0 }}>
          Touches not traded: {skipped.positionOpen} while a position was already open
          {skipped.notConfluent > 0 && `, ${skipped.notConfluent} not Ichimoku-confluent`}
          {skipped.unsizable > 0 && `, ${skipped.unsizable} not sizable (no USD rate for this cross)`}.
        </p>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Equity</h2>
          <span className="panel-sub">
            {formatMoney(stats.startingBalance)} → {formatMoney(stats.endingBalance)}, stepped at each trade close
          </span>
        </div>
        <div className="panel-body">
          {equity.length > 1 ? (
            <EquityChart points={equity} startingBalance={stats.startingBalance} />
          ) : (
            <div className="chart-empty"><span>No closed trades to plot</span></div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Trades</h2>
          <span className="panel-sub">{trades.length} taken on {result.symbol} {result.timeframe}</span>
        </div>
        {trades.length === 0 ? (
          <EmptyState icon="table" title="No trades" compact>
            The strategy found no tradable EMA50 touch in this range.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Backtested trades, oldest first.</caption>
              <thead>
                <tr>
                  <th scope="col">ENTRY</th>
                  <th scope="col">SIDE</th>
                  <th scope="col">PRICE</th>
                  <th scope="col">STOP</th>
                  <th scope="col">TARGET</th>
                  <th scope="col">EXIT</th>
                  <th scope="col"><abbr title="Why the trade closed">WHY</abbr></th>
                  <th scope="col">LOTS</th>
                  <th scope="col">PIPS</th>
                  <th scope="col"><abbr title="Result in multiples of the amount risked">R</abbr></th>
                  <th scope="col">P/L</th>
                  <th scope="col"><abbr title="Ichimoku agreement at the touch">☁</abbr></th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="num muted">{stamp(t.entryTime)}</td>
                    <td><span className={`direction ${t.direction === 'LONG' ? 'long' : 'short'}`}>{t.direction}</span></td>
                    <td className="num">{price(t.entryPrice)}</td>
                    <td className="num muted">{price(t.stop)}</td>
                    <td className="num muted">{price(t.target)}</td>
                    <td className="num muted">{stamp(t.exitTime)}</td>
                    <td>
                      <span className={`tag${t.exitReason === 'target' ? ' pos' : t.exitReason === 'stop' ? ' neg' : ''}`}>
                        {t.exitReason.toUpperCase()}
                      </span>
                    </td>
                    <td className="num">{formatNumber(t.lots, 2)}</td>
                    <td className={`num ${t.pips !== null && t.pips < 0 ? 'neg' : ''}`}>{t.pips === null ? '—' : formatNumber(t.pips, 1)}</td>
                    <td className={`num ${t.rMultiple !== null && t.rMultiple < 0 ? 'neg' : 'pos'}`}>
                      {t.rMultiple === null ? '—' : formatNumber(t.rMultiple, 2)}
                    </td>
                    <td className={`num ${t.pnl !== null && t.pnl < 0 ? 'neg' : 'pos'}`}>{t.pnl === null ? '—' : formatMoney(t.pnl)}</td>
                    <td className="num muted">{t.ichimokuScore === null ? '—' : `${t.ichimokuScore}/5`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

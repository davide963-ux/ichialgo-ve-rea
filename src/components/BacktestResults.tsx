/**
 * Backtest results.
 *
 * WHAT THIS PAGE IS FOR
 * ─────────────────────
 * Answering "what happened?" in one sentence, before any jargon. The previous
 * version opened with Average R, Total R, Profit factor and Max drawdown —
 * six numbers, none of them defined on screen, and none of them in the
 * currency the user had just typed into the form. You could not tell whether
 * the strategy had made or lost money without doing arithmetic.
 *
 * So the order is now: plain verdict → money → the curve → the numbers →
 * the breakdowns, folded away. A reader who stops after the first line has
 * still got the answer.
 *
 * WHY MONEY, AND HOW IT IS COMPUTED
 * ─────────────────────────────────
 * The form already asks for a starting balance and a risk percentage. Risk is
 * a FIXED fraction of the STARTING balance, not compounded: with £10,000 at
 * 1%, every trade risks £100, win or lose. That is the conservative reading —
 * compounding would flatter the result — and it is simple enough to state in
 * one line, which matters more here than squeezing out the last percent of
 * realism.
 */
import { useMemo } from 'react';
import { MIN_RELIABLE_TRADES, type Group } from '../services/strategy/performance';
import type { BacktestResult, BacktestTrade } from '../services/strategy';
import { EquityCurve, type EquityPoint } from './EquityCurve';
import { MetricCard } from './MetricCard';

interface Props {
  result: BacktestResult;
  startingBalance: number;
  riskPct: number;
}

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(0)}%`);
const r = (v: number | null, digits = 2): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}R`);
/**
 * Profit factor, in words where a symbol would not help.
 *
 * Infinity is mathematically correct when nothing lost, and meaningless to
 * most readers — "no losses yet" says the same thing and cannot be misread.
 */
const pf = (v: number | null): string =>
  v === null ? '—' : v === Infinity ? 'no losses' : v.toFixed(2);

const money = (v: number): string =>
  `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;

const EXIT_LABEL: Record<BacktestTrade['exit'], string> = {
  tp1: 'Target 1',
  tp2: 'Target 2',
  tp3: 'Target 3',
  sl: 'Stopped out',
  be: 'Breakeven',
  open: 'Still open',
};

const day = (t: number) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

export function BacktestResults({ result, startingBalance, riskPct }: Props) {
  const { overall } = result.report;
  const riskPerTrade = (startingBalance * riskPct) / 100;

  const closed = useMemo(
    () => result.trades.filter((t) => t.rMultiple !== null).sort((a, b) => a.entryTime - b.entryTime),
    [result.trades],
  );

  const curve = useMemo<EquityPoint[]>(() => {
    let balance = startingBalance;
    return closed.map((t, i) => {
      balance += t.rMultiple! * riskPerTrade;
      return {
        n: i + 1,
        balance,
        r: t.rMultiple!,
        label: `${t.direction === 'long' ? 'Long' : 'Short'} ${day(t.entryTime)} · ${EXIT_LABEL[t.exit]}`,
      };
    });
  }, [closed, riskPerTrade, startingBalance]);

  const priceOf = (v: number) => v.toFixed(result.symbol.toUpperCase().endsWith('/JPY') ? 3 : 5);

  if (result.trades.length === 0) {
    return (
      <div className="empty">
        <strong>No trades — the strategy never got a valid setup here.</strong>
        <p>
          It checked {result.barsAnalysed.toLocaleString()} candles and found nothing that produced a setup. Try a longer date range, a different pair, or the 4H timeframe.
        </p>
      </div>
    );
  }

  const netMoney = overall.totalR * riskPerTrade;
  const endBalance = startingBalance + netMoney;
  const returnPct = (netMoney / startingBalance) * 100;
  const drawdownMoney = overall.maxDrawdownR * riskPerTrade;
  const stillOpen = result.trades.length - overall.closed;

  return (
    <>
      {/* ── The answer, in one sentence ───────────────────────────────── */}
      <div className={`verdict ${netMoney > 0 ? 'pos' : netMoney < 0 ? 'neg' : ''}`}>
        <div className="verdict-line">
          <strong>{overall.closed}</strong> trades finished. <strong>{overall.wins}</strong> won,{' '}
          <strong>{overall.losses}</strong> lost
          {overall.breakeven > 0 && <>, {overall.breakeven} broke even</>}.
        </div>
        <div className="verdict-money">{money(netMoney)}</div>
        <div className="verdict-sub">
          on a ${startingBalance.toLocaleString()} account risking {riskPct}% (${Math.round(riskPerTrade)}) per trade
          {' — '}
          <strong>
            {returnPct > 0 ? '+' : ''}
            {returnPct.toFixed(1)}%
          </strong>
          . Balance would have ended at ${Math.round(endBalance).toLocaleString()}.
        </div>
        {stillOpen > 0 && (
          <div className="verdict-note">
            {stillOpen} more trade{stillOpen === 1 ? ' was' : 's were'} still open at the end of the range and
            {stillOpen === 1 ? ' is' : ' are'} not counted.
          </div>
        )}
      </div>

      {/* ── The shape of it ───────────────────────────────────────────── */}
      {curve.length > 1 && (
        <section className="chart-block">
          <h3 className="panel-title">Account balance, trade by trade</h3>
          <EquityCurve points={curve} startingBalance={startingBalance} />
        </section>
      )}

      {/* ── The numbers, with plain labels ────────────────────────────── */}
      <section className="stat-row">
        <MetricCard
          label="Won"
          value={pct(overall.winRatePct)}
          hint={`${overall.wins} of ${overall.wins + overall.losses} trades that had a winner or loser`}
          accent={(overall.winRatePct ?? 0) > 50}
        />
        <MetricCard
          label="Average trade"
          value={money((overall.averageR ?? 0) * riskPerTrade)}
          hint={`${r(overall.averageR)} — what a typical trade made or lost`}
          accent={(overall.averageR ?? 0) > 0}
        />
        <MetricCard
          label="Worst dip"
          value={money(-drawdownMoney)}
          hint="how far below the peak the account fell before recovering"
        />
        <MetricCard
          label="Won vs lost"
          value={pf(overall.profitFactor)}
          hint={
            overall.profitFactor === Infinity
              ? 'nothing was lost over this range'
              : 'money made ÷ money lost. Above 1 means the winners paid for the losers'
          }
          accent={(overall.profitFactor ?? 0) > 1}
        />
      </section>

      {!overall.reliable && (
        <div className="banner" role="note">
          <div className="banner-body">
            <strong>Too few trades to draw a conclusion.</strong>
            {overall.closed} finished trade{overall.closed === 1 ? '' : 's'} is below the {MIN_RELIABLE_TRADES} this
            page treats as a minimum, and it is one pair over one date range. Treat this as a sanity check, not
            evidence.
          </div>
        </div>
      )}

      {/* ── Every trade, readable ─────────────────────────────────────── */}
      <section className="chart-block">
        <h3 className="panel-title">Every trade</h3>
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Direction</th>
                <th className="num">Entry</th>
                <th className="num">Stop</th>
                <th>How it ended</th>
                <th className="num">Held</th>
                <th className="num">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.trades
                .slice()
                .sort((a, b) => a.entryTime - b.entryTime)
                .map((t) => {
                  const pnl = t.rMultiple === null ? null : t.rMultiple * riskPerTrade;
                  return (
                    <tr key={t.id}>
                      <td className="mono">{day(t.entryTime)}</td>
                      <td>
                        <span className={`tag ${t.direction === 'long' ? 'tag-long' : 'tag-short'}`}>
                          {t.direction === 'long' ? '▲ Buy' : '▼ Sell'}
                        </span>
                      </td>
                      <td className="num mono">{priceOf(t.entry)}</td>
                      <td className="num mono">{priceOf(t.initialStop)}</td>
                      <td>
                        <span
                          className={`badge badge-${
                            t.exit === 'sl' ? 'danger' : t.exit === 'open' ? 'muted' : t.exit === 'be' ? 'neutral' : 'ok'
                          }`}
                        >
                          {EXIT_LABEL[t.exit]}
                        </span>
                      </td>
                      <td className="num mono muted">{t.exit === 'open' ? '—' : `${t.barsHeld} bars`}</td>
                      <td className={`num mono ${(pnl ?? 0) > 0 ? 'pos' : (pnl ?? 0) < 0 ? 'neg' : ''}`}>
                        {pnl === null ? '—' : money(pnl)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Everything else, out of the way ───────────────────────────── */}
      <details className="advanced">
        <summary>Detailed breakdown</summary>
        <p className="panel-sub" style={{ marginTop: 10 }}>
          Results split by the conditions that were in force. <strong>R</strong> is the amount risked on one trade, so
          +2R means the trade made twice what it risked.
        </p>
        <Breakdown
          title="By market conditions"
          note="The strategy assumes pullbacks pay in a trend and not in chop. If these rows look the same, that assumption is not doing any work."
          groups={result.report.byRegimeFamily}
          riskPerTrade={riskPerTrade}
        />
        <Breakdown
          title="By signal grade"
          note="Strong means every condition lined up. It should beat Standard."
          groups={result.report.bySignalStrength}
          riskPerTrade={riskPerTrade}
        />
        <Breakdown
          title="Buys vs sells"
          note="A wide gap usually says more about the period tested than about the strategy."
          groups={result.report.byDirection}
          riskPerTrade={riskPerTrade}
        />
        {result.skippedWhileInTrade > 0 && (
          <p className="panel-sub">
            {result.skippedWhileInTrade} further setup{result.skippedWhileInTrade === 1 ? '' : 's'} appeared while a
            trade was already open and {result.skippedWhileInTrade === 1 ? 'was' : 'were'} skipped — one position per
            pair, exactly as the live scanner behaves.
          </p>
        )}
      </details>
    </>
  );
}

function Breakdown({
  title,
  note,
  groups,
  riskPerTrade,
}: {
  title: string;
  note: string;
  groups: Group[];
  riskPerTrade: number;
}) {
  const measurable = groups.filter((g) => g.closed > 0);
  if (measurable.length === 0) return null;

  return (
    <>
      <h4 className="breakdown-title">{title}</h4>
      <p className="panel-sub">{note}</p>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{title.replace('By ', '')}</th>
              <th className="num">Trades</th>
              <th className="num">Won</th>
              <th className="num">Net</th>
              <th className="num">Avg</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {measurable.map((g) => (
              <tr key={g.key} className={g.reliable ? '' : 'row-dim'}>
                <td className="strong">{g.key}</td>
                <td className="num mono">{g.closed}</td>
                <td className="num mono">{pct(g.winRatePct)}</td>
                <td className={`num mono ${g.totalR > 0 ? 'pos' : g.totalR < 0 ? 'neg' : ''}`}>
                  {money(g.totalR * riskPerTrade)}
                </td>
                <td className="num mono muted">{r(g.averageR)}</td>
                <td>{!g.reliable && <span className="badge badge-muted">few trades</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

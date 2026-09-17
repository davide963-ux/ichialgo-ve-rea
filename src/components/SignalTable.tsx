import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { pairToSlug } from '../config/pairs';
import { formatMoney, formatNumber, formatPrice } from '../lib/format';
import type { RateLookup } from '../lib/positionSize';
import { formatStamp } from '../lib/time';
import { planFromTouch, touchTimeMs, type TouchSignal } from '../services/strategy';
import { useAccount } from '../state/accountStore';
import { useMarketStore } from '../state/marketStore';
import { EmptyState } from './EmptyState';
import { IchimokuTag } from './IchimokuTag';
import { OutcomeTag, SignalBadge } from './SignalBadge';

interface Props {
  signals: TouchSignal[];
  limit?: number;
  emptyHint?: string;
}

/** The EMA50 touch log. Rows open the pair on the timeframe it fired on. */
export function SignalTable({ signals, limit, emptyHint }: Props) {
  const navigate = useNavigate();
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);
  const quotes = useMarketStore((s) => s.quotes);
  const rows = limit ? signals.slice(0, limit) : signals;

  // One pass for every visible row: hooks cannot run per row, and the plan is
  // pure arithmetic over data already in memory.
  const plans = useMemo(() => {
    const lookup: RateLookup = (sym) => quotes[sym]?.price ?? null;
    return new Map(rows.map((s) => [s.id, planFromTouch(s, { balance, riskPct }, lookup)]));
  }, [rows, balance, riskPct, quotes]);

  if (rows.length === 0) {
    return (
      <EmptyState title="No EMA50 touches yet" compact>
        {emptyHint ?? 'Signals appear the moment a pair reaches its EMA50 on the scanner timeframe.'}
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">EMA50 touch signals, newest first.</caption>
        <thead>
          <tr>
            <th scope="col">
              <abbr title="When the touch happened: the bar's time for a closed bar, the tick's time for a live touch">TIME</abbr>
            </th>
            <th scope="col">PAIR</th>
            <th scope="col">TF</th>
            <th scope="col">EVENT</th>
            <th scope="col"><abbr title="Direction implied by the touch and the EMA's own trend">BIAS</abbr></th>
            <th scope="col"><abbr title="What the bar did after touching">RESULT</abbr></th>
            <th scope="col">
              <abbr title="How many of the 5 Ichimoku checks agree with this touch's direction. Hover a score for the breakdown.">ICHIMOKU</abbr>
            </th>
            <th scope="col"><abbr title="Distance from the EMA at contact">DIST</abbr></th>
            <th scope="col">EMA50</th>
            <th scope="col">
              <abbr title="Lot size that risks your configured % over an ATR-based stop. Set the account on the Calculator page.">SIZE</abbr>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className="row-link"
              tabIndex={0}
              role="link"
              aria-label={`Open ${s.symbol} on ${s.timeframe}`}
              onClick={() => navigate(`/pair/${pairToSlug(s.symbol)}?tf=${s.timeframe}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/pair/${pairToSlug(s.symbol)}?tf=${s.timeframe}`);
                }
              }}
            >
              <td className="num muted">{formatStamp(touchTimeMs(s))}</td>
              <td><span className="pair-name">{s.symbol}</span></td>
              <td><span className="tag tf-tag">{s.timeframe}</span></td>
              <td><SignalBadge signal={s} /></td>
              <td>
                {s.counterTrend ? (
                  <span className="tag warn" title="Touch against the EMA's trend">COUNTER</span>
                ) : s.bias === 'neutral' ? (
                  <span className="muted">—</span>
                ) : (
                  <span className={s.bias === 'long' ? 'pos' : 'neg'}>{s.bias.toUpperCase()}</span>
                )}
              </td>
              <td><OutcomeTag outcome={s.outcome} /></td>
              <td><IchimokuTag signal={s} ctx={s.ichimoku} /></td>
              <td className="num">{formatNumber(s.distancePips, 1)}</td>
              <td className="num muted">{formatPrice(s.symbol, s.ema)}</td>
              <td className="num">
                {(() => {
                  const plan = plans.get(s.id);
                  if (!plan || plan.lots === null) return <span className="muted">—</span>;
                  return (
                    <span
                      title={
                        `${plan.direction} from ${formatPrice(s.symbol, plan.entry)}, ` +
                        `stop ${formatPrice(s.symbol, plan.stop)} (${formatNumber(plan.stopPips, 1)} pips), ` +
                        `target ${formatPrice(s.symbol, plan.target)} — risking ${formatMoney(plan.potentialLoss)} ` +
                        `to make ${formatMoney(plan.potentialProfit)}`
                      }
                    >
                      {formatNumber(plan.lots, 2)}
                    </span>
                  );
                })()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

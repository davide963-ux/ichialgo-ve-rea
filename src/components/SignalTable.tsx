import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { pairToSlug } from '../config/pairs';
import { formatMoney, formatNumber, formatPrice } from '../lib/format';
import type { RateLookup } from '../lib/positionSize';
import { formatStamp } from '../lib/time';
import { planFromSignal, signalTimeMs, type IchimokuSignal } from '../services/strategy';
import { useAccount } from '../state/accountStore';
import { useMarketStore } from '../state/marketStore';
import { EmptyState } from './EmptyState';
import { ScoreTag } from './ScoreTag';
import { SignalBadge, SourceTag } from './SignalBadge';

interface Props {
  signals: IchimokuSignal[];
  limit?: number;
  emptyHint?: string;
}

/**
 * The signal log. Rows open the pair on the timeframe it fired on.
 *
 * Nothing here knows which strategy produced a row: the score renders out of
 * whatever that signal's own `checksTotal` is, so a four-condition rule and a
 * three-condition one both read correctly in the same table.
 */
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
    return new Map(rows.map((s) => [s.id, planFromSignal(s, { balance, riskPct }, lookup)]));
  }, [rows, balance, riskPct, quotes]);

  if (rows.length === 0) {
    return (
      <EmptyState title="No Kijun pullbacks yet" compact>
        {emptyHint ?? 'A signal appears when price, already clear of the Kumo, pulls back to Kijun-sen.'}
      </EmptyState>
    );
  }

  const open = (s: IchimokuSignal) => navigate(`/pair/${pairToSlug(s.symbol)}?tf=${s.timeframe}`);

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Ichimoku Kijun pullback signals, newest first.</caption>
        <thead>
          <tr>
            <th scope="col">
              <abbr title="When it happened: the bar's time for a closed bar, the tick's time for a live signal">TIME</abbr>
            </th>
            <th scope="col">PAIR</th>
            <th scope="col">TF</th>
            <th scope="col">EVENT</th>
            <th scope="col"><abbr title="Direction, taken from which side of the Kumo price is on">SIDE</abbr></th>
            <th scope="col"><abbr title="Closed bar, or a live tick inside an unfinished bar">SOURCE</abbr></th>
            <th scope="col">
              <abbr title="How many of this strategy's conditions passed. The required ones are a gate — a signal cannot exist without them. Hover a score for the breakdown.">
                SCORE
              </abbr>
            </th>
            <th scope="col"><abbr title="Distance from Kijun-sen at entry">DIST</abbr></th>
            <th scope="col">KIJUN</th>
            <th scope="col"><abbr title="Stop distance: 0.4 × the 26-bar high-low range">STOP</abbr></th>
            <th scope="col">
              <abbr title="Lot size that risks your configured % over this stop. Set the account on the Calculator page.">SIZE</abbr>
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
              onClick={() => open(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(s);
                }
              }}
            >
              <td className="num muted">{formatStamp(signalTimeMs(s))}</td>
              <td><span className="pair-name">{s.symbol}</span></td>
              <td><span className="tag tf-tag">{s.timeframe}</span></td>
              <td><SignalBadge signal={s} compact /></td>
              <td><span className={s.direction === 'LONG' ? 'pos' : 'neg'}>{s.direction}</span></td>
              <td><SourceTag source={s.source} /></td>
              <td><ScoreTag signal={s} /></td>
              <td className="num">{formatNumber(s.distancePips, 1)}</td>
              <td className="num muted">{formatPrice(s.symbol, s.kijun)}</td>
              <td className="num muted">{formatNumber(s.stopPips, 1)}</td>
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

import { useNavigate } from 'react-router-dom';
import { pairToSlug } from '../config/pairs';
import { formatNumber, formatPrice } from '../lib/format';
import { formatStamp } from '../lib/time';
import { touchTimeMs, type TouchSignal } from '../services/strategy';
import { EmptyState } from './EmptyState';
import { OutcomeTag, SignalBadge } from './SignalBadge';

interface Props {
  signals: TouchSignal[];
  limit?: number;
  emptyHint?: string;
}

/** The EMA50 touch log. Rows open the pair on the timeframe it fired on. */
export function SignalTable({ signals, limit, emptyHint }: Props) {
  const navigate = useNavigate();
  const rows = limit ? signals.slice(0, limit) : signals;

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
            <th scope="col"><abbr title="Distance from the EMA at contact">DIST</abbr></th>
            <th scope="col">EMA50</th>
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
              <td className="num">{formatNumber(s.distancePips, 1)}</td>
              <td className="num muted">{formatPrice(s.symbol, s.ema)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

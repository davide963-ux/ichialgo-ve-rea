import { Link } from 'react-router-dom';
import { ICHIMOKU } from '../config/ichimokuStrategy';
import { formatMoney, formatNumber, formatPrice } from '../lib/format';
import { calculatorLink, type IchimokuSignal, type TradePlan } from '../services/strategy';
import { useAccount } from '../state/accountStore';

/**
 * The order ticket for a signal, whichever strategy produced it.
 *
 *   target ──┐  entry + 2 × risk
 *   entry  ──●  the close of the bar that completed the setup
 *   stop   ──┘  entry ∓ 0.4 × the 26-bar range
 *
 * Both distances come out of Ichimoku's own geometry: Kijun-sen is the
 * midpoint of the 26-bar high-low range, so that range's width is a
 * volatility measure the strategy already contains. It is what the stop used
 * to take from an average true range, with no second indicator to disagree
 * with the first.
 */
export function TradePlanCard({ signal, plan }: { signal: IchimokuSignal; plan: TradePlan | null }) {
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);

  if (!plan) {
    return <p className="panel-body muted">No trade plan: this signal's levels round to an unusable ticket.</p>;
  }

  const long = plan.direction === 'LONG';

  return (
    <div className="panel-body plan-card">
      <div className="plan-head">
        <span className={`tag ${long ? 'pos' : 'neg'}`}>{plan.direction}</span>
        <span className="panel-sub">
          Stop beyond {signal.entryType === 'pullback' ? 'Kijun-sen' : 'the far cloud edge'} (
          {formatPrice(signal.symbol, signal.stopLevel)}) plus {formatNumber(ICHIMOKU.stopBuffer, 2)} × the 26-bar
          range = {formatNumber(plan.stopPips, 1)} pips · target {formatNumber(plan.riskReward, 1)}× the risk ·
          risking {formatNumber(riskPct, 2)}% of {formatMoney(balance)}
        </span>
        <Link className="btn btn-ghost" to={calculatorLink(signal.symbol, plan)}>
          Open in calculator
        </Link>
      </div>

      <dl className="quote-grid">
        <div>
          <dt>Entry (signal bar close)</dt>
          <dd className="num">{formatPrice(signal.symbol, plan.entry)}</dd>
        </div>
        <div>
          <dt>{signal.entryType === 'pullback' ? 'Kijun-sen (the level)' : 'Far cloud edge (the level)'}</dt>
          <dd className="num muted">
            {formatPrice(signal.symbol, signal.stopLevel)}{' '}
            <span className="muted">· the stop sits just beyond it</span>
          </dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd className="num neg">
            {formatPrice(signal.symbol, plan.stop)} <span className="muted">· {formatNumber(plan.stopPips, 1)} pips</span>
          </dd>
        </div>
        <div>
          <dt>Take profit</dt>
          <dd className="num pos">
            {formatPrice(signal.symbol, plan.target)} <span className="muted">· {formatNumber(plan.targetPips, 1)} pips</span>
          </dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd className="num">
            {plan.lots === null ? '—' : `${formatNumber(plan.lots, 2)} lots`}
            {plan.units !== null && <span className="muted"> · {formatNumber(plan.units, 0)} units</span>}
          </dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd className="num neg">{formatMoney(plan.potentialLoss ?? plan.riskAmount)}</dd>
        </div>
        <div>
          <dt>Reward</dt>
          <dd className="num pos">{formatMoney(plan.potentialProfit)}</dd>
        </div>
      </dl>

      {plan.warnings.length > 0 && (
        <ul className="msg-list">
          {plan.warnings.map((w) => (
            <li key={w} className="warn">{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

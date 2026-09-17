import { Link } from 'react-router-dom';
import { TRADE_PLAN } from '../config/strategy';
import { formatMoney, formatNumber, formatPrice } from '../lib/format';
import { calculatorLink, type TouchSignal, type TradePlan } from '../services/strategy';
import { useAccount } from '../state/accountStore';

/**
 * The order ticket for a touch: entry at the EMA, stop an ATR multiple away,
 * target at the R multiple, and the size that risks the configured percentage.
 *
 *   target ──┐  entry + 2R
 *   entry  ──●  the EMA50 itself
 *   stop   ──┘  entry ∓ 1.5 × ATR
 */
export function TradePlanCard({ signal, plan }: { signal: TouchSignal; plan: TradePlan | null }) {
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);

  if (!plan) {
    return (
      <p className="panel-body muted">No trade plan: this touch has no usable EMA level.</p>
    );
  }

  const long = plan.direction === 'LONG';

  return (
    <div className="panel-body plan-card">
      <div className="plan-head">
        <span className={`tag ${long ? 'pos' : 'neg'}`}>{plan.direction}</span>
        <span className="panel-sub">
          Stop = {formatNumber(TRADE_PLAN.stopAtrMultiple, 1)} × ATR({formatNumber(plan.atrPips, 1)} pips) ={' '}
          {formatNumber(plan.stopPips, 1)} pips · target {formatNumber(plan.riskReward, 1)}R · risking{' '}
          {formatNumber(riskPct, 2)}% of {formatMoney(balance)}
        </span>
        <Link className="btn btn-ghost" to={calculatorLink(signal.symbol, plan)}>
          Open in calculator
        </Link>
      </div>

      <dl className="quote-grid">
        <div>
          <dt>Entry (EMA50)</dt>
          <dd className="num">{formatPrice(signal.symbol, plan.entry)}</dd>
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

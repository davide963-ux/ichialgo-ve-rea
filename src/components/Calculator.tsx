/**
 * Forex position-size calculator UI.
 * All math lives in lib/positionSize.ts (pure + unit-tested).
 * Live quotes are used only for "Use live price" and cross-pair USD conversion.
 *
 * Balance and risk % are kept in accountStore (persisted), because the
 * strategy's trade plans size themselves from the same two numbers — this
 * page is where they are set.
 *
 * A trade plan links here with ?symbol=&entry=&sl=&tp= to prefill the form,
 * so a signal can be reviewed and adjusted before it is taken.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PAIRS, getPair } from '../config/pairs';
import { formatMoney, formatNumber, formatPrice } from '../lib/format';
import { pipSize } from '../lib/pips';
import { calculatePosition, type RateLookup } from '../lib/positionSize';
import { accountStore, useAccount } from '../state/accountStore';
import { useMarketStore } from '../state/marketStore';

const parse = (v: string): number => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));

export function Calculator() {
  const [params] = useSearchParams();
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);

  // Prefill from a trade plan link; only read on the first render, so typing
  // is never overwritten by the URL.
  const [form, setForm] = useState(() => {
    const symbol = params.get('symbol');
    return {
      symbol: symbol && PAIRS.some((p) => p.symbol === symbol) ? symbol : (PAIRS[0]?.symbol ?? 'EUR/USD'),
      entry: params.get('entry') ?? '',
      stopLoss: params.get('sl') ?? '',
      takeProfit: params.get('tp') ?? '',
    };
  });
  const [account, setAccount] = useState({ balance: String(balance), riskPct: String(riskPct) });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /** Account fields write through to the shared store when they parse. */
  const setAccountField = (k: keyof typeof account) => (e: { target: { value: string } }) => {
    const raw = e.target.value;
    setAccount((a) => ({ ...a, [k]: raw }));
    const n = parse(raw);
    if (Number.isFinite(n) && n > 0) accountStore.set({ [k]: n });
  };

  const quotes = useMarketStore((s) => s.quotes);
  const live = useMarketStore((s) => s.status === 'ONLINE');
  const quote = quotes[form.symbol];
  const pair = getPair(form.symbol);

  const lookup: RateLookup = useCallback((sym) => quotes[sym]?.price ?? null, [quotes]);

  const touched = form.entry !== '' || form.stopLoss !== '';
  const result = useMemo(
    () =>
      calculatePosition(
        {
          balance: parse(account.balance),
          riskPct: parse(account.riskPct),
          symbol: form.symbol,
          entry: parse(form.entry),
          stopLoss: parse(form.stopLoss),
          takeProfit: form.takeProfit.trim() === '' ? null : parse(form.takeProfit),
        },
        lookup,
      ),
    [form, account, lookup],
  );

  const isCross = pair.base !== 'USD' && pair.quote !== 'USD';
  const warnings = [...result.warnings];
  if (result.ok && isCross && !live) warnings.push('Market data is offline: USD conversion uses the last known rate.');

  const useLive = () => {
    if (quote) setForm((f) => ({ ...f, entry: formatPrice(f.symbol, quote.price) }));
  };

  const step = String(pipSize(form.symbol) / 10);
  const r = result;

  return (
    <div className="grid-side">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Trade inputs</h2>
          <span className="panel-sub">Account currency: USD · balance and risk are saved and reused by signals</span>
        </div>
        <div className="panel-body form-grid">
          <div className="two">
            <div className="field">
              <label htmlFor="c-bal">Account balance</label>
              <div className="input-affix">
                <input id="c-bal" className="input" inputMode="decimal" value={account.balance} onChange={setAccountField('balance')} />
                <span>USD</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="c-risk">Risk</label>
              <div className="input-affix">
                <input id="c-risk" className="input" inputMode="decimal" value={account.riskPct} onChange={setAccountField('riskPct')} />
                <span>%</span>
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="c-pair">Pair</label>
            <select id="c-pair" className="input" value={form.symbol} onChange={set('symbol')}>
              {PAIRS.map((p) => (
                <option key={p.symbol}>{p.symbol}</option>
              ))}
            </select>
            <span className="field-hint">
              Pip size {pipSize(form.symbol)}
              {pair.quote === 'JPY' ? ' (JPY pair)' : ''}
            </span>
          </div>

          <div className="field">
            <label htmlFor="c-entry">Entry price</label>
            <input id="c-entry" className="input" type="number" step={step} inputMode="decimal" value={form.entry} onChange={set('entry')} placeholder={quote ? formatPrice(form.symbol, quote.price) : ''} />
            <span className="field-hint">
              <button type="button" className="inline-link" onClick={useLive} disabled={!quote}>
                Use {live ? 'live' : 'last known'} price
              </button>
              {quote ? ` ${formatPrice(form.symbol, quote.price)}` : ' (no price loaded)'}
            </span>
          </div>

          <div className="two">
            <div className="field">
              <label htmlFor="c-sl">Stop loss</label>
              <input id="c-sl" className="input" type="number" step={step} inputMode="decimal" value={form.stopLoss} onChange={set('stopLoss')} aria-invalid={touched && !r.ok && r.stopPips === null} />
            </div>
            <div className="field">
              <label htmlFor="c-tp">Take profit</label>
              <input id="c-tp" className="input" type="number" step={step} inputMode="decimal" value={form.takeProfit} onChange={set('takeProfit')} placeholder="Optional" />
            </div>
          </div>

          {touched && r.errors.length > 0 && (
            <ul className="msg-list err" role="alert">
              {r.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="msg-list" role="status">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel" aria-live="polite">
        <div className="panel-head">
          <h2 className="panel-title">Position size</h2>
          {r.direction && <span className={`direction ${r.direction === 'LONG' ? 'long' : 'short'}`}>{r.direction}</span>}
        </div>
        <dl className="result-list">
          <div>
            <dt>Risk amount</dt>
            <dd>{formatMoney(r.riskAmount)}</dd>
          </div>
          <div className="hl">
            <dt>Position size</dt>
            <dd>
              {r.ok ? `${formatNumber(r.lots, 2)} lots` : '—'}
              <small>{r.ok ? `${formatNumber(r.units, 0)} units` : 'Enter entry and stop loss'}</small>
            </dd>
          </div>
          <div>
            <dt>Potential loss</dt>
            <dd className={r.ok ? 'neg' : ''}>
              {r.ok ? formatMoney(r.potentialLoss) : '—'}
              <small>{r.stopPips !== null ? `${formatNumber(r.stopPips, 1)} pips` : ' '}</small>
            </dd>
          </div>
          <div>
            <dt>Potential profit</dt>
            <dd className={r.ok && r.potentialProfit !== null ? 'pos' : ''}>
              {r.ok ? formatMoney(r.potentialProfit) : '—'}
              <small>{r.targetPips !== null ? `${formatNumber(r.targetPips, 1)} pips` : 'Add a take profit'}</small>
            </dd>
          </div>
          <div>
            <dt>Risk / reward</dt>
            <dd>{r.riskReward !== null ? `1 : ${formatNumber(r.riskReward, 2)}` : '—'}</dd>
          </div>
          <div>
            <dt>Pip value</dt>
            <dd>
              {r.pipValuePerLot !== null ? formatMoney(r.pipValuePerLot) : '—'}
              <small>per standard lot</small>
            </dd>
          </div>
        </dl>
        <div className="chart-foot">
          <span>Lots are rounded down to 0.01 so the loss never exceeds the risk amount.</span>
          {r.lotsExact !== null && <span>Exact: {formatNumber(r.lotsExact, 4)} lots</span>}
        </div>
      </section>
    </div>
  );
}

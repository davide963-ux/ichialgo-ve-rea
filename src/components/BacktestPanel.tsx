/**
 * Backtest configuration form. `onRun` hands a validated request to
 * useBacktest, which fetches history and runs the EMA50 touch engine.
 */
import { useState, type FormEvent } from 'react';
import { PAIRS } from '../config/pairs';
import { DEFAULT_TIMEFRAME, TIMEFRAMES, type Timeframe } from '../config/timeframes';

export interface BacktestRequest {
  pair: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  startingBalance: number;
  riskPct: number;
  /** Only trade touches Ichimoku agrees with. EMA50-touch strategy only. */
  confluentOnly: boolean;
  /** Which strategy to run. Both stay available; neither replaces the other. */
  strategy: 'confluence' | 'ema50-touch';
}

interface Props {
  onRun: (req: BacktestRequest) => void;
  busy?: boolean;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function BacktestPanel({ onRun, busy = false }: Props) {
  const today = new Date();
  const [form, setForm] = useState({
    pair: PAIRS[0]?.symbol ?? 'EUR/USD',
    timeframe: DEFAULT_TIMEFRAME as Timeframe,
    startDate: isoDay(new Date(today.getTime() - 90 * 86400_000)),
    endDate: isoDay(today),
    startingBalance: '10000',
    riskPct: '1',
    confluentOnly: false,
    strategy: 'confluence' as BacktestRequest['strategy'],
  });
  const [errors, setErrors] = useState<string[]>([]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];
    const balance = Number(form.startingBalance);
    const risk = Number(form.riskPct);
    if (!form.startDate || !form.endDate) errs.push('Choose a start and end date.');
    else if (form.startDate >= form.endDate) errs.push('Start date must be before end date.');
    if (form.endDate > isoDay(today)) errs.push('End date cannot be in the future.');
    if (!Number.isFinite(balance) || balance <= 0) errs.push('Starting balance must be above 0.');
    if (!Number.isFinite(risk) || risk <= 0 || risk > 100) errs.push('Risk % must be between 0 and 100.');
    setErrors(errs);
    if (errs.length) return;
    onRun({ ...form, startingBalance: balance, riskPct: risk });
  };

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <div className="panel-head">
        <h2 className="panel-title">Backtest settings</h2>
      </div>
      <div className="panel-body form-grid">
        <div className="two">
          <div className="field">
            <label htmlFor="bt-pair">Pair</label>
            <select id="bt-pair" className="input" value={form.pair} onChange={(e) => set('pair', e.target.value)}>
              {PAIRS.map((p) => (
                <option key={p.symbol}>{p.symbol}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bt-tf">Timeframe</label>
            <select id="bt-tf" className="input" value={form.timeframe} onChange={(e) => set('timeframe', e.target.value as Timeframe)}>
              {TIMEFRAMES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="bt-start">Start date</label>
            <input id="bt-start" type="date" className="input" value={form.startDate} max={form.endDate} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bt-end">End date</label>
            <input id="bt-end" type="date" className="input" value={form.endDate} max={isoDay(today)} onChange={(e) => set('endDate', e.target.value)} />
          </div>
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="bt-bal">Starting balance</label>
            <div className="input-affix">
              <input id="bt-bal" inputMode="decimal" className="input" value={form.startingBalance} onChange={(e) => set('startingBalance', e.target.value)} />
              <span>USD</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="bt-risk">Risk per trade</label>
            <div className="input-affix">
              <input id="bt-risk" inputMode="decimal" className="input" value={form.riskPct} onChange={(e) => set('riskPct', e.target.value)} />
              <span>%</span>
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="bt-strategy">Strategy</label>
          <select
            id="bt-strategy"
            className="input"
            value={form.strategy}
            onChange={(e) => set('strategy', e.target.value as BacktestRequest['strategy'])}
          >
            <option value="confluence">Ichimoku + EMA50 confluence</option>
            <option value="ema50-touch">EMA50 touch (original)</option>
          </select>
        </div>

        {/* Only the touch strategy has a confluence filter; the confluence
            engine scores Ichimoku as part of its own hierarchy. */}
        {form.strategy === 'ema50-touch' && (
          <label className="overlay-toggle" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={form.confluentOnly}
              onChange={(e) => set('confluentOnly', e.target.checked)}
            />
            Only trade Ichimoku-confluent touches
          </label>
        )}

        {errors.length > 0 && (
          <ul className="msg-list err" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <button type="submit" className="btn btn-primary" style={{ height: 44, marginTop: 4 }} disabled={busy}>
          {busy ? 'RUNNING…' : 'RUN BACKTEST'}
        </button>
      </div>
    </form>
  );
}

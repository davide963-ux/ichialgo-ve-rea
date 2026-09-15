import { APP_LOCALE } from '../lib/locale';
import { EmptyState } from './EmptyState';

/**
 * Trade history table. Phase 1: structure only — rows will come from the
 * Signal Store once the strategy engine exists. Never fabricates trades.
 */
export interface TradeRecord {
  id: string;
  pair: string;
  side: 'BUY' | 'SELL';
  openedAt: number;
  closedAt: number | null;
  entry: number;
  exit: number | null;
  pips: number | null;
  pnl: number | null;
}

const COLUMNS = ['PAIR', 'SIDE', 'OPENED', 'CLOSED', 'ENTRY', 'EXIT', 'PIPS', 'P/L'];

export function TradeTable({ trades }: { trades: TradeRecord[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} style={{ textAlign: 'center' }}>
                <EmptyState icon="table" title="No trades recorded" compact>
                  Closed trades from the Ichialgo strategy will be listed here.
                </EmptyState>
              </td>
            </tr>
          )}
          {trades.map((t) => (
            <tr key={t.id}>
              <td className="pair-name">{t.pair}</td>
              <td><span className={`direction ${t.side === 'BUY' ? 'long' : 'short'}`}>{t.side}</span></td>
              <td className="num">{new Date(t.openedAt).toLocaleString(APP_LOCALE)}</td>
              <td className="num">{t.closedAt ? new Date(t.closedAt).toLocaleString(APP_LOCALE) : '—'}</td>
              <td className="num">{t.entry}</td>
              <td className="num">{t.exit ?? '—'}</td>
              <td className="num">{t.pips ?? '—'}</td>
              <td className={`num ${t.pnl !== null && t.pnl < 0 ? 'neg' : ''}`}>{t.pnl ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

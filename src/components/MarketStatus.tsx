import { useMarketStore } from '../state/marketStore';
import type { ConnectionStatus } from '../services/marketData/types';

const LABEL: Record<ConnectionStatus, string> = {
  LOADING: 'CONNECTING',
  ONLINE: 'MARKET DATA ONLINE',
  OFFLINE: 'MARKET DATA OFFLINE',
  ERROR: 'MARKET DATA ERROR',
};

interface Props {
  pill?: boolean;
  /** Override: show a specific status instead of the global one. */
  status?: ConnectionStatus;
}

/** Connection indicator. Reflects MARKET DATA health — not a trading strategy. */
export function MarketStatus({ pill = false, status }: Props) {
  const global = useMarketStore((s) => s.status);
  const message = useMarketStore((s) => s.statusMessage);
  const value = status ?? global;
  return (
    <span
      className={`market-status${pill ? ' pill' : ''}`}
      data-status={value}
      role="status"
      aria-live="polite"
      title={message ?? LABEL[value]}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="market-status-label">{LABEL[value]}</span>
    </span>
  );
}

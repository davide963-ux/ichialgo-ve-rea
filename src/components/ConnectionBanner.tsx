import { marketDataService } from '../services/marketData';
import { useMarketStore } from '../state/marketStore';
import { useNow } from '../hooks/useNow';

/**
 * Explains non-healthy connection states and offers a retry.
 * Never shown when everything is ONLINE and there's nothing to say.
 */
export function ConnectionBanner() {
  const status = useMarketStore((s) => s.status);
  const message = useMarketStore((s) => s.statusMessage);
  const kind = useMarketStore((s) => s.errorKind);
  const provider = useMarketStore((s) => s.provider.label);
  const symbolErrors = useMarketStore((s) => s.symbolErrors);
  const nextRetryAt = useMarketStore((s) => s.nextRetryAt);
  const now = useNow();

  const badSymbols = Object.keys(symbolErrors);
  const retryIn = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : null;

  if (status === 'LOADING') return null;

  if (status === 'ERROR' || status === 'OFFLINE') {
    const title =
      kind === 'config' || kind === 'auth'
        ? `${provider} is not set up`
        : status === 'OFFLINE'
          ? 'Market data offline — prices below are not live'
          : 'Market data unavailable';
    return (
      <div className="banner danger" role="alert">
        <div className="banner-body">
          <strong>{title}</strong>
          {message}
          {(kind === 'config' || kind === 'auth') && (
            <>
              {' '}See <code>.env.example</code> for the required variables.
            </>
          )}
          {retryIn !== null && status === 'OFFLINE' && <> Next attempt in {retryIn}s.</>}
        </div>
        <button className="btn" onClick={() => marketDataService.retry()}>
          Reconnect
        </button>
      </div>
    );
  }

  if (message || badSymbols.length) {
    return (
      <div className="banner" role="status">
        <div className="banner-body">
          {message && <div>{message}</div>}
          {badSymbols.length > 0 && (
            <div>
              Unavailable from {provider}: {badSymbols.map((s) => `${s} (${symbolErrors[s]})`).join(', ')}
            </div>
          )}
        </div>
      </div>
    );
  }
  return null;
}

/**
 * Provider factory — the ONLY place that knows concrete providers.
 * To add a provider: implement MarketDataProvider, register it here,
 * add its proxy rule in vite.config.ts.
 */
import type { MarketDataProvider, ProviderId } from '../types';
import { OandaProvider } from './OandaProvider';
import { TwelveDataProvider } from './TwelveDataProvider';

export function createProvider(id: ProviderId): MarketDataProvider {
  switch (id) {
    case 'twelvedata':
      return new TwelveDataProvider();
    case 'oanda':
    default:
      return new OandaProvider();
  }
}

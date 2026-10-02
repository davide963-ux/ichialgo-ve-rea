/**
 * Public entry point of the market-data layer.
 * UI code imports `marketDataService` + types from here — never a provider.
 */
import { APP_CONFIG } from '../../config/app';
import { PAIRS } from '../../config/pairs';
import { MarketDataService } from './MarketDataService';
import { createProvider } from './providers';

export const marketDataService = new MarketDataService(
  createProvider(APP_CONFIG.provider),
  PAIRS.map((p) => p.symbol),
);

export type { Candle, Quote, ConnectionStatus } from './types';
export { ProviderError } from './types';

/**
 * Provider factory — the ONLY place that knows a concrete provider.
 *
 * Twelve Data serves the live prices: it is the sole free forex source that
 * quotes to a server, from any country, without a broker account. (OANDA is
 * licensed per country and Finnhub puts forex behind a paid plan.)
 *
 * Candles are routed through Yahoo first, because they need no account
 * either and cost no Twelve Data credits. Yahoo cannot carry the quotes —
 * its endpoint is unofficial and blocks datacenter IPs under load — so it is
 * wrapped as a saving with an automatic fallback, never as a dependency.
 * See YahooCandleRouter.
 *
 * The MarketDataProvider interface stays, so adding another provider means a
 * new file here plus a route in server/api.mjs — nothing in the UI.
 */
import { APP_CONFIG } from '../../../config/app';
import type { MarketDataProvider, ProviderId } from '../types';
import { TwelveDataProvider } from './TwelveDataProvider';
import { YahooCandleRouter } from './YahooCandleRouter';

export function createProvider(_id: ProviderId): MarketDataProvider {
  const twelveData = new TwelveDataProvider();
  return APP_CONFIG.yahooCandles ? new YahooCandleRouter(twelveData) : twelveData;
}

/**
 * Provider factory — the ONLY place that knows a concrete provider.
 *
 * Twelve Data is the only one: it is the sole free forex source that serves
 * intraday OHLC candles to a server, from any country, without a broker
 * account. (OANDA is licensed per country, Finnhub puts forex candles behind
 * a paid plan, and Yahoo's unofficial endpoint blocks datacenter IPs.)
 *
 * The MarketDataProvider interface stays, so adding one back later means a new
 * file here plus a route in server/api.mjs — nothing in the UI or strategy.
 */
import type { MarketDataProvider, ProviderId } from '../types';
import { TwelveDataProvider } from './TwelveDataProvider';

export function createProvider(_id: ProviderId): MarketDataProvider {
  return new TwelveDataProvider();
}

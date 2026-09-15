import { useEffect } from 'react';
import { marketDataService } from '../services/marketData';
import { useMarketStore } from '../state/marketStore';

/** Starts the market-data service once for the whole app. */
export function useMarketDataConnection(): void {
  useEffect(() => {
    void marketDataService.start();
    return () => marketDataService.stop();
  }, []);
}

export const useQuote = (symbol: string) => useMarketStore((s) => s.quotes[symbol]);
export const useConnection = () => useMarketStore((s) => s.status);
export const useSymbolError = (symbol: string) => useMarketStore((s) => s.symbolErrors[symbol]);

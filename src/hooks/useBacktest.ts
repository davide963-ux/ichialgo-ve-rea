/**
 * Runs the backtest over the checked-in market fixtures.
 *
 * WHY FIXTURES AND NOT LIVE CANDLES
 * ─────────────────────────────────
 * The provider serves ~300 bars per request. Three hundred bars is a few
 * dozen trades: a sample too small for its own confidence interval to mean
 * anything, and small samples are precisely how this project talked itself
 * into a strategy that did not work. `fixtures/market/` is 5000 real OANDA
 * hourly bars per pair, checked in, identical on every machine and every
 * run — so two people comparing numbers are comparing the same thing.
 *
 * The CSVs are ~1.2 MB, so they are loaded with a DYNAMIC import: Vite emits
 * them as a separate chunk that is fetched when this page opens and never
 * touches the main bundle.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Candle } from '../services/marketData';
import { backtestTouches, combine, type BacktestFilters, type BacktestResult } from '../services/strategy';

/** Pairs with a checked-in fixture, and how to fetch each one. */
export const FIXTURE_PAIRS = [
  { symbol: 'EUR/USD', load: () => import('../../fixtures/market/EURUSD_1H.csv?raw') },
  { symbol: 'GBP/USD', load: () => import('../../fixtures/market/GBPUSD_1H.csv?raw') },
  { symbol: 'USD/JPY', load: () => import('../../fixtures/market/USDJPY_1H.csv?raw') },
  { symbol: 'AUD/USD', load: () => import('../../fixtures/market/AUDUSD_1H.csv?raw') },
  { symbol: 'USD/CAD', load: () => import('../../fixtures/market/USDCAD_1H.csv?raw') },
  { symbol: 'GBP/JPY', load: () => import('../../fixtures/market/GBPJPY_1H.csv?raw') },
] as const;

export type FixtureSymbol = (typeof FIXTURE_PAIRS)[number]['symbol'];

/** "t,o,h,l,c" rows, oldest first. */
function parse(csv: string): Candle[] {
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t!, open: o!, high: h!, low: l!, close: c!, volume: null, complete: true };
    });
}

export interface BacktestState {
  status: 'LOADING' | 'READY' | 'ERROR';
  error: string | null;
  /** Per pair, in FIXTURE_PAIRS order. */
  results: BacktestResult[];
  /** Every pair's trades merged and re-measured as one portfolio. */
  portfolio: ReturnType<typeof combine> | null;
  /** Calendar span the fixtures cover, for the caption. */
  span: { from: number; to: number } | null;
}

/** Candles are loaded once and kept; only the filters change after that. */
export function useBacktest(symbols: readonly string[], filters: BacktestFilters): BacktestState {
  const [candles, setCandles] = useState<Map<string, Candle[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(FIXTURE_PAIRS.map(async (p) => [p.symbol, parse((await p.load()).default)] as const))
      .then((entries) => live && setCandles(new Map(entries)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    if (error) return { status: 'ERROR' as const, error, results: [], portfolio: null, span: null };
    if (!candles) return { status: 'LOADING' as const, error: null, results: [], portfolio: null, span: null };

    const results = FIXTURE_PAIRS.filter((p) => symbols.includes(p.symbol)).map((p) =>
      backtestTouches(candles.get(p.symbol)!, p.symbol, '1H', filters),
    );

    const all = [...candles.values()].flat();
    const span = all.length
      ? { from: Math.min(...all.map((c) => c.time)), to: Math.max(...all.map((c) => c.time)) }
      : null;

    return { status: 'READY' as const, error: null, results, portfolio: combine(results), span };
  }, [candles, error, symbols, filters]);
}

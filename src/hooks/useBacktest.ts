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
import { PAIRS } from '../config/pairs';
import type { Candle } from '../services/marketData';
import { backtest, combine, type BacktestFilters, type BacktestResult, type StrategyId } from '../services/strategy';

/**
 * Every pair with a checked-in fixture, and how to fetch it.
 *
 * This is the set of candles that EXIST, not the set the backtest runs. The
 * two are different, and conflating them is what put GBP/JPY in the results:
 * these CSVs were downloaded for an earlier strategy, and nobody kept them in
 * step with config/pairs.ts afterwards.
 */
const FIXTURES: Record<string, () => Promise<{ default: string }>> = {
  'EUR/USD': () => import('../../fixtures/market/EURUSD_1H.csv?raw'),
  'GBP/USD': () => import('../../fixtures/market/GBPUSD_1H.csv?raw'),
  'USD/JPY': () => import('../../fixtures/market/USDJPY_1H.csv?raw'),
  'AUD/USD': () => import('../../fixtures/market/AUDUSD_1H.csv?raw'),
  'USD/CAD': () => import('../../fixtures/market/USDCAD_1H.csv?raw'),
  'GBP/JPY': () => import('../../fixtures/market/GBPJPY_1H.csv?raw'),
};

/**
 * What the backtest actually runs: pairs the scanner trades AND for which
 * candles exist. Derived from PAIRS rather than listed, so the backtest can
 * never again report a pair the live system does not trade — add one to
 * config/pairs.ts and it appears here by itself, drop one and it leaves.
 */
export const FIXTURE_PAIRS = PAIRS.filter((p) => p.symbol in FIXTURES).map((p) => ({
  symbol: p.symbol,
  load: FIXTURES[p.symbol]!,
}));

/**
 * Pairs the scanner trades that have NO fixture, so the backtest says nothing
 * about them. Reported on the page: an untested pair that is being traded is
 * exactly the thing a reader should be told, not something to leave implicit.
 */
export const UNTESTED_PAIRS: string[] = PAIRS.filter((p) => !(p.symbol in FIXTURES)).map((p) => p.symbol);

/** Fixtures that exist but are not traded — kept on disk, excluded from results. */
export const UNUSED_FIXTURES: string[] = Object.keys(FIXTURES).filter(
  (symbol) => !PAIRS.some((p) => p.symbol === symbol),
);

export type FixtureSymbol = string;

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
export function useBacktest(
  strategy: StrategyId,
  symbols: readonly string[],
  filters: BacktestFilters,
): BacktestState {
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
      backtest(strategy, candles.get(p.symbol)!, p.symbol, '1H', filters),
    );

    const all = [...candles.values()].flat();
    const span = all.length
      ? { from: Math.min(...all.map((c) => c.time)), to: Math.max(...all.map((c) => c.time)) }
      : null;

    return { status: 'READY' as const, error: null, results, portfolio: combine(results), span };
  }, [candles, error, strategy, symbols, filters]);
}

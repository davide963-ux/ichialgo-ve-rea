/**
 * The strategies, behind one interface.
 *
 * The engine, the backtest and the server-side scanner all need to run "a
 * strategy" without knowing which. Without this seam each of them would grow
 * a switch over strategy ids, and the three switches would drift — the page
 * would offer a strategy the scanner did not record, or the backtest would
 * measure one the engine could not run.
 *
 * Adding a strategy means adding a row here and nothing else.
 */
import {
  ICHIMOKU_STRATEGY,
  OANDA_BREAKOUT,
  OANDA_PULLBACK,
} from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { Candle } from '../marketData';
import { analyseIchimoku, minBars as ichimokuMinBars } from './ichimokuSignal';
import { analyseOandaBreakout, minBars as breakoutMinBars } from './oandaBreakout';
import { analyseOandaPullback, minBars as pullbackMinBars } from './oandaPullback';
import type { IchimokuLevel, IchimokuSignal, StrategyId } from './types';

export interface DetectorResult {
  signals: IchimokuSignal[];
  level: IchimokuLevel | null;
  reason: 'ok' | 'not-enough-bars';
}

export interface Detector {
  id: StrategyId;
  /** Short name for a tab or a chip. */
  name: string;
  /** Who wrote the rules. The distinction is the point of having both. */
  source: 'ichialgo' | 'OANDA';
  /** One sentence, for the panel under the name. */
  blurb: string;
  minBars(): number;
  analyse(
    candles: readonly Candle[],
    symbol: string,
    timeframe: Timeframe,
    detectedAt?: number,
  ): DetectorResult;
}

export const DETECTORS: Record<StrategyId, Detector> = {
  'ichimoku-kijun': {
    id: 'ichimoku-kijun',
    name: 'Kijun pullback (gated)',
    source: 'ichialgo',
    blurb:
      `Price clear of the Kumo pulls back into a band around Kijun-sen, and all ` +
      `${ICHIMOKU_STRATEGY.minScore} of 4 Ichimoku confirmations must agree or no signal is produced.`,
    minBars: () => ichimokuMinBars(),
    analyse: (candles, symbol, timeframe, detectedAt) => {
      const { signals, level, reason } = analyseIchimoku(
        candles,
        symbol,
        timeframe,
        ICHIMOKU_STRATEGY,
        detectedAt ?? Date.now(),
      );
      return { signals, level, reason };
    },
  },

  'oanda-pullback': {
    id: 'oanda-pullback',
    name: 'Tenkan/Kijun pullback',
    source: 'OANDA',
    blurb:
      'Price clear of the Kumo with Tenkan on the trade’s side, a pullback that reaches Tenkan or ' +
      'Kijun, and then a close back through Kijun on a candle of the trade’s own colour.',
    minBars: () => pullbackMinBars(),
    analyse: (candles, symbol, timeframe, detectedAt) =>
      analyseOandaPullback(candles, symbol, timeframe, OANDA_PULLBACK, detectedAt ?? Date.now()),
  },

  'oanda-breakout': {
    id: 'oanda-breakout',
    name: 'Kumo breakout',
    source: 'OANDA',
    blurb:
      'Price breaks through the Kumo after consolidation and the cloud 26 bars ahead turns the same ' +
      'way, with Chikou clear of its prior 26-period price.',
    minBars: () => breakoutMinBars(),
    analyse: (candles, symbol, timeframe, detectedAt) =>
      analyseOandaBreakout(candles, symbol, timeframe, OANDA_BREAKOUT, detectedAt ?? Date.now()),
  },
};

export const STRATEGY_IDS = Object.keys(DETECTORS) as StrategyId[];

export const DEFAULT_STRATEGY: StrategyId = 'ichimoku-kijun';

export const isStrategyId = (v: unknown): v is StrategyId =>
  typeof v === 'string' && v in DETECTORS;

export const detectorFor = (id: StrategyId): Detector => DETECTORS[id];

/**
 * Public entry point of the strategy layer.
 * UI code imports from here — never from the detector directly.
 */
export { strategyEngine, StrategyEngine, candlesAreDue, mergeSignals } from './StrategyEngine';
export {
  ICHIMOKU_SIGNAL_CHECKS,
  analyseIchimoku,
  checkLiveTouch,
  ichimokuSignalId,
  minBars,
  rangeOver,
  signalTimeMs,
} from './ichimokuSignal';
export type { IchimokuAnalysis } from './ichimokuSignal';
export { backtestIchimoku, combine, equityCurve, measure, pipsOf, resolveBar } from './backtest';
export type { BacktestExit, BacktestFilters, BacktestMetrics, BacktestResult, BacktestTrade, Portfolio } from './backtest';
export { explainLines, explainSignal, scoreLabel } from './explain';
export type { Check } from './explain';
export { signalMarkers } from './chartMarkers';
export type { TouchMarker } from './chartMarkers';
export { calculatorLink, planFromSignal, ticketLevels } from './tradePlan';
export type { TicketLevels, TradePlan } from './tradePlan';
export type { Direction, IchimokuLevel, IchimokuSignal, Kumo, StrategyId } from './types';

/**
 * Public entry point of the strategy layer.
 * UI code imports from here — never from a detector directly.
 */
export { strategyEngine, StrategyEngine, candlesAreDue, mergeSignals } from './StrategyEngine';
export {
  DEFAULT_STRATEGY,
  DETECTORS,
  STRATEGY_IDS,
  detectorFor,
  isStrategyId,
} from './detectors';
export type { Detector, DetectorResult } from './detectors';
export { ICHIMOKU_SIGNAL_CHECKS, analyseIchimoku, checkLiveTouch, ichimokuSignalId, minBars, rangeOver } from './ichimokuSignal';
export type { IchimokuAnalysis } from './ichimokuSignal';
export { analyseOandaPullback } from './oandaPullback';
export { analyseOandaBreakout } from './oandaBreakout';
export { ichimokuContext, minBarsFor } from './ichimokuBars';
export { futureCloudZone, zoneStrength } from './cloudZones';
export { buildSignal, requiredPassed, signalId, signalTimeMs } from './signalTicket';
export { backtest, combine, equityCurve, measure, pipsOf, resolveBar } from './backtest';
export type { BacktestExit, BacktestFilters, BacktestMetrics, BacktestResult, BacktestTrade, Portfolio } from './backtest';
export { signalMarkers } from './chartMarkers';
export type { TouchMarker } from './chartMarkers';
export { calculatorLink, planFromSignal, ticketLevels } from './tradePlan';
export type { TicketLevels, TradePlan } from './tradePlan';
export type {
  CloudZone,
  Direction,
  IchimokuLevel,
  IchimokuSignal,
  Kumo,
  SignalCheck,
  StrategyId,
} from './types';

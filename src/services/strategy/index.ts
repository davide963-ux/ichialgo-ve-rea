/**
 * Public entry point of the strategy layer.
 * UI code imports from here — never from the detector directly.
 */
export { strategyEngine, StrategyEngine, candlesAreDue, mergeSignals } from './StrategyEngine';
export { analyseIchimoku, ichimokuSignalId, minBars, rangeOver, STRATEGY } from './ichimokuSystem';
export type { IchimokuAnalysis } from './ichimokuSystem';
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
  EntryType,
  IchimokuLevel,
  IchimokuSignal,
  Kumo,
  SignalCheck,
  StrategyId,
} from './types';

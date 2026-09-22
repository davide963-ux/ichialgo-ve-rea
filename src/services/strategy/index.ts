/**
 * The strategy layer's public surface.
 *
 * Everything outside `src/services/strategy/` imports from here and nowhere
 * deeper. That is what keeps the strategy replaceable: the scanner, the
 * backtest and the UI depend on this barrel, not on whichever engine happens
 * to be behind it.
 */
export { analyse, hasEnoughBars, MIN_BARS, NO_STRATEGY_REASON } from './analyse';
export {
  directionOf,
  isActionable,
  isOpportunity,
  tierFor,
  TIER_LABEL,
  TIER_THRESHOLDS,
  type AnalyseOptions,
  type Direction,
  type RiskTicket,
  type SetupStatus,
  type SignalTier,
  type StrategyAnalysis,
} from './contract';
export {
  SetupTracker,
  setupKey,
  type EmitReason,
  type TrackedSetup,
  type TrackerDecision,
  type TrackerOptions,
} from './lifecycle';
export {
  runBacktest,
  resolveBar,
  rMultipleOf,
  type BacktestExit,
  type BacktestOptions,
  type BacktestResult,
  type BacktestTrade,
} from './backtest';
export {
  buildReport,
  computeMetrics,
  groupBy,
  regimeFamily,
  signalStrength,
  MIN_RELIABLE_TRADES,
  type Group,
  type MeasuredTrade,
  type Metrics,
  type PerformanceReport,
  type TradeOutcome,
} from './performance';

/**
 * Public entry point of the strategy layer.
 * UI code imports from here — never from the detector directly.
 */
export { strategyEngine, StrategyEngine, mergeSignals } from './StrategyEngine';
export { analyseEma50Touch, checkLiveTouch, signalId, touchTimeMs } from './ema50Touch';
export type { TouchAnalysis } from './ema50Touch';
export { calculatorLink, directionOf, planFromTouch } from './tradePlan';
export type { TradePlan } from './tradePlan';
export type { Approach, Bias, StrategyId, TouchOutcome, TouchSignal, Trend, WatchLevel } from './types';

/**
 * Ichimoku + EMA50 confluence analysis.
 *
 * One entry point: `analyseConfluence(candles, options)`. Everything else here
 * is exported for tests and for the UI's explanation rendering — callers
 * outside this folder should not need the individual stages.
 */
export { analyseConfluence } from './analyse';
export type { AnalyseOptions } from './analyse';
export { gradeSignal, isActionable, scoreSetup } from './scoring';
export type { GateInput, ScoreInput, ScoreResult } from './scoring';
export { ZONE_RANK, classifyCloud, classifyRegime, gradeSlope, gradeZone, regimeBias } from './states';
export { analysePullback, findConfirmation, findImpulse } from './pullback';
export type { ConfirmationRead, ImpulseLeg, PullbackRead } from './pullback';
export type {
  CloudStrength,
  ConfluenceAnalysis,
  ConfluenceBlock,
  ConfluenceSignal,
  Direction,
  Ema50Block,
  IchimokuBlock,
  MarketCondition,
  MultiTimeframeBlock,
  PullbackState,
  RiskBlock,
  ScoreReason,
  SetupBlock,
  SetupStatus,
  SlopeGrade,
  StructureBlock,
  ZoneStrength,
} from './types';

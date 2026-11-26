/**
 * Indicators. Ichimoku and nothing else.
 *
 * There used to be an EMA, an ATR and a swing-structure module here, left
 * over from the EMA50-touch strategy. The strategy is now pure Ichimoku, so
 * the others had no caller and are gone — an unused indicator that still
 * compiles is how an "EMA is only a confirmation" habit creeps back in.
 */
export {
  ICHIMOKU_DEFAULT,
  cloudIsBullish,
  donchianMid,
  futureCloud,
  ichimoku,
  kumoSide,
  kumoThickness,
  type IchimokuConfig,
  type IchimokuSeries,
  type KumoSide,
  type OHLC,
} from './ichimoku';

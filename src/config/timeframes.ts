/**
 * Timeframes the app offers.
 *
 * 1M/5M/15M were dropped: the EMA50 + Ichimoku setup needs 78 bars of warm-up
 * before it says anything, so on fast charts it spends most of its credits
 * re-reading noise, and a touch resolves before you could act on it. These
 * four also cost far less — a 30M chart refreshes half as often as a 15M one.
 */
export const TIMEFRAMES = ['30M', '1H', '4H', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '30M': 1800,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
};

export const DEFAULT_TIMEFRAME: Timeframe = '1H';

export const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);

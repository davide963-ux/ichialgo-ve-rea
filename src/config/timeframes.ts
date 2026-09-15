export const TIMEFRAMES = ['1M', '5M', '15M', '30M', '1H', '4H', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1M': 60,
  '5M': 300,
  '15M': 900,
  '30M': 1800,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
};

export const DEFAULT_TIMEFRAME: Timeframe = '15M';

export const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);

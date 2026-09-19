import type { ProviderId } from '../services/marketData/types';

export const APP_CONFIG = {
  /** Twelve Data is the only provider — see services/marketData/providers/index.ts. */
  provider: 'twelvedata' as ProviderId,
  /** Twelve Data free plan: 8 credits/min PER KEY, 1 credit per symbol. Never poll faster than 15s. */
  twelveDataPollMs: Math.max(15_000, Number(import.meta.env.VITE_TWELVEDATA_POLL_MS ?? 60_000) || 60_000),
  /** Plan limits PER KEY (free Basic: 8/min, 800/day). Set per-day to 0 for "no daily cap". */
  twelveDataCreditsPerMinute: Math.max(1, Number(import.meta.env.VITE_TWELVEDATA_CREDITS_PER_MINUTE ?? 8) || 8),
  twelveDataCreditsPerDay: Math.max(0, Number(import.meta.env.VITE_TWELVEDATA_CREDITS_PER_DAY ?? 800) || 0),
  /** Candles requested for the detail chart. */
  chartCandleCount: 300,
} as const;

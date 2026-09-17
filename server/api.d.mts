import type { IncomingMessage, ServerResponse } from 'node:http';

export interface MarketDataApi {
  middleware: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  config: {
    oanda: { token: string; accountId: string; env: 'practice' | 'live'; rest: string; stream: string };
    yahoo: { rest: string };
    twelvedata: { keys: string[]; creditsPerMinute: number; creditsPerDay: number; rest: string };
  };
}
export function createMarketDataApi(env?: Record<string, string | undefined>): MarketDataApi;

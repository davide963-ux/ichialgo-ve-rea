import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HistoryApi {
  middleware: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  /** The paths this middleware answers, for tests and for logging. */
  routes: string[];
}
export function createHistoryApi(): HistoryApi;

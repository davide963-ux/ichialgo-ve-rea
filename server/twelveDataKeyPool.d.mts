/**
 * Types for the key pool, which is plain .mjs so that server/index.mjs and the
 * .js serverless entry points can import it without a build step.
 */
export type PoolOutcome = 'ok' | 'exhausted' | 'auth' | 'error';

export interface KeyLease {
  index: number;
  apiKey: string;
  /** Masked suffix — the key itself is never logged. */
  label: string;
}

export interface PoolSnapshot {
  size: number;
  usedToday: number;
  retryAfterMs: number;
  keys: { label: string; usedToday: number; usedThisMinute: number; cooldownUntil: number | null }[];
}

export declare class TwelveDataKeyPool {
  constructor(options: { keys: string[]; perMinute: number; perDay: number; now?: () => number });
  readonly size: number;
  /** The first key with credits for `cost`, or null when every key is spent. */
  acquire(cost?: number): KeyLease | null;
  spend(index: number, cost?: number): void;
  penalize(index: number, outcome: PoolOutcome, message?: string): void;
  reportSuccess(index: number): void;
  retryAfterMs(): number;
  snapshot(): PoolSnapshot;
}

export declare function readApiKeys(env?: Record<string, string | undefined>): string[];
export declare function classifyResponse(httpStatus: number, body: unknown): PoolOutcome;
export declare function cooldownFor(outcome: PoolOutcome): number;

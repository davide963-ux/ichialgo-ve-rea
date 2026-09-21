/**
 * HTTP wrapper for the scanner.
 *
 *   cron service ──GET /api/scanner, x-scanner-token: …──▶ here
 *
 * WHY A HEADER TOKEN AND NOT VERCEL'S CRON AUTH
 * ─────────────────────────────────────────────
 * A plain shared secret in a header works with ANY trigger: Vercel Cron,
 * cron-job.org, EasyCron, a GitHub Action, or curl from a laptop. That matters
 * because Vercel's own scheduler is limited on the Hobby plan, so the trigger
 * has to be swappable without touching code.
 *
 * The endpoint is a GET because most free cron services only send GETs. It
 * writes, which a GET conventionally should not — the token is what stops that
 * being a problem, along with the interval guard that makes a repeated call
 * a no-op rather than a duplicate scan.
 */
import { createSignalsDb, isDbConfigured, readDbConfig } from './signalsDb';
import { DEFAULT_SCANNER_CONFIG, analyseOne, runScan, type ScannerConfig } from './scannerCore';
import { TwelveDataFeed } from './scannerFeed';

export interface ScannerHttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ScannerHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export interface HandlerOptions {
  env?: Record<string, string | undefined>;
  config?: ScannerConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const json = (res: ScannerHttpResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const header = (req: ScannerHttpRequest, name: string): string => {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
};

/**
 * Constant-time-ish comparison.
 *
 * Length is compared first and the loop always runs to completion, so the
 * timing does not leak how much of the token was correct. Not a hardware
 * guarantee, but it removes the trivially exploitable version.
 */
function tokenMatches(given: string, expected: string): boolean {
  if (expected.length === 0 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function createScannerHandler(options: HandlerOptions = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? DEFAULT_SCANNER_CONFIG;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  return async function handler(req: ScannerHttpRequest, res: ScannerHttpResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    const secret = (env.SCANNER_TOKEN || '').trim();
    if (!secret) {
      return json(res, 503, {
        error: 'NOT_CONFIGURED',
        errorMessage: 'Set SCANNER_TOKEN before the scanner can run.',
        configured: false,
      });
    }
    if (!tokenMatches(header(req, 'x-scanner-token'), secret)) {
      return json(res, 401, { error: 'UNAUTHORIZED' });
    }

    const dbConfig = readDbConfig(env);
    if (!isDbConfigured(dbConfig)) {
      return json(res, 503, {
        error: 'NOT_CONFIGURED',
        errorMessage: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY before the scanner can run.',
        configured: false,
      });
    }

    const feed = TwelveDataFeed.fromEnv(env, fetchImpl);
    if (feed.keyCount === 0) {
      return json(res, 503, {
        error: 'NOT_CONFIGURED',
        errorMessage: 'No Twelve Data API keys configured.',
        configured: false,
      });
    }

    const url = new URL(req.url || '/', 'http://scanner.local');
    const db = createSignalsDb(dbConfig, fetchImpl);

    // A dry run analyses one pair and returns the full structured result
    // without writing anything — the way to see WHY a pair is or is not
    // signalling, without waiting for a scheduled run.
    const dry = url.searchParams.get('dry');
    if (dry) {
      const timeframe = url.searchParams.get('tf') || config.timeframes[0] || '1H';
      try {
        const analysis = await analyseOne(feed, dry, timeframe, config.outputSize);
        return json(res, 200, { dry: true, creditsUsed: feed.creditsUsed(), analysis });
      } catch (err) {
        return json(res, 502, { error: 'FEED_ERROR', errorMessage: (err as Error).message });
      }
    }

    try {
      const result = await runScan({
        db,
        feed,
        config,
        now,
        force: url.searchParams.get('force') === '1',
      });
      return json(res, result.ok ? 200 : 500, { ...result, at: new Date(now()).toISOString() });
    } catch (err) {
      return json(res, 500, { error: 'SCAN_FAILED', errorMessage: (err as Error).message });
    }
  };
}

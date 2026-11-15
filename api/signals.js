/**
 * GET /api/signals — the stored signal history, for the history page.
 *
 *   ?limit=200          how many rows, capped at 1000
 *   ?symbol=EUR/USD     one pair, or omit for all
 *   ?stats=1            per-pair totals instead of rows
 *
 * Read-only and unauthenticated, like the rest of the app's data routes: it
 * serves this project's own observations about public price data, and the
 * write path is the one behind a token.
 *
 * When no database is configured this returns an empty history with
 * `configured: false` rather than an error, so the page can say "no history
 * yet" instead of showing a failure for a feature that simply is not set up.
 */
import { isConfigured, recentSignals, signalStats } from '../server/db.mjs';

export const config = { api: { bodyParser: false } };

function send(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, stale-while-revalidate=60` : 'no-store',
  );
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED', errorMessage: 'GET only.' });
  }
  if (!isConfigured()) {
    return send(res, 200, { configured: false, signals: [], stats: [] });
  }

  const url = new URL(req.url, 'http://localhost');
  const symbol = url.searchParams.get('symbol');
  const limit = url.searchParams.get('limit');

  try {
    if (url.searchParams.get('stats')) {
      return send(res, 200, { configured: true, stats: await signalStats() }, 30);
    }
    // 30s: a new bar closes every 30 minutes at the fastest, so this is
    // fresh enough while keeping a reload off the database.
    const signals = await recentSignals({ limit: limit ?? 200, symbol: symbol || null });
    return send(res, 200, { configured: true, signals }, 30);
  } catch (err) {
    return send(res, 502, { error: 'DB_ERROR', errorMessage: err?.message || String(err) });
  }
}

/**
 * POST /api/scan — run one scan and write what it finds to the database.
 *
 * Called by .github/workflows/scan.yml on a schedule, because Vercel's Hobby
 * plan allows one cron firing a day and a 30-minute strategy needs better.
 * Any trigger that can send an authenticated POST will do; nothing here
 * depends on which one, or on it being punctual.
 *
 * A STATIC file, not a [...path] folder: this route has no path segment after
 * the prefix, and a catch-all requires at least one — the mistake that made
 * /api/yahoo-chart 404 in production once.
 */
import { isConfigured } from '../server/db.mjs';
import { runScan } from '../server/scanner.mjs';

export const config = { api: { bodyParser: false } };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED', errorMessage: 'POST only.' });
  }

  /**
   * The token is required, and a deployment without one refuses every call
   * rather than defaulting to open. An unauthenticated scan endpoint is a
   * free way for anyone to spend this project's Yahoo goodwill and fill its
   * database.
   */
  const expected = process.env.SCANNER_TOKEN?.trim();
  if (!expected) {
    return send(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'SCANNER_TOKEN is not set.' });
  }
  const offered = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (offered !== expected) {
    return send(res, 401, { error: 'UNAUTHORIZED', errorMessage: 'Bad or missing scanner token.' });
  }

  if (!isConfigured()) {
    return send(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'DATABASE_URL is not set.' });
  }

  try {
    const summary = await runScan({});
    // A run where every pair failed is a failure, even though the route
    // itself worked — the trigger should be able to see that without parsing
    // the body, so it gets a 502.
    return send(res, summary.ok ? 200 : 502, summary);
  } catch (err) {
    return send(res, 500, { error: 'SCAN_FAILED', errorMessage: err?.message || String(err) });
  }
}

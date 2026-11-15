/**
 * POST /api/scan — run one scan and write what it finds to the database.
 *
 * Called by .github/workflows/scan.yml on a schedule, because Vercel's Hobby
 * plan allows one cron firing a day and a 30-minute strategy needs better.
 *
 * AUTHENTICATION NEEDS NO SETUP
 * ─────────────────────────────
 * The workflow proves who it is with a GitHub OIDC token minted for that run,
 * so there is no shared secret to create, paste into two places, keep in step
 * or rotate. `SCANNER_TOKEN` still works if one is configured, for driving
 * the endpoint from anything that is not GitHub Actions.
 *
 * See server/scanAuth.mjs — the decision lives there rather than here because
 * nothing imports this file, so nothing can test it. Vercel treats api/*.js
 * as route entry points only.
 *
 * A STATIC file, not a [...path] folder: this route has no path segment after
 * the prefix, and a catch-all requires at least one — the mistake that made
 * /api/yahoo-chart 404 in production once.
 */
import { isConfigured } from '../server/db.mjs';
import { runScan } from '../server/scanner.mjs';
import { authoriseScan } from '../server/scanAuth.mjs';

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

  const allowed = await authoriseScan(req.headers, process.env);
  if (!allowed.ok) {
    // The reason goes to the server log, not to the caller: telling an
    // unauthenticated client which check failed only helps them past it.
    console.warn(`/api/scan refused — ${allowed.reason}`);
    return send(res, 401, {
      error: 'UNAUTHORIZED',
      errorMessage:
        'Not authorised. Call this from the repository\'s own GitHub Actions workflow, ' +
        'or send a bearer token matching SCANNER_TOKEN.',
    });
  }

  if (!isConfigured()) {
    return send(res, 503, { error: 'NOT_CONFIGURED', errorMessage: 'DATABASE_URL is not set.' });
  }

  try {
    const summary = await runScan({});
    // A run where every pair failed is a failure, even though the route
    // itself worked — the trigger should be able to see that without parsing
    // the body, so it gets a 502.
    return send(res, summary.ok ? 200 : 502, { ...summary, authenticatedVia: allowed.via });
  } catch (err) {
    return send(res, 500, { error: 'SCAN_FAILED', errorMessage: err?.message || String(err) });
  }
}

/**
 * Vercel serverless entry point for /api/scanner.
 *
 * A STATIC .ts file, not a [...path] folder: the route is the bare
 * /api/scanner, and a catch-all needs at least one path segment. This is the
 * same shape rule that broke /api/yahoo-chart twice; server/api.routes.test.mjs
 * and server/vercelConfig.test.mjs both guard it.
 *
 * TypeScript rather than .mjs because the strategy engine is TypeScript and
 * there must be exactly one copy of it. Vercel's Node runtime compiles .ts
 * functions, so the engine, the backtest and the scanner all run the same code.
 */
import { createScannerHandler } from '../server/scannerHttp';

export const config = {
  // A full scan is several sequential Twelve Data requests; the default 15s
  // is not enough once a few pairs are in play.
  maxDuration: 60,
};

const handler = createScannerHandler();

export default handler;

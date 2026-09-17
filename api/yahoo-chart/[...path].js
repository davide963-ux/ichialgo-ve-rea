/**
 * Vercel serverless entry point for GET /api/yahoo-chart.
 *
 * Vercel's functions are FILE-BASED: a route that exists in server/api.mjs but
 * has no file here simply 404s in production, while working locally because
 * Vite serves every route through the shared middleware. Every /api/<prefix>
 * the proxy answers needs a matching folder — see api.routes.test.mjs, which
 * fails the build if one is missing.
 */
export { default, config } from '../_lib/handler.mjs';

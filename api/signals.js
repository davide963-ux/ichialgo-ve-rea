/**
 * Vercel serverless entry point for /api/signals (GET history, POST ingest).
 *
 * A STATIC file, not a [...path] folder: the route is the bare /api/signals,
 * and a catch-all needs at least one path segment. See
 * server/api.routes.test.mjs, which derives the required shape from the route
 * regexes and fails if the two disagree.
 */
export { default, config } from './_lib/handler.mjs';

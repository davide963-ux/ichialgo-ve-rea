/**
 * Vercel serverless entry point for GET /api/yahoo-chart.
 *
 * A STATIC file, not a [...path] folder like the other routes, because this
 * route has no path segment after the prefix — the symbol travels in the
 * query string. A catch-all requires at least one segment, so
 * api/yahoo-chart/[...path].js serves /api/yahoo-chart/anything but NOT
 * /api/yahoo-chart itself, which is how this 404'd in production.
 *
 * server/api.routes.test.mjs derives the required shape from the route
 * regexes in server/api.mjs and fails if a route and its file disagree.
 */
export { default, config } from './_lib/handler.mjs';

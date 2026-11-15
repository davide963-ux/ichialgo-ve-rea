/**
 * Mounts the signal-history routes for local development and `npm start`.
 *
 * On Vercel, api/signals.js and api/scan.js ARE the routes — the platform
 * turns each file into a function. Nothing mounts them, so locally they would
 * not exist at all, and the market-data proxy answers anything it does not
 * recognise with a 403. That is how a route can work in dev and 404 in
 * production, or the reverse; this project has already shipped that bug once.
 *
 * So this imports those exact files rather than re-implementing them. There
 * is one handler per route and both environments run it.
 *
 * The imports are DYNAMIC on purpose. api/scan.js reaches
 * server/strategy.bundle.mjs, which is generated during the build; importing
 * it eagerly would mean a missing bundle stops the whole dev server from
 * starting instead of failing the one route that needs it.
 */
const ROUTES = {
  '/api/signals': () => import('../api/signals.js'),
  '/api/scan': () => import('../api/scan.js'),
};

export function createHistoryApi() {
  function middleware(req, res, next) {
    const path = (req.url || '').split('?')[0];
    const load = ROUTES[path];
    if (!load) return next();

    load()
      .then((mod) => mod.default(req, res))
      .catch((err) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: 'ROUTE_LOAD_FAILED',
            errorMessage:
              `${path} could not start: ${err?.message || err}. ` +
              'If this names strategy.bundle.mjs, run `npm run bundle:strategy`.',
          }),
        );
      });
  }
  return { middleware, routes: Object.keys(ROUTES) };
}

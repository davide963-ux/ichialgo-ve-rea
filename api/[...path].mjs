/**
 * Vercel serverless entry point for the market-data proxy.
 *
 * Vercel doesn't run server/index.mjs as a persistent process — instead every
 * file under /api becomes its own function. This catch-all route reuses the
 * exact same createMarketDataApi() middleware that dev/preview/npm start use,
 * so the allowlist, error mapping, and credential handling are identical.
 */
import { createMarketDataApi } from '../server/api.mjs';

const api = createMarketDataApi(process.env);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  api.middleware(req, res, () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'NOT_FOUND', errorMessage: 'No such proxy route.' }));
  });
}

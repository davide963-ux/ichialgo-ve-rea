/**
 * Shared Vercel serverless handler factory for the market-data proxy.
 *
 * Files starting with an underscore are never turned into their own Function
 * by Vercel, so this module is safe to import from the three route entry
 * points (api/oanda-rest, api/oanda-stream, api/td-rest) without becoming a
 * fourth, unwanted route itself.
 */
import { createMarketDataApi } from '../../server/api.mjs';

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

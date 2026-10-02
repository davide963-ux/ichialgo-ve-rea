/**
 * Production server: built UI (dist/) + read-only market-data proxy.
 *   npm run build && npm start
 *
 * Binds to 127.0.0.1 by default. The proxy holds your Twelve Data API keys,
 * so only expose it publicly behind authentication (VPN, basic auth, etc).
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMarketDataApi } from './api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';

const api = createMarketDataApi(process.env);
const app = express();
app.disable('x-powered-by');
app.use(api.middleware);
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html'))); // SPA fallback

app.listen(port, host, () => {
  const { twelvedata } = api.config;
  const n = twelvedata.keys.length;
  console.log(`Ichialgo → http://${host}:${port}`);
  console.log(
    `Twelve Data: ${n === 0 ? 'not configured' : `${n} API key${n > 1 ? 's' : ''} pooled ` +
      `(${twelvedata.creditsPerMinute * n} credits/min, ` +
      `${twelvedata.creditsPerDay ? `${twelvedata.creditsPerDay * n}/day` : 'no daily cap'})`}`,
  );
});

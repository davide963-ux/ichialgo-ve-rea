/**
 * Vite config. The market-data proxy lives in server/api.mjs and is shared
 * with the production server, so dev, preview and prod behave identically.
 * See server/api.mjs for why the proxy exists and what it allows.
 */
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createMarketDataApi } from './server/api.mjs';

function marketDataProxy(env: Record<string, string>): Plugin {
  const api = createMarketDataApi(env);
  return {
    name: 'ichialgo-market-data-proxy',
    // Registered before Vite's own middlewares, so /api/* never hits the SPA fallback.
    configureServer: (server) => void server.middlewares.use(api.middleware),
    configurePreviewServer: (server) => void server.middlewares.use(api.middleware),
  };
}

export default defineConfig(({ mode }) => {
  // '' prefix loads ALL vars – they stay in this Node process, never in the bundle.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), marketDataProxy(env)],
    server: { port: 5173 },
    preview: { port: 4173 },
  };
});

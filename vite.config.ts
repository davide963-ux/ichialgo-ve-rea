/**
 * Vite config. The market-data proxy lives in server/api.mjs and is shared
 * with the production server, so dev, preview and prod behave identically.
 * See server/api.mjs for why the proxy exists and what it allows.
 */
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createMarketDataApi } from './server/api.mjs';
import { createScannerHandler } from './server/scannerHttp';

/**
 * Mounts /api/scanner in dev and preview.
 *
 * It is a separate plugin from the market-data proxy because the scanner is
 * TypeScript (it shares the strategy engine with the app, and there must be
 * exactly one copy of that) while server/api.mjs is plain .mjs so that the
 * .js serverless entry points and `npm start` can import it without a build.
 *
 * On Vercel the same handler is api/scanner.ts. `npm start` does not mount it:
 * server/index.mjs runs under plain Node, which cannot load TypeScript. That
 * is a real gap — use `npm run dev` to exercise the scanner locally.
 */
function scanner(env: Record<string, string>): Plugin {
  const handler = createScannerHandler({ env });
  const mount = (server: { middlewares: { use: (fn: unknown) => void } }) =>
    server.middlewares.use((req: { url?: string }, res: unknown, next: () => void) => {
      const path = (req.url || '').split('?')[0];
      if (path !== '/api/scanner') return next();
      void handler(req as never, res as never);
    });
  return {
    name: 'ichialgo-scanner',
    configureServer: (s) => void mount(s as never),
    configurePreviewServer: (s) => void mount(s as never),
  };
}

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
    plugins: [react(), scanner(env), marketDataProxy(env)],
    server: { port: 5173 },
    preview: { port: 4173 },
  };
});

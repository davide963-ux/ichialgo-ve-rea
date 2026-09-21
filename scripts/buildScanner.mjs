/**
 * Bundle the scanner into one file for the serverless runtime.
 *
 * WHY THIS EXISTS
 * ───────────────
 * package.json declares "type": "module", so a Vercel function runs as pure
 * Node ESM — where every import specifier must be a real, extension-bearing
 * path. The scanner's code reaches into src/, and the whole browser codebase
 * imports extensionlessly ("./analyse"), which Vite resolves at build time and
 * Node does not resolve at all:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '.../server/signalsDb'
 *
 * That surfaced as FUNCTION_INVOCATION_FAILED with no message. Rewriting ~30
 * imports across the app to carry extensions would fix it, at the cost of
 * making the browser code carry a constraint that only the server has.
 * Bundling removes the question instead: after this, the function has no
 * runtime imports left to resolve.
 *
 * The output goes under api/_lib/ because Vercel never turns an underscore-
 * prefixed file into a route, and anything inside api/ is definitely included
 * in the function. It is generated, so it is gitignored — `npm run build`
 * produces it, and Vercel runs that before it builds functions.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('api/_lib', { recursive: true });

const result = await build({
  entryPoints: ['server/scannerHttp.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'api/_lib/scanner.bundle.mjs',
  // Keep node built-ins external; everything of ours is inlined.
  packages: 'bundle',
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`scanner bundle: api/_lib/scanner.bundle.mjs (${(bytes / 1024).toFixed(1)} kB)`);

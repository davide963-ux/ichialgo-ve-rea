/**
 * Vercel serverless entry point for /api/scanner.
 *
 * A STATIC .js file, not .ts and not a [...path] folder:
 *
 *   - the route is the bare /api/scanner, and a catch-all needs at least one
 *     path segment;
 *   - it imports a PRE-BUNDLED module rather than reaching into src/. This
 *     package is "type": "module", so a function runs as pure Node ESM where
 *     every specifier must carry a real extension. The app's own imports are
 *     extensionless ("./analyse") because Vite resolves them at build time;
 *     Node does not, and a .ts entry point importing that graph died with
 *     ERR_MODULE_NOT_FOUND — reported by Vercel only as
 *     FUNCTION_INVOCATION_FAILED, with no message anywhere in the response.
 *
 * scripts/buildScanner.mjs produces the bundle during `npm run build`, which
 * Vercel runs before it builds functions.
 *
 * The dynamic import and the catch are deliberate and stay. A static import
 * that fails to resolve kills the function before any of our code runs, which
 * is precisely how this became undiagnosable from outside. Now any such
 * failure answers with its own error message.
 */
export const config = {
  // A full scan is several sequential Twelve Data requests.
  maxDuration: 60,
};

export default async function handler(req, res) {
  try {
    const { createScannerHandler } = await import('./_lib/scanner.bundle.mjs');
    return await createScannerHandler()(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        {
          error: 'SCANNER_BOOT_FAILED',
          name: err?.name ?? null,
          code: err?.code ?? null,
          message: err?.message ?? String(err),
          stack: String(err?.stack ?? '').split('\n').slice(0, 6),
        },
        null,
        2,
      ),
    );
  }
}

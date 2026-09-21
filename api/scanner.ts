/**
 * Vercel serverless entry point for /api/scanner.
 *
 * A STATIC .ts file, not a [...path] folder: the route is the bare
 * /api/scanner, and a catch-all needs at least one path segment.
 *
 * WHY THE IMPORT IS DYNAMIC AND WRAPPED
 * ─────────────────────────────────────
 * A static import that fails to resolve kills the function before any of our
 * code runs, and Vercel reports only FUNCTION_INVOCATION_FAILED — no message,
 * no stack, nothing in the response. That is exactly what happened here, and
 * with no access to the runtime logs it was undiagnosable from outside.
 *
 * Importing inside the handler makes a resolution failure CATCHABLE, so the
 * endpoint answers with the real error instead of a blank 500. The cost is one
 * dynamic import on a cold start; the benefit is that this endpoint can never
 * again fail in a way you cannot see from a browser.
 */
export const config = {
  // A full scan is several sequential Twelve Data requests; the default 15s
  // is not enough once a few pairs are in play.
  maxDuration: 60,
};

interface Req {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  try {
    const { createScannerHandler } = await import('../server/scannerHttp');
    return await createScannerHandler()(req as never, res as never);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stack?: string };
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        {
          error: 'SCANNER_BOOT_FAILED',
          name: e.name,
          code: e.code ?? null,
          message: e.message,
          // First few frames only: enough to name the module that failed
          // without dumping the whole runtime into an HTTP response.
          stack: (e.stack ?? '').split('\n').slice(0, 6),
        },
        null,
        2,
      ),
    );
  }
}

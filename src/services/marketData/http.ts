/**
 * Shared fetch wrapper: timeout + HTTP status → ProviderError mapping.
 * Providers add their own body-level error parsing on top.
 */
import { ProviderError, isAbort } from './types';

const DEFAULT_TIMEOUT_MS = 12_000;

export async function fetchJson<T>(url: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, { signal: combined, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (isAbort(err) && signal?.aborted) throw err; // caller cancelled — propagate as-is
    if (timeout.aborted) throw new ProviderError('network', 'Market data request timed out');
    throw new ProviderError('network', 'Cannot reach market data server');
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (e.g. proxy HTML error page) */
  }

  if (!res.ok) {
    const parsedMessage = extractMessage(body);
    const message = parsedMessage ?? `HTTP ${res.status}`;
    const code = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    // Our own proxy's answers (server/api.mjs)
    if (code === 'NOT_CONFIGURED') throw new ProviderError('config', message);
    if (code === 'FORBIDDEN_PATH' || code === 'METHOD_NOT_ALLOWED') throw new ProviderError('config', message);
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', message);
    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After'));
      throw new ProviderError('rate_limit', message, { retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000 });
    }
    if (res.status === 400 || res.status === 404) {
      // A provider (OANDA/Twelve Data) error always carries errorMessage/message in its
      // body. A 400/404 with NO such body never came from them — the request didn't
      // reach server/api.mjs at all (wrong host, static-only deploy, serverless
      // function not built), so the host's own bare 404/400 page is what we're seeing.
      if (!parsedMessage) {
        throw new ProviderError(
          'config',
          `Market data route returned HTTP ${res.status} with no provider error body — the /api proxy is not reachable on this host. Check that api/[...path].mjs deployed as a serverless function (or that npm start is running) and that requests aren't being rewritten to index.html.`,
        );
      }
      throw new ProviderError('invalid_symbol', message);
    }
    if (res.status === 502 || res.status === 504) throw new ProviderError('network', 'Market data proxy could not reach the provider');
    throw new ProviderError('provider', message);
  }
  if (body === null) {
    // An HTML page here means the request hit the SPA fallback instead of the proxy.
    if (text.trimStart().startsWith('<')) {
      throw new ProviderError('config', 'Market data proxy is not running. Start the app with `npm run dev` or configure your server proxy.');
    }
    throw new ProviderError('provider', 'Provider returned an empty or invalid response');
  }
  return body as T;
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.errorMessage === 'string') return b.errorMessage; // OANDA
    if (typeof b.message === 'string') return b.message; // Twelve Data
  }
  return undefined;
}

export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

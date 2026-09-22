/**
 * The scanner's front door.
 *
 * Every one of these branches runs BEFORE any market data is touched, and
 * each is a different operational fault with a different fix. Until now none
 * of them was covered, and the cost showed: a misconfigured cron job spent an
 * afternoon returning 401 with no way to tell which mistake it was making.
 *
 * These tests exist so the refusals stay honest — in particular so the 401
 * hint keeps distinguishing "no header" from "wrong length" from "wrong
 * value", and keeps leaking nothing beyond that.
 */
import { describe, expect, it } from 'vitest';
import { createScannerHandler, type ScannerHttpRequest, type ScannerHttpResponse } from './scannerHttp';

const TOKEN = 'correct-horse-battery-staple';

/** Minimal stand-in for Vercel's response object. */
function capture() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body = '') {
      this.body = body;
    },
  };
  return res as ScannerHttpResponse & typeof res;
}

/**
 * Enough env to get PAST the configuration gates, so a test that means to
 * exercise auth is not silently answered by a 503 instead.
 */
const CONFIGURED = {
  SCANNER_TOKEN: TOKEN,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  TWELVEDATA_API_KEYS: 'key-one',
};

async function call(
  env: Record<string, string | undefined>,
  headers: Record<string, string | undefined> = {},
  url = '/api/scanner',
) {
  const req: ScannerHttpRequest = { method: 'GET', url, headers };
  const res = capture();
  // A fetch that throws: nothing here should ever reach the network. If a
  // refusal regressed into letting the request through, this makes it loud.
  const fetchImpl = (() => {
    throw new Error('no request should reach the network in these tests');
  }) as unknown as typeof fetch;
  await createScannerHandler({ env, fetchImpl })(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), headers: res.headers };
}

describe('the scanner refuses unconfigured deployments before anything else', () => {
  it('reports a missing SCANNER_TOKEN as configuration, not as a bad password', async () => {
    // 503 rather than 401 is the whole point: it tells the operator the
    // variable is absent from THIS deployment, which no amount of retrying
    // the token would reveal.
    const { status, body } = await call({ ...CONFIGURED, SCANNER_TOKEN: '' });
    expect(status).toBe(503);
    expect(body.error).toBe('NOT_CONFIGURED');
    expect(body.errorMessage).toMatch(/SCANNER_TOKEN/);
  });

  it('names the database variables when they are the ones missing', async () => {
    const { status, body } = await call(
      { ...CONFIGURED, SUPABASE_SERVICE_KEY: '' },
      { 'x-scanner-token': TOKEN },
    );
    expect(status).toBe(503);
    expect(body.errorMessage).toMatch(/SUPABASE/);
  });

  it('checks the token before the database, so a stranger learns nothing about config', async () => {
    const { status, body } = await call({ ...CONFIGURED, SUPABASE_URL: '' }, { 'x-scanner-token': 'wrong' });
    expect(status).toBe(401);
    expect(body.errorMessage).toBeUndefined();
  });
});

describe('the 401 says which mistake was made', () => {
  it('distinguishes a header that never arrived', async () => {
    const { status, body } = await call(CONFIGURED, {});
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: 'UNAUTHORIZED', headerPresent: false, lengthMatch: false });
  });

  it('flags a trailing newline as a length problem, not a wrong secret', async () => {
    // The single most common paste error, and indistinguishable from a
    // completely wrong token without this hint.
    const { body } = await call(CONFIGURED, { 'x-scanner-token': `${TOKEN}\n` });
    expect(body).toMatchObject({ headerPresent: true, lengthMatch: false });
  });

  it('reports a same-length mismatch as a genuinely different secret', async () => {
    const wrong = 'x'.repeat(TOKEN.length);
    const { body } = await call(CONFIGURED, { 'x-scanner-token': wrong });
    expect(body).toMatchObject({ headerPresent: true, lengthMatch: true });
  });

  it('never echoes the token, the expected value, or either length', async () => {
    const { body } = await call(CONFIGURED, { 'x-scanner-token': 'nearly-right' });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('nearly-right');
    // Only booleans beyond the error code — no numbers to read a length off.
    expect(Object.keys(body).sort()).toEqual(['error', 'headerPresent', 'lengthMatch']);
  });
});

describe('the token comparison itself', () => {
  it('accepts the exact token', async () => {
    // Auth passes, so execution reaches the feed and the throwing fetch —
    // which the handler turns into a 500. That it is NOT 401 is the assertion.
    const { status } = await call(CONFIGURED, { 'x-scanner-token': TOKEN });
    expect(status).not.toBe(401);
  });

  it('is case-sensitive', async () => {
    const { status } = await call(CONFIGURED, { 'x-scanner-token': TOKEN.toUpperCase() });
    expect(status).toBe(401);
  });

  it('reads the header whatever case the client sent it in', async () => {
    // Node lowercases incoming headers, but the dev-server path and any future
    // caller may not, and a 401 caused by header casing would be baffling.
    const { status } = await call(CONFIGURED, { 'X-Scanner-Token': TOKEN });
    expect(status).not.toBe(401);
  });
});

describe('method handling', () => {
  it('rejects anything that is not GET or POST, and says what is allowed', async () => {
    const req: ScannerHttpRequest = { method: 'DELETE', url: '/api/scanner', headers: {} };
    const res = capture();
    await createScannerHandler({ env: CONFIGURED })(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET, POST');
  });

  it('refuses before auth, so the method check cannot be used as a token oracle', async () => {
    const req: ScannerHttpRequest = { method: 'PUT', url: '/api/scanner', headers: {} };
    const res = capture();
    await createScannerHandler({ env: CONFIGURED })(req, res);
    expect(JSON.parse(res.body).error).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('responses are never cached', () => {
  it('marks even a refusal no-store', async () => {
    // A cached 401 at the edge would survive fixing the token, and look
    // identical to the token still being wrong.
    const { headers } = await call(CONFIGURED, {});
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Type']).toMatch(/application\/json/);
  });
});

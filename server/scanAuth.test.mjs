/**
 * Who may run a scan.
 *
 * The important property is not that the right caller gets in — it is that
 * the endpoint is CLOSED by default. An unconfigured deployment, a missing
 * header, an empty secret and a token for another repository must all be
 * refused, because any one of them falling open means a stranger can fill
 * the database and spend this project's Yahoo goodwill.
 */
import { describe, expect, it } from 'vitest';
import { allowedRepository, authoriseScan, bearerOf, SCAN_AUDIENCE } from './scanAuth.mjs';

const REPO = 'davide963-ux/ichialgo-ve-rea';
const auth = (token) => (token === undefined ? {} : { authorization: `Bearer ${token}` });

/** Stand-in for the real verifier: accepts one magic token, rejects the rest. */
const fakeVerify = (good = 'good.jwt.token') =>
  async (token, opts) => {
    if (token !== good) throw new Error('signature does not verify');
    if (opts.repository !== REPO) throw new Error(`is for ${REPO}, not ${opts.repository}`);
    if (opts.audience !== SCAN_AUDIENCE) throw new Error('audience does not match');
    return { repository: REPO, workflow: 'scan', ref: 'refs/heads/main' };
  };

describe('bearerOf', () => {
  it('reads the token, however the header is cased', () => {
    expect(bearerOf({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerOf({ Authorization: 'bearer abc' })).toBe('abc');
    expect(bearerOf({ authorization: '  Bearer   abc  ' })).toBe('abc');
  });

  it('is empty when there is no header, rather than undefined', () => {
    expect(bearerOf({})).toBe('');
    expect(bearerOf()).toBe('');
  });
});

describe('allowedRepository', () => {
  it('uses what Vercel already knows about the deployment', () => {
    expect(allowedRepository({ VERCEL_GIT_REPO_OWNER: 'davide963-ux', VERCEL_GIT_REPO_SLUG: 'ichialgo-ve-rea' })).toBe(REPO);
  });

  it('prefers an explicit override', () => {
    expect(
      allowedRepository({
        SCAN_ALLOWED_REPOSITORY: 'other/repo',
        VERCEL_GIT_REPO_OWNER: 'davide963-ux',
        VERCEL_GIT_REPO_SLUG: 'ichialgo-ve-rea',
      }),
    ).toBe('other/repo');
  });

  it('is null when nothing says where the deployment came from', () => {
    expect(allowedRepository({})).toBeNull();
    expect(allowedRepository({ VERCEL_GIT_REPO_OWNER: 'davide963-ux' })).toBeNull();
  });
});

describe('authoriseScan — closed by default', () => {
  it('refuses a request with no Authorization header', async () => {
    const out = await authoriseScan({}, { SCANNER_TOKEN: 'secret' }, { verifyGitHubOidc: fakeVerify() });
    expect(out.ok).toBe(false);
  });

  /** The one that matters most: nothing configured must not mean "allow". */
  it('refuses everything when neither a secret nor a repository is configured', async () => {
    const out = await authoriseScan(auth('anything'), {}, { verifyGitHubOidc: fakeVerify() });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/neither/);
  });

  it('does not treat an empty or whitespace SCANNER_TOKEN as a match', async () => {
    for (const configured of ['', '   ']) {
      const out = await authoriseScan(auth(''), { SCANNER_TOKEN: configured }, { verifyGitHubOidc: fakeVerify() });
      expect(out.ok, `SCANNER_TOKEN=${JSON.stringify(configured)}`).toBe(false);
    }
  });
});

describe('authoriseScan — shared secret', () => {
  const env = { SCANNER_TOKEN: 'sekrit' };

  it('accepts the configured secret', async () => {
    const out = await authoriseScan(auth('sekrit'), env, { verifyGitHubOidc: fakeVerify() });
    expect(out).toMatchObject({ ok: true, via: 'token' });
  });

  it('refuses a wrong secret, including a prefix of the right one', async () => {
    for (const bad of ['sekri', 'sekrit2', 'SEKRIT', 'x']) {
      expect((await authoriseScan(auth(bad), env, { verifyGitHubOidc: fakeVerify() })).ok, bad).toBe(false);
    }
  });
});

describe('authoriseScan — GitHub OIDC', () => {
  const env = { VERCEL_GIT_REPO_OWNER: 'davide963-ux', VERCEL_GIT_REPO_SLUG: 'ichialgo-ve-rea' };

  it('accepts a token the verifier vouches for, with no secret configured at all', async () => {
    const out = await authoriseScan(auth('good.jwt.token'), env, { verifyGitHubOidc: fakeVerify() });
    expect(out).toMatchObject({ ok: true, via: 'oidc' });
    expect(out.claims.repository).toBe(REPO);
  });

  it('refuses a token the verifier rejects', async () => {
    const out = await authoriseScan(auth('bad.jwt.token'), env, { verifyGitHubOidc: fakeVerify() });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/^oidc: /);
  });

  it('passes the repository and the fixed audience to the verifier', async () => {
    let seen;
    await authoriseScan(auth('a.b.c'), env, {
      verifyGitHubOidc: async (_t, opts) => {
        seen = opts;
        return { repository: REPO };
      },
    });
    expect(seen).toMatchObject({ repository: REPO, audience: SCAN_AUDIENCE });
  });

  it('does not attempt OIDC for something that is not JWT-shaped', async () => {
    let called = false;
    const out = await authoriseScan(auth('plain-secret'), env, {
      verifyGitHubOidc: async () => {
        called = true;
        return {};
      },
    });
    expect(called, 'a non-JWT must not reach the verifier').toBe(false);
    expect(out.ok).toBe(false);
  });

  it('refuses OIDC when the deployment does not know its own repository', async () => {
    const out = await authoriseScan(auth('good.jwt.token'), {}, { verifyGitHubOidc: fakeVerify() });
    expect(out.ok).toBe(false);
  });

  it('never throws, so a verifier failure is a refusal and not a 500', async () => {
    const out = await authoriseScan(auth('a.b.c'), env, {
      verifyGitHubOidc: async () => {
        throw new Error('JWKS unreachable');
      },
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/JWKS unreachable/);
  });
});

describe('authoriseScan — both configured', () => {
  const env = {
    SCANNER_TOKEN: 'sekrit',
    VERCEL_GIT_REPO_OWNER: 'davide963-ux',
    VERCEL_GIT_REPO_SLUG: 'ichialgo-ve-rea',
  };

  it('takes either route', async () => {
    expect((await authoriseScan(auth('sekrit'), env, { verifyGitHubOidc: fakeVerify() })).via).toBe('token');
    expect((await authoriseScan(auth('good.jwt.token'), env, { verifyGitHubOidc: fakeVerify() })).via).toBe('oidc');
  });

  it('still refuses something that is neither', async () => {
    expect((await authoriseScan(auth('nope'), env, { verifyGitHubOidc: fakeVerify() })).ok).toBe(false);
  });
});

/**
 * Who is allowed to run a scan.
 *
 * Two ways in, checked in this order:
 *
 *   1. GITHUB OIDC — the scheduled workflow proves, with a short-lived token
 *      signed by GitHub, that it is this repository's Actions run. Nothing is
 *      stored on either side; see githubOidc.mjs for what is verified.
 *   2. A SHARED SECRET — `SCANNER_TOKEN`, if one is configured. Kept so the
 *      endpoint can be driven by anything else (a cron service, curl while
 *      debugging) without needing a GitHub identity.
 *
 * Neither is required to exist, but at least one must PASS. An endpoint that
 * falls open when nothing is configured is how a database gets filled by
 * strangers, so the default is refusal.
 *
 * This lives in server/ rather than inside api/scan.js because api/ is not
 * covered by the test suite — Vercel treats those files as route entry points
 * and nothing imports them. Auth logic that nothing tests is auth logic that
 * nobody checked.
 */
import { verifyGitHubOidc } from './githubOidc.mjs';

/**
 * The audience the workflow asks GitHub to mint its token for.
 *
 * Fixed, and checked on this side, so a token some other service obtained for
 * its own audience cannot be replayed here even though it comes from the same
 * issuer and the same repository.
 */
export const SCAN_AUDIENCE = 'ichialgo-scan';

/**
 * Which repository's workflow to trust.
 *
 * Vercel sets VERCEL_GIT_REPO_OWNER and VERCEL_GIT_REPO_SLUG on every
 * deployment from a connected repository, so this normally needs no
 * configuration at all — the deployment already knows where it came from.
 */
export function allowedRepository(env = process.env) {
  const explicit = env.SCAN_ALLOWED_REPOSITORY?.trim();
  if (explicit) return explicit;
  const owner = env.VERCEL_GIT_REPO_OWNER?.trim();
  const slug = env.VERCEL_GIT_REPO_SLUG?.trim();
  return owner && slug ? `${owner}/${slug}` : null;
}

/**
 * The bearer token on a request, or '' if there is none.
 *
 * Trimmed BEFORE the prefix is stripped: a header that arrives with leading
 * whitespace would otherwise fail the `^Bearer` anchor and be passed through
 * whole, so the scheme name itself would be compared against the secret.
 */
export function bearerOf(headers = {}) {
  const raw = String(headers?.authorization || headers?.Authorization || '').trim();
  return raw.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Constant-time-ish comparison for the shared secret.
 *
 * `===` on strings can return early on the first differing byte. The timing
 * signal is tiny over a network, but comparing a secret is the one place it
 * costs nothing to not leak it.
 */
function secretsMatch(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide whether this request may run a scan.
 *
 * Returns `{ ok: true, via }` or `{ ok: false, reason }`. It never throws:
 * a verification error is a refusal, not a 500, and the reason is for the
 * server's own log rather than for the caller — telling an unauthenticated
 * caller exactly which check failed just helps them.
 */
export async function authoriseScan(headers, env = process.env, deps = {}) {
  const verify = deps.verifyGitHubOidc ?? verifyGitHubOidc;
  const offered = bearerOf(headers);
  if (!offered) return { ok: false, reason: 'no bearer token' };

  // 1. Shared secret, when one is configured.
  const expected = env.SCANNER_TOKEN?.trim();
  if (expected && secretsMatch(offered, expected)) return { ok: true, via: 'token' };

  // 2. GitHub OIDC. A JWT has two dots; anything else cannot be one, and
  //    skipping the attempt keeps a mistyped secret out of the JWKS fetch.
  const repository = allowedRepository(env);
  if (repository && offered.split('.').length === 3) {
    try {
      const claims = await verify(offered, { repository, audience: SCAN_AUDIENCE });
      return { ok: true, via: 'oidc', claims };
    } catch (err) {
      return { ok: false, reason: `oidc: ${err?.message || err}` };
    }
  }

  if (!expected && !repository) {
    return { ok: false, reason: 'neither SCANNER_TOKEN nor a known repository is configured' };
  }
  return { ok: false, reason: 'bearer token did not match' };
}

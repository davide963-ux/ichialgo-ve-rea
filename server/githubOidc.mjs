/**
 * Verify a GitHub Actions OIDC token.
 *
 * WHY THIS EXISTS INSTEAD OF A SHARED SECRET
 * ──────────────────────────────────────────
 * The scanner endpoint has to know that the caller is this repository's
 * workflow and not the open internet. The obvious way is a random string
 * copied into two places — the Vercel project and the repository's Actions
 * secrets. That works, but it is a credential: it has to be created, pasted
 * twice, kept in step, rotated, and never leaked.
 *
 * GitHub will instead mint a short-lived JSON Web Token for a workflow run,
 * signed by GitHub, stating which repository, workflow and ref it came from.
 * The workflow asks for one at run time with `permissions: id-token: write`.
 * Nothing is stored anywhere. There is no secret to leak, and a token stolen
 * from a log expires in minutes and names the run it came from.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE MATTERS
 * ─────────────────────────────────────────
 *   alg         Only RS256. Taking the algorithm from the token itself is the
 *               classic JWT break: `alg: none` forges anything, and `HS256`
 *               lets an attacker sign with the PUBLIC key as the HMAC secret.
 *   signature   Against GitHub's published JWKS, over the exact signing input.
 *   iss         GitHub's issuer, so another provider's token is no good.
 *   aud         Our own audience string, so a token minted for some other
 *               service that trusts GitHub cannot be replayed at us.
 *   exp / nbf   Within its validity window, with a little clock skew.
 *   repository  THIS repository. Without it, any public repo's workflow on
 *               all of GitHub would be accepted — this is the check that
 *               actually makes it ours, and it is the one easiest to forget.
 *
 * Anything that does not verify throws. There is no path that returns a
 * partial result, because a caller that forgot to check a flag would be an
 * open endpoint.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** Allow a little clock skew between GitHub and the serverless runtime. */
const SKEW_MS = 60_000;

const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function decodeJson(part, what) {
  try {
    return JSON.parse(b64urlToBuffer(part).toString('utf8'));
  } catch {
    throw new Error(`OIDC token has an unreadable ${what}`);
  }
}

/**
 * GitHub's signing keys, cached in module scope.
 *
 * A warm serverless instance serves many runs and the key set changes rarely,
 * so re-fetching per request would add a round trip to every scan. The cache
 * is dropped when a token names a `kid` we have not seen, which is exactly
 * when GitHub has rotated — so rotation is picked up without a fixed TTL and
 * without trusting the token to force unlimited refetches (one retry only).
 */
let jwksCache = null;

async function defaultFetchJwks() {
  const res = await fetch(JWKS_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not fetch GitHub JWKS (HTTP ${res.status})`);
  const body = await res.json();
  if (!Array.isArray(body?.keys)) throw new Error('GitHub JWKS has no keys');
  return body.keys;
}

async function keyFor(kid, fetchJwks) {
  if (jwksCache) {
    const hit = jwksCache.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  jwksCache = await fetchJwks();
  const key = jwksCache.find((k) => k.kid === kid);
  if (!key) throw new Error(`OIDC token signed by an unknown key (kid ${kid})`);
  return key;
}

/** Drop the cached key set. For tests; nothing in production needs it. */
export function resetJwksCache() {
  jwksCache = null;
}

export async function verifyGitHubOidc(
  token,
  { repository, audience, now = Date.now(), fetchJwks = defaultFetchJwks } = {},
) {
  if (!repository) throw new Error('verifyGitHubOidc needs the repository to allow');
  if (!audience) throw new Error('verifyGitHubOidc needs the audience to require');
  if (typeof token !== 'string' || token.length === 0) throw new Error('No OIDC token');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OIDC token is not a JWT');
  const [h, p, s] = parts;

  const header = decodeJson(h, 'header');
  // Before anything else: never let the token choose how it is verified.
  if (header.alg !== 'RS256') throw new Error(`OIDC token alg ${header.alg} is not allowed`);
  if (!header.kid) throw new Error('OIDC token has no key id');

  const jwk = await keyFor(header.kid, fetchJwks);
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });

  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, b64urlToBuffer(s));
  if (!ok) throw new Error('OIDC token signature does not verify');

  const claims = decodeJson(p, 'payload');

  if (claims.iss !== GITHUB_ISSUER) throw new Error(`OIDC token issuer ${claims.iss} is not GitHub`);

  // `aud` may be a string or an array, per the JWT spec.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error('OIDC token audience does not match');

  if (typeof claims.exp !== 'number' || now >= claims.exp * 1000 + SKEW_MS) {
    throw new Error('OIDC token has expired');
  }
  if (typeof claims.nbf === 'number' && now < claims.nbf * 1000 - SKEW_MS) {
    throw new Error('OIDC token is not valid yet');
  }

  // The check that makes it OURS. Case-insensitive: GitHub preserves the
  // owner's capitalisation, and a repository rename changes only the case
  // more often than people expect.
  if (String(claims.repository).toLowerCase() !== String(repository).toLowerCase()) {
    throw new Error(`OIDC token is for ${claims.repository}, not ${repository}`);
  }

  return claims;
}

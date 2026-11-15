/**
 * OIDC verification, including the ways it could be fooled.
 *
 * Tokens here are signed with a key generated in the test, and the JWKS
 * fetcher is injected, so this runs offline and deterministically. The point
 * is not that a valid token passes — that is the easy half. It is that each
 * individual check actually rejects: drop any one of them and a specific test
 * below goes green when it should not.
 */
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_ISSUER, resetJwksCache, verifyGitHubOidc } from './githubOidc.mjs';

const REPO = 'davide963-ux/ichialgo-ve-rea';
const AUD = 'ichialgo-scan';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = randomUUID();

/** The key set GitHub would publish for the key above. */
const jwks = () => [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Mint a token. `sign: false` leaves a valid shape with a bogus signature. */
function mint({ header = {}, claims = {}, sign = true, key = privateKey } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header }));
  const p = b64url(
    JSON.stringify({
      iss: GITHUB_ISSUER,
      aud: AUD,
      repository: REPO,
      repository_owner: 'davide963-ux',
      workflow: 'scan',
      ref: 'refs/heads/main',
      iat: nowSec,
      nbf: nowSec,
      exp: nowSec + 300,
      ...claims,
    }),
  );
  if (!sign) return `${h}.${p}.${b64url('not-a-signature')}`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(signer.sign(key))}`;
}

const verify = (token, over = {}) =>
  verifyGitHubOidc(token, { repository: REPO, audience: AUD, fetchJwks: async () => jwks(), ...over });

beforeEach(() => resetJwksCache());

describe('verifyGitHubOidc', () => {
  it('accepts a token this repository\'s workflow would get, and returns its claims', async () => {
    const claims = await verify(mint());
    expect(claims.repository).toBe(REPO);
    expect(claims.workflow).toBe('scan');
    expect(claims.ref).toBe('refs/heads/main');
  });

  it('accepts an aud given as an array, as the JWT spec allows', async () => {
    await expect(verify(mint({ claims: { aud: ['something-else', AUD] } }))).resolves.toBeTruthy();
  });

  // ── the attacks ────────────────────────────────────────────────────────

  /**
   * The classic JWT break. If the verifier trusts the token's own `alg`,
   * `none` forges anything at all.
   */
  it('rejects alg: none', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }));
    const p = b64url(JSON.stringify({ iss: GITHUB_ISSUER, aud: AUD, repository: REPO, exp: nowSec + 300 }));
    await expect(verify(`${h}.${p}.`)).rejects.toThrow(/alg none is not allowed/);
  });

  /**
   * The other half of alg confusion: offer HS256 so the verifier HMACs with
   * the public key, which the attacker also has.
   */
  it('rejects a symmetric alg', async () => {
    await expect(verify(mint({ header: { alg: 'HS256' } }))).rejects.toThrow(/alg HS256 is not allowed/);
  });

  it('rejects a token signed by the wrong key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(verify(mint({ key: other }))).rejects.toThrow(/signature does not verify/);
  });

  it('rejects a tampered payload', async () => {
    const good = mint();
    const [h, , s] = good.split('.');
    const forged = b64url(JSON.stringify({ iss: GITHUB_ISSUER, aud: AUD, repository: REPO, exp: 9e9 }));
    await expect(verify(`${h}.${forged}.${s}`)).rejects.toThrow(/signature does not verify/);
  });

  /**
   * THE check that makes the endpoint ours. Without it, every public
   * repository's workflow on GitHub would be accepted — they all get
   * perfectly valid tokens from the same issuer.
   */
  it('rejects a valid token minted for a different repository', async () => {
    const t = mint({ claims: { repository: 'someone-else/evil' } });
    await expect(verify(t)).rejects.toThrow(/is for someone-else\/evil, not/);
  });

  it('rejects a token minted for a different audience', async () => {
    await expect(verify(mint({ claims: { aud: 'some-other-service' } }))).rejects.toThrow(/audience does not match/);
  });

  it('rejects a token from another issuer', async () => {
    await expect(verify(mint({ claims: { iss: 'https://evil.example' } }))).rejects.toThrow(/is not GitHub/);
  });

  it('rejects an expired token', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await expect(verify(mint({ claims: { exp: nowSec - 3600 } }))).rejects.toThrow(/expired/);
  });

  it('rejects a token with no expiry at all', async () => {
    const t = mint({ claims: { exp: undefined } });
    await expect(verify(t)).rejects.toThrow(/expired/);
  });

  it('rejects a token that is not valid yet', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await expect(verify(mint({ claims: { nbf: nowSec + 3600, exp: nowSec + 7200 } }))).rejects.toThrow(/not valid yet/);
  });

  it('rejects a signature that is merely the right shape', async () => {
    await expect(verify(mint({ sign: false }))).rejects.toThrow(/signature does not verify/);
  });

  it('rejects malformed input rather than treating it as anonymous', async () => {
    await expect(verify('')).rejects.toThrow(/No OIDC token/);
    await expect(verify('a.b')).rejects.toThrow(/not a JWT/);
    await expect(verify('!!!.???.***')).rejects.toThrow(/unreadable header/);
  });

  it('refuses to run without a repository or an audience to check against', async () => {
    await expect(verifyGitHubOidc(mint(), { audience: AUD })).rejects.toThrow(/needs the repository/);
    await expect(verifyGitHubOidc(mint(), { repository: REPO })).rejects.toThrow(/needs the audience/);
  });

  // ── key handling ───────────────────────────────────────────────────────

  it('rejects a token whose key id is not in the key set', async () => {
    await expect(verify(mint({ header: { kid: 'nope' } }))).rejects.toThrow(/unknown key/);
  });

  it('rejects a token with no key id', async () => {
    await expect(verify(mint({ header: { kid: undefined } }))).rejects.toThrow(/no key id/);
  });

  it('caches the key set, then refetches once when a new kid appears', async () => {
    let calls = 0;
    const counting = async () => {
      calls++;
      return jwks();
    };
    await verifyGitHubOidc(mint(), { repository: REPO, audience: AUD, fetchJwks: counting });
    await verifyGitHubOidc(mint(), { repository: REPO, audience: AUD, fetchJwks: counting });
    expect(calls, 'the second call should use the cache').toBe(1);

    // A rotated key: one more fetch, and still a clean rejection after it.
    await expect(
      verifyGitHubOidc(mint({ header: { kid: 'rotated' } }), {
        repository: REPO,
        audience: AUD,
        fetchJwks: counting,
      }),
    ).rejects.toThrow(/unknown key/);
    expect(calls, 'an unknown kid should trigger exactly one refetch').toBe(2);
  });

  it('surfaces a JWKS fetch failure instead of letting the request through', async () => {
    await expect(
      verifyGitHubOidc(mint(), {
        repository: REPO,
        audience: AUD,
        fetchJwks: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow(/network down/);
  });
});

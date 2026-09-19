/**
 * Vercel's API routing is FILE-BASED, and the file SHAPE matters:
 *
 *   api/foo.js            → exactly /api/foo
 *   api/foo/[...path].js  → /api/foo/<at least one segment>, NOT /api/foo
 *
 * Both halves of that shipped broken once. First the Yahoo route had no file
 * at all; then it had a [...path] folder while the route is the bare
 * /api/yahoo-chart, so the catch-all never matched and Vercel returned its
 * own 404. Neither failed locally, because Vite pipes every request through
 * the shared middleware regardless of what is in api/.
 *
 * So this derives the required shape from the route regexes themselves.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', 'api');

/**
 * Each route in the proxy's table, as { prefix, hasSubPath }.
 * `hasSubPath` is true when the regex requires a "/" after the prefix.
 */
function proxyRoutes() {
  const src = readFileSync(join(here, 'api.mjs'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/re:\s*\/\^\\\/api\\\/([a-z0-9-]+)(\\\/)?/g)) {
    out.push({ prefix: m[1], hasSubPath: Boolean(m[2]) });
  }
  return out;
}

/** What Vercel would actually expose, from the files on disk. */
function deployedRoutes() {
  const out = [];
  for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push({ kind: 'static', prefix: entry.name.replace(/\.js$/, '') });
    } else if (entry.isDirectory()) {
      for (const f of readdirSync(join(apiDir, entry.name))) {
        if (/^\[\.\.\..+\]\.js$/.test(f)) out.push({ kind: 'catchall', prefix: entry.name });
        else if (f === 'index.js') out.push({ kind: 'static', prefix: entry.name });
      }
    }
  }
  return out;
}

export const serves = (deployed, { prefix, hasSubPath }) =>
  deployed.some((d) => d.prefix === prefix && (hasSubPath ? d.kind === 'catchall' || d.kind === 'static' : d.kind === 'static'));

describe('proxy routes vs Vercel functions', () => {
  it('finds the route table (so this cannot pass by reading nothing)', () => {
    const routes = proxyRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.map((r) => r.prefix)).toContain('td-rest');
    // Twelve Data's routes carry a sub-path (/quote, /time_series, /_status),
    // which is what a [...path] catch-all can serve.
    expect(routes.every((r) => r.hasSubPath)).toBe(true);
  });

  /**
   * No route is currently the bare /api/<prefix>, so the rule that such a
   * route needs a STATIC file is not exercised by the repo as it stands.
   * It is checked directly here so it cannot rot before the next provider —
   * getting it wrong is what made /api/yahoo-chart 404 in production.
   */
  it('knows a [...path] catch-all cannot serve a bare /api/<prefix>', () => {
    const catchall = [{ kind: 'catchall', prefix: 'thing' }];
    const staticFile = [{ kind: 'static', prefix: 'thing' }];

    expect(serves(catchall, { prefix: 'thing', hasSubPath: true })).toBe(true);
    expect(serves(catchall, { prefix: 'thing', hasSubPath: false })).toBe(false);
    expect(serves(staticFile, { prefix: 'thing', hasSubPath: false })).toBe(true);
  });

  it('deploys a function of the right SHAPE for every route', () => {
    const deployed = deployedRoutes();
    for (const route of proxyRoutes()) {
      expect(
        serves(deployed, route),
        route.hasSubPath
          ? `server/api.mjs serves /api/${route.prefix}/… but no api/${route.prefix}/[...path].js exists`
          : `server/api.mjs serves the bare /api/${route.prefix}, which a [...path] catch-all CANNOT match — it needs api/${route.prefix}.js`,
      ).toBe(true);
    }
  });

  it('does not ship a function for a route that no longer exists', () => {
    const prefixes = new Set(proxyRoutes().map((r) => r.prefix));
    for (const d of deployedRoutes()) {
      expect(prefixes, `api/ deploys ${d.prefix} but server/api.mjs serves no /api/${d.prefix} route`).toContain(d.prefix);
    }
  });

  it('points every function at the shared handler, so they cannot drift', () => {
    for (const d of deployedRoutes()) {
      const file = d.kind === 'static' ? join(apiDir, `${d.prefix}.js`) : join(apiDir, d.prefix, '[...path].js');
      const path = existsSync(file) ? file : join(apiDir, d.prefix, 'index.js');
      expect(readFileSync(path, 'utf8')).toMatch(/_lib\/handler\.mjs'/);
    }
  });
});

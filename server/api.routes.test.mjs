/**
 * Vercel's functions are FILE-BASED. A route added to server/api.mjs works in
 * dev (Vite pipes every request through the shared middleware) and 404s in
 * production if no api/<prefix>/ folder exists to bind a function to.
 *
 * That is exactly how /api/yahoo-chart shipped broken, so this test asserts
 * the two stay in step, in both directions.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/** Every /api/<prefix> the proxy's route table answers. */
function routePrefixes() {
  const src = readFileSync(join(here, 'api.mjs'), 'utf8');
  const found = new Set();
  // Route regexes are written as literals: re: /^\/api\/<prefix>\/…
  for (const m of src.matchAll(/re:\s*\/\^\\\/api\\\/([a-z0-9-]+)/g)) found.add(m[1]);
  return [...found].sort();
}

/** Every api/<prefix>/ folder Vercel will turn into a function. */
function functionPrefixes() {
  return readdirSync(join(repo, 'api'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

describe('proxy routes vs Vercel functions', () => {
  it('finds the route table (guards against this test silently passing)', () => {
    const prefixes = routePrefixes();
    expect(prefixes.length).toBeGreaterThanOrEqual(4);
    expect(prefixes).toContain('yahoo-chart');
    expect(prefixes).toContain('td-rest');
  });

  it('gives every proxy route a serverless function', () => {
    for (const prefix of routePrefixes()) {
      expect(functionPrefixes(), `server/api.mjs serves /api/${prefix} but api/${prefix}/ does not exist — it will 404 on Vercel`).toContain(prefix);
    }
  });

  it('does not ship a function for a route that no longer exists', () => {
    for (const prefix of functionPrefixes()) {
      expect(routePrefixes(), `api/${prefix}/ exists but server/api.mjs serves no /api/${prefix} route`).toContain(prefix);
    }
  });

  it('points every function at the shared handler, so they cannot drift', () => {
    for (const prefix of functionPrefixes()) {
      const entry = join(repo, 'api', prefix, '[...path].js');
      expect(existsSync(entry), `api/${prefix}/[...path].js is missing`).toBe(true);
      expect(readFileSync(entry, 'utf8')).toMatch(/from '\.\.\/_lib\/handler\.mjs'/);
    }
  });
});

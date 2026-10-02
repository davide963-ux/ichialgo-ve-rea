/**
 * vercel.json has to agree with what is on disk, and the failures are all
 * build-time or 404s that never show up locally:
 *
 *   - a `functions` glob matching NO file is a Vercel build error
 *     ("doesn't match any Serverless Functions"), which is how removing
 *     api/yahoo-chart.js broke the build while every local check passed;
 *   - a function file matched by NO glob silently loses its config.
 *
 * Both directions are checked here, against the real files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(repo, 'vercel.json'), 'utf8'));

/** Every file under api/, as a repo-relative path. */
function apiFiles(dir = join(repo, 'api'), acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) apiFiles(full, acc);
    else acc.push(relative(repo, full));
  }
  return acc;
}

/** Minimal glob → regex for the patterns Vercel config uses. */
export function globToRegExp(glob) {
  const rx = glob
    .split('/')
    .map((part) => (part === '**' ? '\u0000' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\u0000\//g, '(?:[^/]+/)*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${rx}$`);
}

describe('globToRegExp', () => {
  it('matches the way the patterns are meant to', () => {
    expect(globToRegExp('api/**/*.js').test('api/td-rest/[...path].js')).toBe(true);
    expect(globToRegExp('api/**/*.js').test('api/deep/er/x.js')).toBe(true);
    expect(globToRegExp('api/*.js').test('api/foo.js')).toBe(true);
    expect(globToRegExp('api/*.js').test('api/td-rest/foo.js')).toBe(false);
    expect(globToRegExp('api/**/*.js').test('api/handler.mjs')).toBe(false);
    expect(globToRegExp('api/**/*.ts').test('api/scanner.ts')).toBe(true);
    expect(globToRegExp('api/**/*.ts').test('api/scanner.js')).toBe(false);
  });
});

describe('vercel.json functions', () => {
  const patterns = Object.keys(config.functions ?? {});
  const files = apiFiles();

  it('declares at least one function pattern', () => {
    expect(patterns.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no pattern that matches nothing (Vercel fails the build on these)', () => {
    for (const pattern of patterns) {
      const rx = globToRegExp(pattern);
      expect(
        files.some((f) => rx.test(f)),
        `vercel.json declares "${pattern}" but no file under api/ matches it — Vercel will fail the build`,
      ).toBe(true);
    }
  });

  it('leaves no serverless entry point without a matching pattern', () => {
    // Files starting with _ are shared helpers, never functions themselves.
    // .ts counts: Vercel compiles TypeScript functions, and api/scanner.ts is
    // one, so a pattern that only covered .js would silently drop its config
    // (including the longer maxDuration a full scan needs).
    const entries = files.filter((f) => /\.(js|ts)$/.test(f) && !f.includes('/_'));
    for (const file of entries) {
      expect(
        patterns.some((p) => globToRegExp(p).test(file)),
        `${file} is a serverless entry point but no vercel.json functions pattern matches it`,
      ).toBe(true);
    }
  });
});

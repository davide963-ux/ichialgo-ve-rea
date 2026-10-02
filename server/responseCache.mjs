/**
 * A short-lived cache in front of Twelve Data.
 *
 * WHY
 * ───
 * Every credit is metered per request, and the proxy used to forward every
 * browser poll straight upstream. Two people with the dashboard open cost
 * twice as much as one, for identical data. Three tabs on one laptop, three
 * times. Nothing about that is useful: a EUR/USD quote is the same quote
 * whoever asks for it.
 *
 * With a cache the guarantee becomes: Twelve Data is asked for a given symbol
 * set at most once per TTL, no matter how many tabs, devices or people are
 * looking.
 *
 * SINGLE-FLIGHT MATTERS AS MUCH AS THE CACHE
 * ──────────────────────────────────────────
 * A plain TTL cache does nothing for requests that arrive together, and they
 * do arrive together: several tabs polling on the same interval drift into
 * alignment, all miss the empty cache in the same instant, and all spend a
 * credit. So a request already in flight is joined rather than repeated, and
 * the cache is only populated once it resolves.
 *
 * WHAT IS NOT CACHED
 * ──────────────────
 * Only successful responses. An error — a rate limit, an upstream 500, a bad
 * symbol — is never stored: caching a failure turns one bad minute into a TTL
 * of bad minutes, and errors are exactly what a caller should be allowed to
 * retry.
 *
 * SERVERLESS
 * ──────────
 * This lives in module scope, so on Vercel it is per warm instance and dies
 * on a cold start. That is a weaker guarantee than a shared cache, not a
 * broken one: a warm instance serves many requests, which is where the
 * duplication was.
 */

const DEFAULTS = {
  /** Live quotes. One minute of staleness is invisible on a dashboard. */
  quoteTtlMs: 60_000,
  /**
   * Candles. A closed bar never changes, and the newest bar is only
   * interesting to a chart, so this can be far longer than the quote TTL.
   */
  seriesTtlMs: 15 * 60_000,
  /** Bound on memory: distinct symbol/interval combinations are few. */
  maxEntries: 200,
};

export function createResponseCache(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  /** key → { expiresAt, payload } */
  const entries = new Map();
  /** key → Promise, for requests already upstream. */
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, joined: 0, stored: 0, evicted: 0 };

  /**
   * Cache key: endpoint plus its parameters in a stable order.
   *
   * Sorting matters — `?symbol=X&interval=1h` and `?interval=1h&symbol=X` are
   * the same request and must not occupy two entries and cost two credits.
   */
  const keyFor = (path) => {
    const [endpoint, query = ''] = path.split('?');
    const params = [...new URLSearchParams(query).entries()]
      .filter(([k]) => k !== 'apikey')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${endpoint}?${params}`;
  };

  const ttlFor = (path) => (path.startsWith('/quote') ? cfg.quoteTtlMs : cfg.seriesTtlMs);

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
    // Oldest-inserted first: Map preserves insertion order.
    while (entries.size > cfg.maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      stats.evicted++;
    }
  };

  return {
    stats: () => ({ ...stats, entries: entries.size, inflight: inflight.size }),

    /**
     * Serve `path` from cache, from a request already in flight, or by calling
     * `fetchFresh()`.
     *
     * `fetchFresh` must resolve to `{ cacheable, payload }`. The proxy decides
     * what counts as cacheable — it is the only layer that knows whether
     * Twelve Data reported an error inside an HTTP 200.
     */
    async serve(path, fetchFresh) {
      const key = keyFor(path);
      const now = Date.now();

      const hit = entries.get(key);
      if (hit && hit.expiresAt > now) {
        stats.hits++;
        return { payload: hit.payload, cached: true, ageMs: now - (hit.expiresAt - ttlFor(path)) };
      }

      const pending = inflight.get(key);
      if (pending) {
        stats.joined++;
        return { payload: await pending, cached: true, ageMs: 0, joined: true };
      }

      stats.misses++;
      const promise = (async () => {
        const { cacheable, payload } = await fetchFresh();
        if (cacheable) {
          entries.set(key, { expiresAt: Date.now() + ttlFor(path), payload });
          stats.stored++;
          prune();
        }
        return payload;
      })();

      inflight.set(key, promise);
      try {
        return { payload: await promise, cached: false, ageMs: 0 };
      } finally {
        inflight.delete(key);
      }
    },
  };
}

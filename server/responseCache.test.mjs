/**
 * The cache exists to stop credits being spent twice for the same answer, so
 * every test here is really "how many times did we go upstream?".
 *
 * That is the number on the bill, and it is the only number worth asserting.
 */
import { describe, expect, it, vi } from 'vitest';
import { createResponseCache } from './responseCache.mjs';

/** Counts upstream calls and lets each resolve on demand. */
function upstream(payload = { kind: 'upstream', text: 'ok' }, cacheable = true) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls++;
      return { cacheable, payload };
    },
  };
}

describe('serving repeats without paying twice', () => {
  it('goes upstream once, then serves from memory', async () => {
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream();

    const first = await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    const second = await cache.serve('/quote?symbol=EUR/USD', up.fetch);

    expect(up.calls()).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.payload).toEqual(first.payload);
  });

  it('treats the same parameters in a different order as one request', async () => {
    // `?symbol=X&interval=1h` and `?interval=1h&symbol=X` are the same
    // question. Keying on the raw string would buy the same answer twice.
    const cache = createResponseCache({ seriesTtlMs: 60_000 });
    const up = upstream();

    await cache.serve('/time_series?symbol=EUR/USD&interval=1h', up.fetch);
    await cache.serve('/time_series?interval=1h&symbol=EUR/USD', up.fetch);

    expect(up.calls()).toBe(1);
  });

  it('keeps different symbols apart', async () => {
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream();

    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    await cache.serve('/quote?symbol=GBP/USD', up.fetch);

    expect(up.calls()).toBe(2);
  });

  it('goes upstream again once the entry expires', async () => {
    vi.useFakeTimers();
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream();

    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    vi.advanceTimersByTime(61_000);
    await cache.serve('/quote?symbol=EUR/USD', up.fetch);

    expect(up.calls()).toBe(2);
    vi.useRealTimers();
  });

  it('applies the longer TTL to candles than to quotes', async () => {
    vi.useFakeTimers();
    const cache = createResponseCache({ quoteTtlMs: 60_000, seriesTtlMs: 900_000 });
    const quote = upstream();
    const series = upstream();

    await cache.serve('/quote?symbol=EUR/USD', quote.fetch);
    await cache.serve('/time_series?symbol=EUR/USD&interval=1h', series.fetch);

    // Five minutes on: the quote has expired, the candles have not.
    vi.advanceTimersByTime(5 * 60_000);
    await cache.serve('/quote?symbol=EUR/USD', quote.fetch);
    await cache.serve('/time_series?symbol=EUR/USD&interval=1h', series.fetch);

    expect(quote.calls()).toBe(2);
    expect(series.calls()).toBe(1);
    vi.useRealTimers();
  });
});

describe('simultaneous requests share one upstream call', () => {
  it('joins a request already in flight instead of starting another', async () => {
    // This is the case a plain TTL cache misses entirely: several tabs polling
    // on the same interval drift into alignment, all miss the empty cache at
    // the same instant, and all spend a credit.
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    let calls = 0;
    let release;
    const gate = new Promise((r) => (release = r));

    const slow = async () => {
      calls++;
      await gate;
      return { cacheable: true, payload: { text: 'ok' } };
    };

    const all = Promise.all([
      cache.serve('/quote?symbol=EUR/USD', slow),
      cache.serve('/quote?symbol=EUR/USD', slow),
      cache.serve('/quote?symbol=EUR/USD', slow),
    ]);

    release();
    const results = await all;

    expect(calls).toBe(1);
    expect(results.every((r) => r.payload.text === 'ok')).toBe(true);
  });

  it('lets the next request through after an in-flight one fails', async () => {
    // A failure must not leave the key wedged as permanently "in flight".
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('upstream down');
    };

    await expect(cache.serve('/quote?symbol=EUR/USD', failing)).rejects.toThrow('upstream down');
    await expect(cache.serve('/quote?symbol=EUR/USD', failing)).rejects.toThrow('upstream down');

    expect(calls).toBe(2);
  });
});

describe('what must never be cached', () => {
  it('does not store a response the caller marked uncacheable', async () => {
    // Errors: a rate limit, an upstream 500, a bad symbol. Caching one turns
    // a single bad minute into a whole TTL of bad minutes.
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream({ kind: 'exhausted' }, false);

    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    await cache.serve('/quote?symbol=EUR/USD', up.fetch);

    expect(up.calls()).toBe(2);
  });

  it('ignores an apikey in the key, so one is never cached under another', async () => {
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream();

    await cache.serve('/quote?symbol=EUR/USD&apikey=AAA', up.fetch);
    await cache.serve('/quote?symbol=EUR/USD&apikey=BBB', up.fetch);

    expect(up.calls()).toBe(1);
  });

  it('caches nothing at all when the TTL is zero', async () => {
    // The escape hatch for debugging a data issue. It must actually disable.
    const cache = createResponseCache({ quoteTtlMs: 0 });
    const up = upstream();

    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    await cache.serve('/quote?symbol=EUR/USD', up.fetch);

    expect(up.calls()).toBe(2);
  });
});

describe('bounded memory', () => {
  it('evicts the oldest entries past the cap', async () => {
    const cache = createResponseCache({ quoteTtlMs: 60_000, maxEntries: 3 });
    const up = upstream();

    for (let i = 0; i < 6; i++) await cache.serve(`/quote?symbol=P${i}/USD`, up.fetch);

    expect(cache.stats().entries).toBeLessThanOrEqual(3);
    expect(cache.stats().evicted).toBeGreaterThan(0);
  });

  it('reports what it has done, so credit questions can be answered by looking', async () => {
    const cache = createResponseCache({ quoteTtlMs: 60_000 });
    const up = upstream();

    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    await cache.serve('/quote?symbol=EUR/USD', up.fetch);
    await cache.serve('/quote?symbol=EUR/USD', up.fetch);

    const s = cache.stats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(2);
    expect(s.stored).toBe(1);
  });
});

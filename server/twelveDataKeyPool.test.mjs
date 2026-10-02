import { describe, expect, it } from 'vitest';
import { TwelveDataKeyPool, classifyResponse, cooldownFor, readApiKeys } from './twelveDataKeyPool.mjs';

describe('readApiKeys', () => {
  it('reads a single key (backwards compatible)', () => {
    expect(readApiKeys({ TWELVEDATA_API_KEY: 'key-one' })).toEqual(['key-one']);
  });

  it('splits a list and keeps the failover order, deduped', () => {
    const keys = readApiKeys({
      TWELVEDATA_API_KEY: 'key-one',
      TWELVEDATA_API_KEYS: ' key-two , key-three;key-one ',
      TWELVEDATA_API_KEY_1: 'key-four',
    });
    expect(keys).toEqual(['key-one', 'key-two', 'key-three', 'key-four']);
  });

  it('returns an empty pool when nothing is configured', () => {
    expect(readApiKeys({})).toEqual([]);
  });
});

describe('classifyResponse', () => {
  it('treats HTTP 200 + {status:error, code:429} as exhausted', () => {
    expect(classifyResponse(200, { status: 'error', code: 429, message: 'run out of API credits' })).toBe('exhausted');
  });
  it('treats a real HTTP 429 as exhausted', () => {
    expect(classifyResponse(429, null)).toBe('exhausted');
  });
  it('treats a rejected key as auth', () => {
    expect(classifyResponse(200, { status: 'error', code: 401, message: 'invalid apikey' })).toBe('auth');
  });
  it('passes a normal payload through', () => {
    expect(classifyResponse(200, { symbol: 'EUR/USD', close: '1.1' })).toBe('ok');
  });
  it('does not rotate keys on a bad symbol', () => {
    expect(classifyResponse(404, { status: 'error', code: 404, message: 'symbol not found' })).toBe('error');
  });
});

describe('cooldownFor', () => {
  const now = Date.UTC(2026, 8, 16, 10, 0, 0);
  it('parks a key for a minute on a per-minute limit', () => {
    expect(cooldownFor('You have run out of API credits for the current minute.', now)).toEqual({ scope: 'minute', ms: 60_000 });
  });
  it('parks a key until UTC midnight on a daily limit', () => {
    const { scope, ms } = cooldownFor('You have reached your daily API credits limit.', now);
    expect(scope).toBe('day');
    expect(ms).toBe(14 * 3_600_000); // 10:00 → 24:00 UTC
  });
});

describe('TwelveDataKeyPool', () => {
  const opts = (keys, now) => ({ keys, perMinute: 8, perDay: 800, now });

  it('drains key #1 before touching key #2', () => {
    let t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222'], () => t));
    for (let i = 0; i < 100; i++) {
      const lease = pool.acquire(8);
      expect(lease.index).toBe(0);
      pool.spend(lease.index, 8);
      t += 60_001; // new minute window each time
    }
    // key #1 is now at 800/800 for the day → pool moves on
    expect(pool.acquire(8).index).toBe(1);
  });

  it('fails over to the next key when the provider says "out of credits"', () => {
    const t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222', 'cccc3333'], () => t));
    expect(pool.acquire(1).index).toBe(0);
    pool.penalize(0, 'exhausted', 'You have reached your daily API credits limit.');
    expect(pool.acquire(1).index).toBe(1);
    pool.penalize(1, 'auth', 'invalid apikey');
    expect(pool.acquire(1).index).toBe(2);
  });

  it('never re-picks a rejected key, even after the daily reset', () => {
    let t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222'], () => t));
    pool.penalize(0, 'auth', 'invalid apikey');
    t = Date.UTC(2026, 8, 17, 10, 0, 0);
    expect(pool.acquire(1).index).toBe(1);
    expect(pool.snapshot().pool[0].state).toBe('rejected');
  });

  it('returns null and a retry time once every key is spent', () => {
    const t = Date.UTC(2026, 8, 16, 22, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222'], () => t));
    pool.penalize(0, 'exhausted', 'daily limit');
    pool.penalize(1, 'exhausted', 'daily limit');
    expect(pool.acquire(1)).toBeNull();
    expect(pool.retryAfterMs()).toBe(2 * 3_600_000); // 22:00 → midnight UTC
  });

  it('frees a per-minute cooldown once the minute passes', () => {
    let t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111'], () => t));
    pool.penalize(0, 'exhausted', 'run out of API credits for the current minute');
    expect(pool.acquire(1)).toBeNull();
    t += 60_001;
    expect(pool.acquire(1).index).toBe(0);
  });

  it('resets every key at UTC midnight', () => {
    let t = Date.UTC(2026, 8, 16, 23, 59, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222'], () => t));
    pool.spend(0, 800);
    expect(pool.acquire(1).index).toBe(1);
    t = Date.UTC(2026, 8, 17, 0, 0, 5);
    expect(pool.acquire(1).index).toBe(0);
    expect(pool.snapshot().usedToday).toBe(0);
  });

  it('reports the pooled budget without leaking key material', () => {
    const t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222', 'cccc3333'], () => t));
    const snap = pool.snapshot();
    expect(snap).toMatchObject({ keys: 3, available: 3, perMinuteTotal: 24, perDayTotal: 2400 });
    expect(snap.pool[0].label).toBe('••••1111');
    expect(JSON.stringify(snap)).not.toContain('aaaa1111');
  });

  it('skips a key that cannot pay for the whole batch', () => {
    const t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const pool = new TwelveDataKeyPool(opts(['aaaa1111', 'bbbb2222'], () => t));
    pool.spend(0, 5); // 3 credits left this minute
    expect(pool.acquire(7).index).toBe(1); // 7-symbol quote does not fit on #1
    expect(pool.acquire(3).index).toBe(0); // …but a smaller one does
  });
});

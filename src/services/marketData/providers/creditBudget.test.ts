import { describe, expect, it } from 'vitest';
import { ProviderError } from '../types';
import { CreditBudget } from './creditBudget';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('CreditBudget', () => {
  it('allows 7 credits then blocks the 8+7th within the same minute', () => {
    let t = Date.UTC(2026, 8, 16, 10, 0, 0);
    const b = new CreditBudget({ perMinute: 8, perDay: 800, now: () => t, storage: memoryStorage() });
    b.spend(7);
    expect(() => b.spend(7)).toThrow(ProviderError);
    try {
      b.spend(7);
    } catch (e) {
      expect((e as ProviderError).kind).toBe('rate_limit');
      expect((e as ProviderError).retryAfterMs).toBeGreaterThan(59_000);
    }
    t += 60_001;
    expect(() => b.spend(7)).not.toThrow();
  });

  it('enforces the daily cap and retries after UTC midnight', () => {
    let t = Date.UTC(2026, 8, 16, 22, 0, 0);
    const b = new CreditBudget({ perMinute: 800, perDay: 14, now: () => t, storage: memoryStorage() });
    b.spend(7);
    t += 61_000;
    b.spend(7);
    t += 61_000;
    let err: ProviderError | undefined;
    try {
      b.spend(7);
    } catch (e) {
      err = e as ProviderError;
    }
    expect(err?.message).toMatch(/daily limit/);
    expect(err?.retryAfterMs).toBeGreaterThan(60 * 60_000); // ~2h to midnight
    t = Date.UTC(2026, 8, 17, 0, 0, 5);
    expect(() => b.spend(7)).not.toThrow();
  });

  it('persists the daily count across instances', () => {
    const storage = memoryStorage();
    const t = Date.UTC(2026, 8, 16, 9, 0, 0);
    new CreditBudget({ perMinute: 8, perDay: 800, now: () => t, storage }).spend(7);
    expect(new CreditBudget({ perMinute: 8, perDay: 800, now: () => t, storage }).usedToday()).toBe(7);
  });
});

describe('CreditBudget.reserve', () => {
  it('waits for the minute window instead of failing', async () => {
    const b = new CreditBudget({ perMinute: 2, perDay: null, storage: memoryStorage() });
    await b.reserve(2);
    const started = Date.now();
    // window is 60s in real time – use a tiny maxWait to prove it throws when wait is too long
    await expect(b.reserve(1, undefined, 10)).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never waits on the daily cap', async () => {
    const b = new CreditBudget({ perMinute: 100, perDay: 3, storage: memoryStorage() });
    await b.reserve(3);
    await expect(b.reserve(1)).rejects.toThrow(/daily limit/);
  });
});

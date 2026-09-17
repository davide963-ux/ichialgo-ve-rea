import { describe, expect, it } from 'vitest';
import { formatStamp } from './time';

describe('formatStamp', () => {
  const now = new Date(2026, 5, 14, 18, 30).getTime();

  it('shows only the clock for today', () => {
    expect(formatStamp(new Date(2026, 5, 14, 9, 5).getTime(), now)).toBe('09:05');
  });

  it('adds the date for an earlier day, so 23:30 is not mistaken for tonight', () => {
    const stamp = formatStamp(new Date(2026, 5, 13, 23, 30).getTime(), now);
    expect(stamp).toMatch(/23:30$/);
    expect(stamp).not.toBe('23:30');
  });

  it('handles a missing timestamp', () => {
    expect(formatStamp(null, now)).toBe('—');
    expect(formatStamp(Number.NaN, now)).toBe('—');
  });
});

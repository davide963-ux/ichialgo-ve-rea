import { APP_LOCALE } from './locale';

/**
 * Parse RFC3339 timestamps safely. OANDA returns nanosecond precision
 * ("2024-06-14T12:00:00.000000000Z") which some JS engines reject,
 * so we trim the fraction to milliseconds first.
 */
export function parseRfc3339(value: string): number {
  const trimmed = value.replace(/\.(\d{3})\d*/, '.$1');
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : NaN;
}

/** "2024-06-14 12:00:00" or "2024-06-14" (UTC) → ms */
export function parseUtcDateTime(value: string): number {
  const iso = value.includes(' ') ? `${value.replace(' ', 'T')}Z` : `${value}T00:00:00Z`;
  return Date.parse(iso);
}

export function formatAgo(ms: number | null, now: number): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString(APP_LOCALE, { hour12: false });
}

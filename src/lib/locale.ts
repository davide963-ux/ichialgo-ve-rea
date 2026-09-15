/**
 * Browser locale, sanitised. Some environments report tags like
 * "en-US@posix" that make Intl (and the chart library) throw.
 */
function resolveLocale(): string {
  const candidates = [...(typeof navigator !== 'undefined' ? navigator.languages ?? [] : []), 'en-US'];
  for (const raw of candidates) {
    const tag = String(raw).split(/[@.]/)[0]!.replace('_', '-');
    try {
      if (tag && Intl.DateTimeFormat.supportedLocalesOf([tag]).length) return tag;
    } catch {
      /* invalid tag — try next */
    }
  }
  return 'en-US';
}

export const APP_LOCALE = resolveLocale();

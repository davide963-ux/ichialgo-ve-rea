/** Ichialgo logomark — two offset curves forming an Ichimoku "kumo" (cloud). */
export function KumoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#0D1512" stroke="#25392F" />
      <path d="M5 21 C 10 21, 11 12, 16 12 S 22 16, 27 9 L 27 14 C 22 20, 20 17, 16 17 S 10 25, 5 25 Z" fill="rgba(103,227,174,0.22)" />
      <path d="M5 21 C 10 21, 11 12, 16 12 S 22 16, 27 9" fill="none" stroke="#67E3AE" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 25 C 10 25, 12 17, 16 17 S 22 20, 27 14" fill="none" stroke="#39B982" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Bare kumo glyph for inline use (score tags, table cells).
 *
 * The ☁ character is not in IBM Plex Mono, so it renders as a tofu box in
 * the numeric UI — this draws the same two-span shape as the logomark
 * instead, and inherits `currentColor` so it tints with the tag.
 */
export function KumoGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: '0 0 auto' }}>
      <path
        d="M4 20 C 9 20, 10 11, 16 11 S 22 15, 28 8 L 28 14 C 22 20, 20 17, 16 17 S 9 26, 4 26 Z"
        fill="currentColor"
        opacity="0.28"
      />
      <path d="M4 20 C 9 20, 10 11, 16 11 S 22 15, 28 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

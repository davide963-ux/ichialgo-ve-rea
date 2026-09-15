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

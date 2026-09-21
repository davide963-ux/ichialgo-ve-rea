/**
 * Equity curve — what the account would have done, trade by trade.
 *
 * A single series over time, so: one line, one hue, no legend (the heading
 * names it), and a direct label on the last point only. Grid and axes stay
 * recessive; the data is the only thing with colour.
 *
 * WHY THIS CHART EXISTS
 * ─────────────────────
 * "Total R +14.0" is a number you have to decode. A curve is read instantly —
 * you can see whether the gain came in one lucky trade or steadily, and how
 * deep it went underwater on the way. That is the question a trader actually
 * asks, and no table answers it.
 *
 * The baseline is the starting balance, drawn dashed, so above and below it
 * are immediately distinguishable without a second colour.
 */
import { useId, useState } from 'react';

export interface EquityPoint {
  /** 1-based trade number. */
  n: number;
  balance: number;
  /** Result of the trade that produced this point, in R. */
  r: number;
  label: string;
}

interface Props {
  points: readonly EquityPoint[];
  startingBalance: number;
  currency?: string;
  height?: number;
}

const money = (v: number, currency: string) =>
  `${v < 0 ? '−' : ''}${currency}${Math.abs(Math.round(v)).toLocaleString()}`;

export function EquityCurve({ points, startingBalance, currency = '$', height = 180 }: Props) {
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);

  // Start at the opening balance so the first trade has something to move from.
  const series = [{ n: 0, balance: startingBalance, r: 0, label: 'Start' }, ...points];
  if (series.length < 2) return null;

  const W = 720;
  const H = height;
  const PAD = { top: 16, right: 64, bottom: 24, left: 8 };

  const values = series.map((p) => p.balance);
  const lo = Math.min(...values, startingBalance);
  const hi = Math.max(...values, startingBalance);
  // Pad the range so the line never touches the frame.
  const span = hi - lo || Math.max(1, startingBalance * 0.01);
  const yMin = lo - span * 0.12;
  const yMax = hi + span * 0.12;

  const x = (i: number) => PAD.left + (i / (series.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${path} L${x(series.length - 1).toFixed(1)},${y(yMin).toFixed(1)} L${x(0).toFixed(1)},${y(yMin).toFixed(1)} Z`;

  const last = series[series.length - 1]!;
  const up = last.balance >= startingBalance;
  const baselineY = y(startingBalance);
  const active = hover === null ? null : series[hover];

  return (
    <figure className="equity-figure">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="equity-svg"
        role="img"
        aria-label={`Account balance over ${points.length} trades, ending at ${money(last.balance, currency)}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
          <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mint)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--mint)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Starting balance. Dashed so it reads as a reference, not data. */}
        <line x1={PAD.left} x2={W - PAD.right} y1={baselineY} y2={baselineY} className="equity-baseline" />
        <text x={W - PAD.right + 6} y={baselineY + 3} className="equity-baseline-label">
          start
        </text>

        <g clipPath={`url(#${clipId})`}>
          <path d={area} fill={`url(#${clipId}-fill)`} />
          <path d={path} className="equity-line" />
        </g>

        {/* Final value, direct-labelled. The only point that gets a number. */}
        <circle cx={x(series.length - 1)} cy={y(last.balance)} r={4.5} className="equity-dot" />
        <text
          x={W - PAD.right + 6}
          y={y(last.balance) + 4}
          className={`equity-end ${up ? 'pos' : 'neg'}`}
        >
          {money(last.balance, currency)}
        </text>

        {/* Hover layer: one wide hit target per trade, bigger than the mark. */}
        {series.map((_, i) => (
          <rect
            key={i}
            x={x(i) - (W - PAD.left - PAD.right) / (series.length - 1) / 2}
            y={0}
            width={(W - PAD.left - PAD.right) / (series.length - 1)}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {active && (
          <g pointerEvents="none">
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={H - PAD.bottom} className="equity-crosshair" />
            <circle cx={x(hover!)} cy={y(active.balance)} r={5} className="equity-dot" />
          </g>
        )}
      </svg>

      <figcaption className="equity-caption">
        {active && active.n > 0 ? (
          <>
            <strong>Trade {active.n}</strong> · {active.label} · {active.r > 0 ? '+' : ''}
            {active.r.toFixed(2)}R · balance {money(active.balance, currency)}
          </>
        ) : (
          <>Hover the line to see each trade. Dashed line is the starting balance.</>
        )}
      </figcaption>
    </figure>
  );
}

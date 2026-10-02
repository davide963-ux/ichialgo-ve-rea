/**
 * Equity curve — what the strategy did, trade by trade, in R.
 *
 * A single series over time, so: one line, one hue, no legend (the heading
 * names it), and a direct label on the last point only. Grid and axes stay
 * recessive; the data is the only thing with colour.
 *
 * WHY THIS CHART EXISTS
 * ─────────────────────
 * "Total +164R" is a number you have to decode. A curve is read instantly —
 * whether the gain arrived in one lucky trade or steadily, and how deep it
 * went underwater on the way. That is the question a trader actually asks,
 * and no table answers it.
 *
 * WHY R AND NOT MONEY
 * ───────────────────
 * Money would need a balance and a risk percentage, and then the shape of the
 * curve would depend on whether you compounded — a decision about position
 * sizing, dressed up as a result about the strategy. R has no such knob.
 *
 * The zero line is drawn dashed, so above and below it are distinguishable
 * without spending a second colour on it.
 */
import { useId, useRef, useState } from 'react';

export interface EquityPoint {
  /** 1-based trade number. */
  n: number;
  /** Cumulative R after this trade. */
  cumR: number;
  /** This trade's own result, in R. */
  r: number;
  label: string;
}

interface Props {
  points: readonly EquityPoint[];
  height?: number;
}

const fmtR = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}R`;

export function EquityCurve({ points, height = 200 }: Props) {
  const clipId = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Start at zero so the first trade has something to move from.
  const series: EquityPoint[] = [{ n: 0, cumR: 0, r: 0, label: 'Start' }, ...points];
  if (series.length < 2) return null;

  const W = 720;
  const H = height;
  const PAD = { top: 16, right: 64, bottom: 24, left: 8 };

  const values = series.map((p) => p.cumR);
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const span = hi - lo || 1;
  const yMin = lo - span * 0.12;
  const yMax = hi + span * 0.12;

  const plotW = W - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (i / (series.length - 1)) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`).join(' ');
  const area = `${path} L${x(series.length - 1).toFixed(1)},${y(yMin).toFixed(1)} L${x(0).toFixed(1)},${y(yMin).toFixed(1)} Z`;

  const last = series[series.length - 1]!;
  const up = last.cumR >= 0;
  const zeroY = y(0);
  const active = hover === null ? null : series[hover];

  /**
   * One hover surface, not one per trade. A backtest can hold a thousand
   * trades, and a thousand invisible rects is a thousand DOM nodes to lay
   * out for a crosshair.
   */
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.left) / plotW) * (series.length - 1));
    setHover(Math.min(series.length - 1, Math.max(0, i)));
  };

  return (
    <figure className="equity-figure">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="equity-svg"
        role="img"
        aria-label={`Cumulative R over ${points.length} trades, ending at ${fmtR(last.cumR)}`}
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

        {/* Break-even. Dashed so it reads as a reference, not as data. */}
        <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} className="equity-baseline" />
        <text x={W - PAD.right + 6} y={zeroY + 3} className="equity-baseline-label">
          0R
        </text>

        <g clipPath={`url(#${clipId})`}>
          <path d={area} fill={`url(#${clipId}-fill)`} />
          <path d={path} className="equity-line" />
        </g>

        {/* Final value, direct-labelled. The only point that gets a number. */}
        <circle cx={x(series.length - 1)} cy={y(last.cumR)} r={4.5} className="equity-dot" />
        <text x={W - PAD.right + 6} y={y(last.cumR) + 4} className={`equity-end ${up ? 'pos' : 'neg'}`}>
          {fmtR(last.cumR)}
        </text>

        <rect x={0} y={0} width={W} height={H} fill="transparent" onMouseMove={onMove} />

        {active && (
          <g pointerEvents="none">
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={H - PAD.bottom} className="equity-crosshair" />
            <circle cx={x(hover!)} cy={y(active.cumR)} r={5} className="equity-dot" />
          </g>
        )}
      </svg>

      <figcaption className="equity-caption">
        {active && active.n > 0 ? (
          <>
            <strong>Trade {active.n}</strong> · {active.label} · {active.r > 0 ? '+' : ''}
            {active.r.toFixed(2)}R · running {fmtR(active.cumR)}
          </>
        ) : (
          <>Hover the line to see each trade. The dashed line is break-even.</>
        )}
      </figcaption>
    </figure>
  );
}

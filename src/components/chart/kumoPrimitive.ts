/**
 * Kumo (Ichimoku cloud) fill, as a Lightweight Charts series primitive.
 *
 * Lightweight Charts has no band series, so the two Senkou spans are drawn as
 * ordinary line series and this primitive paints the area between them —
 * behind the candles (`zOrder: 'bottom'`), green where Senkou A is above B
 * and red where it is below.
 *
 *   spanA ╲      ╱▔▔▔▔▔        A above B → bullish cloud (green)
 *          ╲    ╱
 *   ░░░░░░░░╳░░░░░░░░░░        the crossing is where the colour flips
 *          ╱    ╲
 *   spanB ╱      ╲▁▁▁▁▁        A below B → bearish cloud (red)
 *
 * The fill is built from one quad per bar gap, coloured by the sign of
 * (A − B) on that gap, so a crossing costs at most one bar of colour
 * imprecision and needs no intersection maths.
 *
 * Coordinates: `timeToCoordinate` only resolves times the time scale knows
 * about, which is why the spans are real line series — their data (including
 * the 26 bars of leading cloud) is what extends the scale into the future.
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  IChartApiBase,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export interface KumoPoint {
  time: UTCTimestamp;
  spanA: number;
  spanB: number;
}

export interface KumoColors {
  bullish: string;
  bearish: string;
}

interface Resolved {
  x: number;
  a: number;
  b: number;
  bullish: boolean;
}

class KumoRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly points: readonly Resolved[],
    private readonly colors: KumoColors,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (this.points.length < 2) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (let i = 1; i < this.points.length; i++) {
        const p = this.points[i - 1]!;
        const q = this.points[i]!;
        ctx.beginPath();
        ctx.moveTo(p.x * hr, p.a * vr);
        ctx.lineTo(q.x * hr, q.a * vr);
        ctx.lineTo(q.x * hr, q.b * vr);
        ctx.lineTo(p.x * hr, p.b * vr);
        ctx.closePath();
        // Colour by the left edge; a crossing flips it within one bar.
        ctx.fillStyle = p.bullish ? this.colors.bullish : this.colors.bearish;
        ctx.fill();
      }
    });
  }
}

class KumoPaneView implements IPrimitivePaneView {
  constructor(private readonly primitive: KumoPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom'; // behind the candles, like every charting package draws it
  }

  renderer(): IPrimitivePaneRenderer | null {
    const resolved = this.primitive.resolve();
    return resolved.length < 2 ? null : new KumoRenderer(resolved, this.primitive.colors);
  }
}

export class KumoPrimitive implements ISeriesPrimitive<Time> {
  private points: readonly KumoPoint[] = [];
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly view = new KumoPaneView(this);

  constructor(readonly colors: KumoColors) {}

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  setData(points: readonly KumoPoint[]): void {
    this.points = points;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** Price/time → pixels, dropping anything currently off-scale. */
  resolve(): Resolved[] {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return [];
    const timeScale = chart.timeScale();
    const out: Resolved[] = [];
    for (const p of this.points) {
      const x = timeScale.timeToCoordinate(p.time);
      const a = series.priceToCoordinate(p.spanA);
      const b = series.priceToCoordinate(p.spanB);
      if (x === null || a === null || b === null) continue;
      out.push({ x, a, b, bullish: p.spanA >= p.spanB });
    }
    return out;
  }
}

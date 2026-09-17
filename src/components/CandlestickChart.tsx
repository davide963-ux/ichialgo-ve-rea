/**
 * Candlestick chart (TradingView Lightweight Charts v5).
 *
 *  props.candles change
 *      │
 *      ├─ new symbol/timeframe ─────────────▶ series.setData() + frame last 120 bars
 *      ├─ same series, ≤2 bars changed ─────▶ series.update() (cheap, keeps user zoom)
 *      └─ anything else ────────────────────▶ series.setData()
 *
 * The chart autosizes with its container (ResizeObserver), so it
 * follows responsive layout changes.
 *
 * Overlays (optional props, all index-aligned with `candles`):
 *   ema      — the EMA50 line. Nulls before the average is defined are
 *              dropped, so the line simply starts later; never drawn at 0.
 *   signals  — one marker per EMA touch, above or below the bar depending on
 *              which side price approached from.
 *   ichimoku — Tenkan, Kijun, Chikou and the Kumo. The cloud is drawn 26 bars
 *              into the future, past the last candle: the span line series
 *              carry those points, which is what extends the time scale, and
 *              KumoPrimitive fills between them behind the candles.
 */
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { getPair } from '../config/pairs';
import { EMA50_TOUCH } from '../config/strategy';
import { TIMEFRAME_SECONDS, type Timeframe } from '../config/timeframes';
import { futureCloud, type IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';
import type { TouchSignal } from '../services/strategy';
import { APP_LOCALE } from '../lib/locale';
import { KumoPrimitive, type KumoPoint } from './chart/kumoPrimitive';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** EMA50 values, index-aligned with `candles`. */
  ema?: (number | null)[];
  /** Touches to mark on the bars. */
  signals?: TouchSignal[];
  /** Ichimoku overlay; omit (or pass showIchimoku=false) to hide it. */
  ichimoku?: IchimokuSeries;
  showIchimoku?: boolean;
}

const VISIBLE_BARS = 120;
const EMA_COLOR = '#E9B949';
const ICHIMOKU = {
  tenkan: '#5BC8F5',
  kijun: '#C58AF9',
  spanA: 'rgba(103, 227, 174, 0.55)',
  spanB: 'rgba(240, 97, 109, 0.55)',
  chikou: 'rgba(127, 145, 137, 0.9)',
  cloudBullish: 'rgba(103, 227, 174, 0.10)',
  cloudBearish: 'rgba(240, 97, 109, 0.10)',
};

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

export function CandlestickChart({ symbol, timeframe, candles, ema, signals, ichimoku, showIchimoku = true }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const ichi = useRef<{
    tenkan: ISeriesApi<'Line'>;
    kijun: ISeriesApi<'Line'>;
    spanA: ISeriesApi<'Line'>;
    spanB: ISeriesApi<'Line'>;
    chikou: ISeriesApi<'Line'>;
    kumo: KumoPrimitive;
  } | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const shown = useRef<{ key: string; candles: Candle[] }>({ key: '', candles: [] });

  // Create once
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0D1512' },
        textColor: '#7F9189',
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(27, 43, 37, 0.6)' },
        horzLines: { color: 'rgba(27, 43, 37, 0.6)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#39B982', labelBackgroundColor: '#16241F' },
        horzLine: { color: '#39B982', labelBackgroundColor: '#16241F' },
      },
      localization: { locale: APP_LOCALE },
      rightPriceScale: { borderColor: '#1B2B25' },
      timeScale: { borderColor: '#1B2B25', rightOffset: 4 },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: '#67E3AE',
      downColor: '#F0616D',
      borderVisible: false,
      wickUpColor: '#67E3AE',
      wickDownColor: '#F0616D',
    });
    emaSeries.current = c.addSeries(LineSeries, {
      color: EMA_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: `EMA${EMA50_TOUCH.period}`,
    });
    // Ichimoku, added before the markers so the cloud sits underneath.
    const thin = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const spanA = c.addSeries(LineSeries, { ...thin, color: ICHIMOKU.spanA, title: 'Senkou A' });
    const spanB = c.addSeries(LineSeries, { ...thin, color: ICHIMOKU.spanB, title: 'Senkou B' });
    const kumo = new KumoPrimitive({ bullish: ICHIMOKU.cloudBullish, bearish: ICHIMOKU.cloudBearish });
    spanA.attachPrimitive(kumo);
    ichi.current = {
      spanA,
      spanB,
      kumo,
      tenkan: c.addSeries(LineSeries, { ...thin, lineWidth: 2, color: ICHIMOKU.tenkan, title: 'Tenkan' }),
      kijun: c.addSeries(LineSeries, { ...thin, lineWidth: 2, color: ICHIMOKU.kijun, title: 'Kijun' }),
      chikou: c.addSeries(LineSeries, { ...thin, color: ICHIMOKU.chikou, lineStyle: 2, title: 'Chikou' }),
    };

    markers.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      emaSeries.current = null;
      ichi.current = null;
      markers.current = null;
      shown.current = { key: '', candles: [] };
    };
  }, []);

  // Per symbol/timeframe formatting
  useEffect(() => {
    const digits = getPair(symbol).digits;
    const priceFormat = { type: 'price', precision: digits, minMove: 1 / 10 ** digits } as const;
    series.current?.applyOptions({ priceFormat });
    emaSeries.current?.applyOptions({ priceFormat });
    if (ichi.current) {
      for (const line of [ichi.current.tenkan, ichi.current.kijun, ichi.current.spanA, ichi.current.spanB, ichi.current.chikou]) {
        line.applyOptions({ priceFormat });
      }
    }
    chart.current?.applyOptions({
      timeScale: { timeVisible: timeframe !== '1D', secondsVisible: false },
    });
  }, [symbol, timeframe]);

  // Data
  useEffect(() => {
    const s = series.current;
    const c = chart.current;
    if (!s || !c) return;
    const key = `${symbol}|${timeframe}`;
    const prev = shown.current;

    if (candles.length === 0) {
      s.setData([]);
      shown.current = { key, candles };
      return;
    }

    const sameSeries = prev.key === key && prev.candles.length > 0 && prev.candles[0]?.time === candles[0]?.time;
    const added = candles.length - prev.candles.length;

    if (sameSeries && added >= 0 && added <= 2) {
      for (let i = Math.max(0, prev.candles.length - 1); i < candles.length; i++) {
        s.update(toBar(candles[i]!));
      }
    } else {
      s.setData(candles.map(toBar));
      if (prev.key !== key) {
        c.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - VISIBLE_BARS),
          to: candles.length + 3,
        });
      }
    }
    shown.current = { key, candles };
  }, [candles, symbol, timeframe]);

  // EMA overlay. Nulls (before the average exists) are skipped rather than
  // plotted, so the line starts where the EMA becomes valid.
  useEffect(() => {
    const line = emaSeries.current;
    if (!line) return;
    if (!ema || ema.length === 0) {
      line.setData([]);
      return;
    }
    const points: LineData<UTCTimestamp>[] = [];
    for (let i = 0; i < candles.length && i < ema.length; i++) {
      const v = ema[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      points.push({ time: candles[i]!.time as UTCTimestamp, value: v });
    }
    line.setData(points);
  }, [ema, candles]);

  // Ichimoku overlay. Tenkan/Kijun sit over the candles; both Senkou spans
  // continue `displacement` bars past the last candle — those extra points are
  // what put the future bars on the time scale, so the leading cloud can be
  // drawn at all. Chikou is already index-aligned as it is drawn (chikou[i] is
  // the close of bar i + displacement), so it needs no shifting here.
  useEffect(() => {
    const o = ichi.current;
    if (!o) return;
    const clear = () => {
      for (const line of [o.tenkan, o.kijun, o.spanA, o.spanB, o.chikou]) line.setData([]);
      o.kumo.setData([]);
    };
    if (!showIchimoku || !ichimoku || candles.length === 0) {
      clear();
      return;
    }

    const line = (values: (number | null)[]): LineData<UTCTimestamp>[] => {
      const out: LineData<UTCTimestamp>[] = [];
      for (let i = 0; i < candles.length && i < values.length; i++) {
        const v = values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        out.push({ time: candles[i]!.time as UTCTimestamp, value: v });
      }
      return out;
    };

    const spanA = line(ichimoku.senkouA);
    const spanB = line(ichimoku.senkouB);

    // The leading cloud: bar times do not exist yet, so extrapolate them from
    // the timeframe's own bar spacing.
    const step = TIMEFRAME_SECONDS[timeframe];
    const lastTime = candles.at(-1)!.time;
    for (const point of futureCloud(ichimoku, candles.length)) {
      const time = (lastTime + point.offset * step) as UTCTimestamp;
      if (point.senkouA !== null && Number.isFinite(point.senkouA)) spanA.push({ time, value: point.senkouA });
      if (point.senkouB !== null && Number.isFinite(point.senkouB)) spanB.push({ time, value: point.senkouB });
    }

    o.tenkan.setData(line(ichimoku.tenkan));
    o.kijun.setData(line(ichimoku.kijun));
    o.chikou.setData(line(ichimoku.chikou));
    o.spanA.setData(spanA);
    o.spanB.setData(spanB);

    // The fill needs both edges at the same time, so pair them up by time.
    const bByTime = new Map(spanB.map((p) => [p.time, p.value]));
    const kumo: KumoPoint[] = [];
    for (const a of spanA) {
      const b = bByTime.get(a.time);
      if (b === undefined) continue;
      kumo.push({ time: a.time as UTCTimestamp, spanA: a.value, spanB: b });
    }
    o.kumo.setData(kumo);
  }, [ichimoku, showIchimoku, candles, timeframe]);

  // Touch markers: below the bar for a pullback from above, above it for a
  // rally from below — the marker sits on the side price came from.
  useEffect(() => {
    const plugin = markers.current;
    if (!plugin) return;
    const list: SeriesMarker<Time>[] = (signals ?? [])
      .filter((s) => s.symbol === symbol && s.timeframe === timeframe)
      .sort((a, b) => a.barTime - b.barTime)
      .map((s) => ({
        time: s.barTime as UTCTimestamp,
        position: s.approach === 'above' ? 'belowBar' : 'aboveBar',
        shape: s.approach === 'above' ? 'arrowUp' : 'arrowDown',
        color: s.counterTrend ? '#7F9189' : s.bias === 'short' ? '#F0616D' : EMA_COLOR,
        // No label: touches cluster, and the arrow plus the named EMA line
        // already say what the marker is.
        size: 1,
      }));
    plugin.setMarkers(list);
  }, [signals, symbol, timeframe]);

  return <div ref={el} className="chart-canvas" aria-label={`${symbol} ${timeframe} candlestick chart`} role="img" />;
}

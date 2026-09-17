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
 * Overlays (optional props, both index-aligned with `candles`):
 *   ema     — the EMA50 line. Nulls before the average is defined are
 *             dropped, so the line simply starts later; it is never drawn at 0.
 *   signals — one marker per EMA touch, above or below the bar depending on
 *             which side price approached from.
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
import type { Timeframe } from '../config/timeframes';
import type { Candle } from '../services/marketData';
import type { TouchSignal } from '../services/strategy';
import { APP_LOCALE } from '../lib/locale';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** EMA50 values, index-aligned with `candles`. */
  ema?: (number | null)[];
  /** Touches to mark on the bars. */
  signals?: TouchSignal[];
}

const VISIBLE_BARS = 120;
const EMA_COLOR = '#E9B949';

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

export function CandlestickChart({ symbol, timeframe, candles, ema, signals }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaSeries = useRef<ISeriesApi<'Line'> | null>(null);
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
    markers.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      emaSeries.current = null;
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

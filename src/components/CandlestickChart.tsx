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
 * follows responsive layout changes. No indicators / signals in Phase 1.
 */
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { getPair } from '../config/pairs';
import type { Timeframe } from '../config/timeframes';
import type { Candle } from '../services/marketData';
import { APP_LOCALE } from '../lib/locale';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
}

const VISIBLE_BARS = 120;

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

export function CandlestickChart({ symbol, timeframe, candles }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
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
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      shown.current = { key: '', candles: [] };
    };
  }, []);

  // Per symbol/timeframe formatting
  useEffect(() => {
    const digits = getPair(symbol).digits;
    series.current?.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits },
    });
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

  return <div ref={el} className="chart-canvas" aria-label={`${symbol} ${timeframe} candlestick chart`} role="img" />;
}

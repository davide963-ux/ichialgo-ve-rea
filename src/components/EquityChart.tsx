/**
 * Equity curve (Lightweight Charts area series).
 *
 * The x axis is the closing time of each trade, not calendar time, so the
 * line only moves when the account does. A flat stretch means no trades, not
 * a flat market.
 */
import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { APP_LOCALE } from '../lib/locale';

export function EquityChart({ points, startingBalance }: { points: { time: number; balance: number }[]; startingBalance: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0D1512' },
        textColor: '#7F9189',
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: 'rgba(27, 43, 37, 0.6)' }, horzLines: { color: 'rgba(27, 43, 37, 0.6)' } },
      localization: { locale: APP_LOCALE },
      rightPriceScale: { borderColor: '#1B2B25' },
      timeScale: { borderColor: '#1B2B25', timeVisible: true, secondsVisible: false },
      handleScale: false,
      handleScroll: false,
    });
    series.current = c.addSeries(AreaSeries, {
      lineColor: '#67E3AE',
      topColor: 'rgba(103, 227, 174, 0.28)',
      bottomColor: 'rgba(103, 227, 174, 0.02)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    // Below the opening balance the curve is a loss — colour it accordingly.
    const down = points.length > 1 && points.at(-1)!.balance < startingBalance;
    s.applyOptions({
      lineColor: down ? '#F0616D' : '#67E3AE',
      topColor: down ? 'rgba(240, 97, 109, 0.28)' : 'rgba(103, 227, 174, 0.28)',
      bottomColor: down ? 'rgba(240, 97, 109, 0.02)' : 'rgba(103, 227, 174, 0.02)',
    });
    // Several trades can close on the same bar; the series needs unique,
    // ascending times, so identical stamps are nudged one second apart.
    let last = -1;
    s.setData(
      points.map((p) => {
        const time = Math.max(p.time, last + 1);
        last = time;
        return { time: time as UTCTimestamp, value: p.balance };
      }),
    );
    chart.current?.timeScale().fitContent();
  }, [points, startingBalance]);

  return <div ref={el} className="chart-canvas" style={{ height: 260 }} aria-label="Equity curve" role="img" />;
}

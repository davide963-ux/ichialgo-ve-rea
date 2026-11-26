/**
 * OANDA's "Tenkan/Kijun trend continuation pullback", implemented verbatim.
 *
 * Source: OANDA, "Ichimoku Cloud trading guide: key strategies". The article
 * describes the strategy as one that "focuses on initiating long positions
 * near support during a strong uptrend and identifying short opportunities
 * near resistance in a strong downtrend".
 *
 * THE RULES, QUOTED
 * ─────────────────
 * Bullish set-ups — "Price above the Cloud (green coloured)."
 *   - "Tenkan-sen (Conversion line) is above Kijun-sen (Base line)."
 *   - "Pullback touches or dips slightly below Tenkan-sen (Conversion line)
 *      or Kijun-sen (Base line)."
 *   - "Price closes above Kijun-sen (Base line) with a bullish candlestick."
 *
 * Bearish set-ups — "Price below the Cloud (red coloured)."
 *   - "Tenkan-sen (Conversion line) is below Kijun-sen (Base line)"
 *   - "Pullback touches or rebounds slightly above Tenkan-sen (Conversion
 *      Line) or Kijun-sen (Base line)"
 *   - "Price closes below Kijun-sen (Base line) with a bearish candlestick"
 *
 * WHAT IS DELIBERATELY ABSENT
 * ───────────────────────────
 * No cloud colour, no forward cloud, no Chikou. All three gate OUR strategy
 * and none of them appears in OANDA's pullback rules — in their article
 * Chikou is a separate filter, attached to the Kumo breakout. Adding them
 * here because they seemed sensible would make this a third strategy wearing
 * OANDA's name, and the whole point of having it is to measure what their
 * published rules actually do.
 *
 * WHY THIS IS A STATE MACHINE AND NOT A SINGLE-BAR TEST
 * ────────────────────────────────────────────────────
 * The pullback and the confirming close are different events on different
 * bars. In the article's USD/JPY example the dip below the base line is in
 * the morning of 18 November and the confirming hourly close at 1pm SGT —
 * "The bullish opportunity arose when the hourly candlestick turned bullish
 * with an hourly close above the Kijun-sen (Base line) at 1 pm SGT". So a
 * touch ARMS the setup and the first qualifying close FIRES it.
 *
 * The stop and target are not OANDA's — the article gives none. See
 * signalTicket.ts.
 */
import { OANDA_PULLBACK, type OandaPullbackConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { Candle } from '../marketData';
import { bearishCandle, bullishCandle, ichimokuContext, minBarsFor, px, type BarFacts } from './ichimokuBars';
import { buildSignal } from './signalTicket';
import type { Direction, IchimokuLevel, IchimokuSignal, SignalCheck } from './types';

export const STRATEGY = 'oanda-pullback' as const;

export interface PullbackAnalysis {
  signals: IchimokuSignal[];
  level: IchimokuLevel | null;
  reason: 'ok' | 'not-enough-bars';
}

export const minBars = (config: OandaPullbackConfig = OANDA_PULLBACK): number =>
  minBarsFor(config.rangePeriod);

/**
 * Did this bar pull back into the lines?
 *
 * "Touches or dips slightly below Tenkan-sen or Kijun-sen" for a long. With
 * Tenkan above Kijun — which the setup requires — Tenkan is the nearer line,
 * so reaching EITHER means the low reached Tenkan. Which line it actually got
 * to is reported, because a dip to Kijun is a deeper pullback than a dip to
 * Tenkan and a reader should be able to see which happened.
 */
function pullbackLine(bar: Candle, tenkan: number | null, kijun: number, long: boolean): 'tenkan' | 'kijun' | null {
  if (long) {
    if (bar.low <= kijun) return 'kijun';
    if (tenkan !== null && bar.low <= tenkan) return 'tenkan';
    return null;
  }
  if (bar.high >= kijun) return 'kijun';
  if (tenkan !== null && bar.high >= tenkan) return 'tenkan';
  return null;
}

/** The two standing conditions. Both must hold at the touch AND at the close. */
function setupHolds(f: BarFacts, long: boolean): boolean {
  if (long ? f.side !== 'above' : f.side !== 'below') return false;
  if (f.tenkan === null) return false;
  return long ? f.tenkan > f.kijun : f.tenkan < f.kijun;
}

/** What the strategy is waiting for, between the touch and the close. */
interface Pending {
  direction: Direction;
  /** Bar index the pullback touched on. */
  touchedAt: number;
  line: 'tenkan' | 'kijun';
  /** The low (long) or high (short) the pullback reached. */
  extreme: number;
}

export function analyseOandaPullback(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: OandaPullbackConfig = OANDA_PULLBACK,
  detectedAt = Date.now(),
): PullbackAnalysis {
  const ctx = ichimokuContext(candles, symbol, config.rangePeriod);

  if (candles.length < minBars(config)) {
    return { signals: [], level: null, reason: 'not-enough-bars' };
  }

  const signals: IchimokuSignal[] = [];
  let pending: Pending | null = null;
  let level: IchimokuLevel | null = null;

  for (let i = 1; i < candles.length; i++) {
    const f = ctx.at(i);
    const last = i === candles.length - 1;
    if (!f) continue;

    const long = f.side === 'above';
    const short = f.side === 'below';

    // A setup whose standing conditions have broken is dead, not merely
    // waiting: price back inside the cloud or Tenkan crossing back is the
    // trend the strategy was joining ceasing to exist.
    if (pending && !setupHolds(f, pending.direction === 'LONG')) pending = null;
    if (pending && i - pending.touchedAt > config.confirmWithinBars) pending = null;

    if (last) {
      level = {
        symbol,
        timeframe,
        strategy: STRATEGY,
        kijun: f.kijun,
        tenkan: f.tenkan,
        // The zone the live watcher follows is the gap between price and the
        // lines, so the band is reported as the Tenkan/Kijun spread.
        band: f.tenkan === null ? 0 : Math.abs(f.tenkan - f.kijun),
        range: f.range,
        direction: long ? 'LONG' : short ? 'SHORT' : null,
        side: f.side,
        armed: pending === null,
        inBand: pending !== null,
        barTime: f.bar.time,
        updatedAt: detectedAt,
        senkouA: f.senkouA,
        senkouB: f.senkouB,
        senkouAheadA: f.aheadA,
        senkouAheadB: f.aheadB,
        cloudBullish: f.cloudBullish,
        tenkanAgrees: f.tenkan === null ? false : long ? f.tenkan > f.kijun : f.tenkan < f.kijun,
        backHigh: f.back?.high ?? null,
        backLow: f.back?.low ?? null,
        backClose: f.back?.close ?? null,
      };
    }

    if (!long && !short) continue; // inside the cloud: no trend to continue
    if (!setupHolds(f, long)) continue;

    const direction: Direction = long ? 'LONG' : 'SHORT';

    // ── the confirming close, if a pullback is already waiting ───────────
    if (pending && pending.direction === direction && i > pending.touchedAt) {
      const closedThrough = long ? f.bar.close > f.kijun : f.bar.close < f.kijun;
      const candleAgrees = long ? bullishCandle(f.bar) : bearishCandle(f.bar);

      if (closedThrough && candleAgrees) {
        const checks: SignalCheck[] = [
          {
            label: `Price ${long ? 'above' : 'below'} the Cloud`,
            pass: true,
            detail: `close ${px(f.bar.close)} is ${f.side} the Kumo (${px(f.senkouA)} / ${px(f.senkouB)})`,
            required: true,
          },
          {
            label: `Tenkan ${long ? 'above' : 'below'} Kijun`,
            pass: true,
            detail: `${px(f.tenkan)} vs ${px(f.kijun)}`,
            required: true,
          },
          {
            label: `Pullback reached ${pending.line === 'kijun' ? 'Kijun-sen' : 'Tenkan-sen'}`,
            pass: true,
            detail:
              `${i - pending.touchedAt} bar${i - pending.touchedAt === 1 ? '' : 's'} ago, ` +
              `${long ? 'low' : 'high'} ${px(pending.extreme)}`,
            required: true,
          },
          {
            label: `Closed ${long ? 'above' : 'below'} Kijun with a ${long ? 'bullish' : 'bearish'} candle`,
            pass: true,
            detail: `open ${px(f.bar.open)} -> close ${px(f.bar.close)}, Kijun ${px(f.kijun)}`,
            required: true,
          },
        ];

        signals.push(
          buildSignal({
            strategy: STRATEGY,
            symbol,
            timeframe,
            facts: f,
            detectedAt,
            source: 'candle',
            direction,
            entry: f.bar.close,
            checks,
          }),
        );
        pending = null;
        continue;
      }
    }

    // ── a pullback touch arms (or re-arms) the setup ─────────────────────
    const line = pullbackLine(f.bar, f.tenkan, f.kijun, long);
    if (line) {
      pending = { direction, touchedAt: i, line, extreme: long ? f.bar.low : f.bar.high };
    }
  }

  return { signals, level, reason: 'ok' };
}

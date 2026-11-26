/**
 * OANDA's "Kumo (Cloud) breakout", implemented verbatim, with their Chikou
 * span confirmation filter attached as the article attaches it.
 *
 * Source: OANDA, "Ichimoku Cloud trading guide: key strategies". The article
 * introduces it as a strategy "utilized for early trend identification after
 * consolidation".
 *
 * THE RULES, QUOTED
 * ─────────────────
 * Bullish:
 *   - "Price breaks above the cloud."
 *   - "Cloud is turning bullish (Span A crossing above span B)"
 * Bearish:
 *   - "Price breaks below the cloud."
 *   - "Cloud is turning bearish (Span A crossing below span B)"
 *
 * The Chikou filter, from its own section:
 *   "the lagging span is being used as a trend confirmation tool to filter
 *    out false breakouts from prior consolidation/sideways ranges. Hence, it
 *    can be used in conjunction with the Kumo (Cloud) breakout strategy."
 *   Bullish: Chikou "above its prior 26-period price". Bearish: "below its
 *   prior 26-period price".
 *
 * NOTE WHAT CHIKOU IS COMPARED WITH
 * ─────────────────────────────────
 * OANDA compares the lagging span with "its prior 26-period PRICE" — that
 * bar's close. Our own strategy uses the stricter test of clearing that bar's
 * whole range (its high for a long). Both are defensible and they are not the
 * same rule, so this file uses OANDA's, and ours keeps ours. Quietly applying
 * one definition under both names is exactly how two strategies stop being
 * comparable.
 *
 * WHY THE TWIST MAY ARRIVE AFTER THE BREAK
 * ────────────────────────────────────────
 * "To increase the probability of this bullish trend change, we can wait for
 * the Span A to cross above the Span B ... to establish a bullish set-up."
 *
 * In both of the article's worked examples it did arrive later: AUD/USD broke
 * above the cloud at 1am SGT on 26 Nov and Span A crossed at 4am; NZD/USD
 * broke down on 18 Nov at 2am and Span A crossed on 19 Nov at 4am, 26 hours
 * afterwards. Requiring both on a single bar would reject both of OANDA's own
 * illustrations, so the break arms the setup, the twist completes it, and the
 * signal is dated to whichever came second.
 *
 * The stop and target are not OANDA's — the article gives none. See
 * signalTicket.ts.
 */
import { OANDA_BREAKOUT, type OandaBreakoutConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { Candle } from '../marketData';
import { ichimokuContext, minBarsFor, px, type BarFacts } from './ichimokuBars';
import { buildSignal } from './signalTicket';
import type { Direction, IchimokuLevel, IchimokuSignal, SignalCheck } from './types';

export const STRATEGY = 'oanda-breakout' as const;

export interface BreakoutAnalysis {
  signals: IchimokuSignal[];
  level: IchimokuLevel | null;
  reason: 'ok' | 'not-enough-bars';
}

export const minBars = (config: OandaBreakoutConfig = OANDA_BREAKOUT): number =>
  minBarsFor(config.rangePeriod);

/** Is the leading cloud — the one being drawn 26 ahead — the trade's colour? */
function twisted(f: BarFacts, long: boolean): boolean | null {
  if (f.aheadA === null || f.aheadB === null) return null;
  return long ? f.aheadA > f.aheadB : f.aheadA < f.aheadB;
}

/**
 * OANDA's Chikou test: the lagging span against its prior 26-period price.
 *
 * The lagging span plotted at bar i−26 carries the close of bar i, so "above
 * its prior 26-period price" is `close[i] > close[i-26]`.
 */
function chikouFree(f: BarFacts, long: boolean): boolean | null {
  if (!f.back) return null;
  return long ? f.bar.close > f.back.close : f.bar.close < f.back.close;
}

/** A break is a transition: not through the cloud, then through it. */
interface Pending {
  direction: Direction;
  brokeAt: number;
  breakClose: number;
  /** Cloud thickness at the break, in pips — thick breaks are more significant. */
  cloudPips: number;
}

export function analyseOandaBreakout(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: OandaBreakoutConfig = OANDA_BREAKOUT,
  detectedAt = Date.now(),
): BreakoutAnalysis {
  const ctx = ichimokuContext(candles, symbol, config.rangePeriod);

  if (candles.length < minBars(config)) {
    return { signals: [], level: null, reason: 'not-enough-bars' };
  }

  const signals: IchimokuSignal[] = [];
  let pending: Pending | null = null;
  let prevSide: BarFacts['side'] | null = null;
  let level: IchimokuLevel | null = null;

  for (let i = 1; i < candles.length; i++) {
    const f = ctx.at(i);
    const last = i === candles.length - 1;
    if (!f) continue;

    const long = f.side === 'above';
    const short = f.side === 'below';

    // ── the break: a transition through the cloud, not a state ───────────
    // Price that has been above the cloud for fifty bars has not "broken
    // above" it. Only the bar where the side CHANGES is a breakout, which is
    // also what makes this one-shot without a re-arm rule.
    if (prevSide !== null && f.side !== prevSide && (long || short)) {
      pending = {
        direction: long ? 'LONG' : 'SHORT',
        brokeAt: i,
        breakClose: f.bar.close,
        cloudPips: f.cloudPips,
      };
    }

    // A break that price gave straight back is not waiting for anything.
    if (pending && ((pending.direction === 'LONG' && !long) || (pending.direction === 'SHORT' && !short))) {
      pending = null;
    }
    if (pending && i - pending.brokeAt > config.twistWithinBars) pending = null;

    if (last) {
      level = {
        symbol,
        timeframe,
        strategy: STRATEGY,
        kijun: f.kijun,
        tenkan: f.tenkan,
        band: Math.abs(f.senkouA - f.senkouB),
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

    prevSide = f.side;

    if (!pending) continue;

    const isLong = pending.direction === 'LONG';
    const twist = twisted(f, isLong);
    if (twist !== true) continue; // the setup is not established yet

    const chikou = chikouFree(f, isLong);
    if (config.requireChikou && chikou !== true) continue;

    const bars = i - pending.brokeAt;
    const checks: SignalCheck[] = [
      {
        label: `Price broke ${isLong ? 'above' : 'below'} the Cloud`,
        pass: true,
        detail:
          bars === 0
            ? `on this bar, close ${px(pending.breakClose)}`
            : `${bars} bar${bars === 1 ? '' : 's'} ago, close ${px(pending.breakClose)}`,
        required: true,
      },
      {
        label: `Cloud turning ${isLong ? 'bullish' : 'bearish'}`,
        pass: true,
        detail: `Span A ${px(f.aheadA)} ${isLong ? '>' : '<'} Span B ${px(f.aheadB)}, 26 bars ahead`,
        required: true,
      },
      {
        label: 'Chikou clear of its prior 26-period price',
        pass: chikou,
        detail:
          chikou === null
            ? 'fewer than 26 bars behind this one'
            : `close ${px(f.bar.close)} vs ${px(f.back?.close)} 26 bars back`,
        required: config.requireChikou,
      },
      {
        /**
         * Not a gate. OANDA: "price breakouts and breakdowns through a thick
         * Cloud are considered more significant." A thin-cloud break is still
         * a break; it is just a weaker one, so it grades rather than vetoes.
         */
        label: 'Broke through a thick Cloud',
        pass: pending.cloudPips >= f.range / f.pip * 0.15,
        detail: `cloud was ${pending.cloudPips.toFixed(1)} pips thick at the break`,
        required: false,
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
        direction: pending.direction,
        entry: f.bar.close,
        checks,
      }),
    );
    pending = null;
  }

  return { signals, level, reason: 'ok' };
}

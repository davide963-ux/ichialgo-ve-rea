/**
 * Weighted confluence scoring.
 *
 * THE RULE THE SPEC KEEPS REPEATING: DO NOT OVER-FILTER
 * ────────────────────────────────────────────────────
 * Nothing here is an AND. Each family of evidence earns a share of its weight
 * and the shares are summed. A setup with strong structure, a support
 * reaction and a good candle can reach a tradeable score with no BOS, no
 * chart pattern and only partial Ichimoku agreement — which is the point. An
 * engine that requires nine conditions produces a signal roughly never, and a
 * scanner that never signals is indistinguishable from a broken one.
 *
 * BUT NOT BLIND ADDITION EITHER
 * ─────────────────────────────
 * The spec is equally clear that context decides what a fact is worth:
 *
 *   • A bullish CHoCH in a DOWNTREND is a reversal warning — full points.
 *     The same CHoCH in an uptrend is noise, because there was no character
 *     to change.
 *   • A bullish BOS in an UPTREND is continuation — full points. In a
 *     downtrend it is a counter-trend poke, worth much less.
 *   • A bullish candle in the middle of a range is worth almost nothing; the
 *     same candle at support, on the EMA, or at a retested breakout is worth
 *     several times more. Location is a multiplier, not an addend.
 *
 * So every contribution is computed as `weight × quality × context`, and the
 * reason string records which of the three did the work.
 *
 * CORRELATION CAPPING
 * ───────────────────
 * Price above cloud, bullish cloud, Tenkan over Kijun and a rising EMA are
 * four readings of one trending market. Left uncapped they would let a single
 * fact buy 30 of the 100 points. Families are capped at their configured
 * weight, so the fifth confirmation inside a family is free of charge.
 */
import type { Direction } from '../contract';
import type { CandlePattern } from './candles';
import type { ChartPattern } from './chartPatterns';
import type { EngineConfig } from './config';
import type { EmaRead, IchimokuRead } from './trendTools';
import type { LevelRead } from './levels';
import type { StructureRead } from './structure';

export interface ScoreReason {
  family: string;
  label: string;
  points: number;
}

export interface ScoreResult {
  /** 0–100. */
  score: number;
  reasons: ScoreReason[];
  warnings: string[];
}

export interface ScoreInput {
  side: 'bullish' | 'bearish';
  structure: StructureRead;
  levels: LevelRead;
  chartPattern: ChartPattern | null;
  neutralPattern: ChartPattern | null;
  candle: CandlePattern | null;
  ema: EmaRead | null;
  ichimoku: IchimokuRead | null;
  momentum: number;
  /** Higher-timeframe trend, when the caller fetched one. */
  higherTrend: Direction;
  /** Lower-timeframe confirmation, when the caller fetched one. */
  entryConfirmation: Direction;
  config: EngineConfig;
}

/** Clamp a family's total to its configured weight. */
function capped(points: number, weight: number): number {
  return Math.max(-weight, Math.min(weight, points));
}

/**
 * How much of a SILENT family's weight still counts against the score.
 *
 * The spec's own worked explanation ends "No recent BOS, therefore confidence
 * is reduced slightly" — slightly, not by the full fifteen points. That single
 * word is the whole model here.
 *
 * Scoring out of a flat 100 punishes a setup for evidence the market simply
 * did not print. A clean trend reaction at support with a good candle and full
 * indicator agreement is a strong setup whether or not a chart pattern
 * happened to form, and under a flat denominator it could not reach the
 * tradeable band at all — which is the over-filtering the spec spends a whole
 * section warning against.
 *
 * So a family that had DATA but found nothing counts at half weight: its
 * absence costs something, but it cannot sink an otherwise complete case. A
 * family with NO DATA (Ichimoku before the cloud exists) is excluded entirely,
 * because there is nothing there to have an opinion about.
 */
const SILENT_WEIGHT = 0.5;

interface Family {
  earned: number;
  weight: number;
  /** False when the input was missing entirely — excluded from the denominator. */
  assessable: boolean;
}

export function scoreSetup(input: ScoreInput): ScoreResult {
  const { side, config } = input;
  const w = config.weights;
  const bull = side === 'bullish';
  const reasons: ScoreReason[] = [];
  const warnings: string[] = [];

  const add = (family: string, label: string, points: number) => {
    if (Math.abs(points) < 0.01) return;
    reasons.push({ family, label, points: Math.round(points * 10) / 10 });
  };

  const families: Family[] = [];

  // ── Market structure (20) ──────────────────────────────────────────────
  {
    const { trend, base } = input.structure;
    let pts = 0;
    if ((bull && trend === 'bullish') || (!bull && trend === 'bearish')) {
      pts += w.marketStructure * 0.75;
      add('structure', `${bull ? 'Bullish' : 'Bearish'} market structure`, w.marketStructure * 0.75);
      // Clean, unambiguous swing sequences are worth more than choppy ones.
      const clean = w.marketStructure * 0.25 * base.strength;
      pts += clean;
      add('structure', `Structure ${(base.strength * 100).toFixed(0)}% clean`, clean);
    } else if (trend === 'ranging' || trend === 'unclear') {
      // No trend is not an objection — plenty of setups start here — but it
      // earns nothing either.
      pts += w.marketStructure * 0.2;
      add('structure', 'Ranging structure — no trend either way', w.marketStructure * 0.2);
    } else {
      // Counter-trend — but is the trend ENDING?
      //
      // A reversal begins, by definition, against the prevailing structure. A
      // flat penalty here fights the entire reversal half of the spec and
      // double-counts: the break family has already judged the CHoCH, and the
      // CHoCH is precisely what invalidated this trend label. So when the
      // structure is in transition it is scored as transitional rather than
      // as opposition.
      const wantDir = bull ? 'bullish' : 'bearish';
      const transitioning =
        (input.structure.choch?.direction === wantDir) ||
        (input.structure.reversalConfirmed && input.structure.events.at(-1)?.direction === wantDir) ||
        (input.chartPattern?.family === 'reversal' && input.chartPattern.bias === wantDir);

      if (transitioning) {
        const value = w.marketStructure * 0.65;
        pts += value;
        add('structure', `Structure turning from ${trend} — reversal in progress`, value);
      } else {
        pts -= w.marketStructure * 0.5;
        add('structure', 'Against the prevailing structure', -w.marketStructure * 0.5);
        warnings.push(`Trading against ${trend} market structure.`);
      }
    }
    families.push({ earned: capped(pts, w.marketStructure), weight: w.marketStructure, assessable: true });
  }

  // ── BOS / CHoCH (15) — where context matters most ──────────────────────
  {
    const { bos, choch, reversalConfirmed, trend } = input.structure;
    let pts = 0;
    const wantDir = bull ? 'bullish' : 'bearish';

    if (choch && choch.direction === wantDir) {
      // A CHoCH is only meaningful if there was a trend to change. Against a
      // prevailing opposite trend it is the real thing; otherwise it is a
      // swing break dressed up as a reversal.
      const against = (bull && trend === 'bearish') || (!bull && trend === 'bullish');
      const value = against ? w.breakEvent * 0.8 : w.breakEvent * 0.25;
      pts += value;
      add('break', against ? `${wantDir} CHoCH against the ${trend} trend — reversal warning` : `${wantDir} CHoCH`, value);
    }

    if (bos && bos.direction === wantDir) {
      const withTrend = (bull && trend === 'bullish') || (!bull && trend === 'bearish');
      const value = withTrend ? w.breakEvent * 0.7 : w.breakEvent * 0.3;
      pts += value;
      add('break', withTrend ? `${wantDir} BOS confirms continuation` : `${wantDir} BOS`, value);
    }

    if (reversalConfirmed && choch?.direction === wantDir) {
      // CHoCH then BOS the same way: the strongest reversal evidence there is.
      pts += w.breakEvent * 0.5;
      add('break', 'CHoCH followed by BOS in the new direction', w.breakEvent * 0.5);
    }

    const opposing = [input.structure.bos, input.structure.choch].filter(
      (e) => e !== null && e.direction !== wantDir,
    );
    if (opposing.length > 0 && pts <= 0) {
      pts -= w.breakEvent * 0.4;
      add('break', 'Most recent break went the other way', -w.breakEvent * 0.4);
    }

    families.push({ earned: capped(pts, w.breakEvent), weight: w.breakEvent, assessable: true });
  }

  // ── Support / resistance (15) ──────────────────────────────────────────
  {
    const l = input.levels;
    let pts = 0;

    if (bull && l.atSupport && l.support) {
      // More touches, more respected. Capped at four; beyond that a level is
      // not "stronger", it is just old.
      const strength = Math.min(1, l.support.touches / 4);
      const value = w.supportResistance * (0.65 + 0.35 * strength);
      pts += value;
      add('levels', `Reacting at support (${l.support.touches} touches)`, value);
    } else if (!bull && l.atResistance && l.resistance) {
      const strength = Math.min(1, l.resistance.touches / 4);
      const value = w.supportResistance * (0.65 + 0.35 * strength);
      pts += value;
      add('levels', `Rejecting at resistance (${l.resistance.touches} touches)`, value);
    }

    // Buying straight into resistance, or selling into support, is the most
    // common way a good-looking setup loses money.
    const headroom = bull ? l.resistanceDistanceAtr : l.supportDistanceAtr;
    if (headroom !== null && headroom < 1.0) {
      pts -= w.supportResistance * 0.5;
      add('levels', `Only ${headroom.toFixed(1)} ATR of room to the next level`, -w.supportResistance * 0.5);
      warnings.push(`Little room before the next ${bull ? 'resistance' : 'support'}.`);
    }

    families.push({ earned: capped(pts, w.supportResistance), weight: w.supportResistance, assessable: input.levels.zones.length > 0 || input.levels.support !== null || input.levels.resistance !== null });
  }

  // ── Breakout / retest / momentum (10) ──────────────────────────────────
  {
    const b = input.levels.breakout;
    let pts = 0;
    const wantDir = bull ? 'bullish' : 'bearish';

    if (b && b.direction === wantDir) {
      if (b.retested) {
        // A retest gives a defined invalidation. A bare breakout gives a chase.
        pts += w.momentum * 0.7;
        add('momentum', 'Breakout retested and held', w.momentum * 0.7);
      } else if (b.barsAgo <= 3) {
        pts += w.momentum * 0.35;
        add('momentum', 'Fresh breakout, not yet retested', w.momentum * 0.35);
      }
    }

    const m = bull ? input.momentum : -input.momentum;
    if (m > 0.15) {
      const value = w.momentum * 0.3 * Math.min(1, m);
      pts += value;
      add('momentum', `Momentum running ${wantDir}`, value);
    } else if (m < -0.3) {
      pts -= w.momentum * 0.3;
      add('momentum', 'Momentum against the setup', -w.momentum * 0.3);
    }

    families.push({ earned: capped(pts, w.momentum), weight: w.momentum, assessable: true });
  }

  // ── Chart pattern (10) ─────────────────────────────────────────────────
  {
    let pts = 0;
    const p = input.chartPattern;
    if (p) {
      // A reversal pattern is worth most when it argues against the current
      // trend — that is what it is FOR. A continuation pattern is worth most
      // when it agrees with it.
      const trend = input.structure.trend;
      const counterTrend = (bull && trend === 'bearish') || (!bull && trend === 'bullish');
      const fit =
        p.family === 'reversal' ? (counterTrend ? 1 : 0.55)
        : p.family === 'continuation' ? (counterTrend ? 0.4 : 1)
        : 0.3;
      // A double bottom AT support is a different object from one in mid-air:
      // the pattern and the level are the same evidence agreeing twice.
      const atLevel = bull ? input.levels.atSupport : input.levels.atResistance;
      const value = w.chartPattern * p.quality * fit * (atLevel ? 1.15 : 1);
      pts += value;
      add('pattern', `${p.name} (${p.family})${atLevel ? ' at the level' : ''}`, value);
    }

    // A live neutral pattern means the market has not decided. The spec
    // forbids predicting its direction, so it damps rather than directs.
    if (input.neutralPattern && !p) {
      pts -= w.chartPattern * 0.3;
      add('pattern', `${input.neutralPattern.name} — direction unresolved`, -w.chartPattern * 0.3);
      warnings.push(`${input.neutralPattern.name} in force; wait for the breakout to pick a side.`);
    }

    families.push({ earned: capped(pts, w.chartPattern), weight: w.chartPattern, assessable: true });
  }

  // ── Candlestick (10), multiplied by LOCATION ───────────────────────────
  {
    let pts = 0;
    const c = input.candle;
    if (c) {
      const l = input.levels;
      const atLevel = bull ? l.atSupport : l.atResistance;
      const atEma = input.ema?.atLevel ?? false;
      const atCloud = input.ichimoku?.side === 'inside';
      const atRetest = l.breakout?.retested === true && l.breakout.direction === (bull ? 'bullish' : 'bearish');

      // The spec's list: support/resistance, swing, EMA50, Ichimoku boundary,
      // breakout retest. Each meaningful location lifts the multiplier.
      const hits = [atLevel, atEma, atCloud, atRetest].filter(Boolean).length;
      const location = hits === 0 ? 0.3 : Math.min(1, 0.6 + 0.25 * hits);

      const value = w.candlePattern * c.weight * location;
      pts += value;
      const where = atLevel ? (bull ? 'at support' : 'at resistance')
        : atRetest ? 'at the retested breakout'
        : atEma ? 'on the EMA50'
        : atCloud ? 'at the cloud'
        : 'mid-range';
      add('candle', `${c.name} ${where}`, value);
      if (hits === 0) warnings.push(`${c.name} formed away from any level — weak on its own.`);
    }
    families.push({ earned: capped(pts, w.candlePattern), weight: w.candlePattern, assessable: true });
  }

  // ── EMA50 (10) ─────────────────────────────────────────────────────────
  {
    const e = input.ema;
    let pts = 0;
    if (e) {
      const onSide = bull ? e.side === 'above' : e.side === 'below';
      const trending = bull ? e.direction === 'rising' : e.direction === 'falling';

      if (onSide) { pts += w.ema * 0.4; add('ema', `Price ${e.side} EMA50`, w.ema * 0.4); }
      if (trending) { pts += w.ema * 0.35; add('ema', `EMA50 ${e.direction}`, w.ema * 0.35); }
      if (onSide && e.atLevel) { pts += w.ema * 0.3; add('ema', 'Retesting EMA50 as ' + (bull ? 'support' : 'resistance'), w.ema * 0.3); }
      if (bull && e.reclaimed) { pts += w.ema * 0.35; add('ema', 'EMA50 reclaimed from below', w.ema * 0.35); }
      if (!bull && e.brokeDown) { pts += w.ema * 0.35; add('ema', 'EMA50 broken from above', w.ema * 0.35); }

      if (!onSide && !((bull && e.reclaimed) || (!bull && e.brokeDown))) {
        pts -= w.ema * 0.35;
        add('ema', `Price on the wrong side of EMA50`, -w.ema * 0.35);
      }
      if (e.overextended) {
        pts -= w.ema * 0.4;
        add('ema', `${e.distanceAtr.toFixed(1)} ATR from EMA50 — extended`, -w.ema * 0.4);
        warnings.push('Price is far from the EMA50; entry here is chasing.');
      }
    }
    families.push({ earned: capped(pts, w.ema), weight: w.ema, assessable: input.ema !== null });
  }

  // ── Ichimoku (10) ──────────────────────────────────────────────────────
  {
    const k = input.ichimoku;
    let pts = 0;
    if (k) {
      const want = bull;
      if (k.side === (want ? 'above' : 'below')) { pts += w.ichimoku * 0.35; add('ichimoku', `Price ${k.side} the cloud`, w.ichimoku * 0.35); }
      if (want ? k.brokeAbove : k.brokeBelow) { pts += w.ichimoku * 0.3; add('ichimoku', `Cloud ${want ? 'breakout' : 'breakdown'}`, w.ichimoku * 0.3); }
      if (k.tenkanAboveKijun === want) { pts += w.ichimoku * 0.25; add('ichimoku', `Tenkan ${want ? 'above' : 'below'} Kijun`, w.ichimoku * 0.25); }
      if (k.cloudBullish === want) { pts += w.ichimoku * 0.2; add('ichimoku', `Span A ${want ? 'above' : 'below'} Span B`, w.ichimoku * 0.2); }
      if (k.futureCloudBullish === want) { pts += w.ichimoku * 0.25; add('ichimoku', `${want ? 'Bullish' : 'Bearish'} future cloud`, w.ichimoku * 0.25); }
      if (k.chikouFree === (want ? 'bullish' : 'bearish')) { pts += w.ichimoku * 0.2; add('ichimoku', 'Chikou clear of price', w.ichimoku * 0.2); }

      // Inside the cloud: equilibrium, not a veto. The spec says so explicitly.
      if (k.side === 'inside') {
        pts -= w.ichimoku * 0.3;
        add('ichimoku', 'Price inside the cloud — unresolved', -w.ichimoku * 0.3);
        warnings.push('Price is inside the Kumo; the cloud offers no support or resistance here.');
      } else if (k.side !== (want ? 'above' : 'below')) {
        pts -= w.ichimoku * 0.35;
        add('ichimoku', 'Price on the wrong side of the cloud', -w.ichimoku * 0.35);
      }

      if (k.thicknessAtr !== null && k.thicknessAtr < config.trend.thinCloudAtr) {
        warnings.push('Cloud is thin — weak as support or resistance.');
      }
    }
    families.push({ earned: capped(pts, w.ichimoku), weight: w.ichimoku, assessable: input.ichimoku !== null });
  }

  // ── Multi-timeframe ────────────────────────────────────────────────────
  // A family like any other: the higher timeframe endorses or objects to a
  // setup the entry timeframe found, but it never creates one and never
  // forbids one. A reversal necessarily starts against the 4H.
  {
    const want: Direction = bull ? 'long' : 'short';
    const m = config.mtf;
    let pts = 0;

    if (input.higherTrend === want) {
      pts += m.aligned;
      add('mtf', 'Higher timeframe agrees', m.aligned);
    } else if (input.higherTrend !== 'none') {
      pts += m.conflicting;
      add('mtf', 'Higher timeframe disagrees', m.conflicting);
      warnings.push('The higher timeframe trend is against this setup.');
    }

    if (input.entryConfirmation === want) {
      pts += m.entryConfirmed;
      add('mtf', 'Entry timeframe confirms the turn', m.entryConfirmed);
    }

    families.push({
      earned: capped(pts, m.aligned),
      weight: m.aligned,
      // Nothing was fetched, so there is nothing to be neutral ABOUT.
      assessable: input.higherTrend !== 'none' || input.entryConfirmation !== 'none',
    });
  }

  // ── Normalise against the evidence that was actually available ─────────
  const earned = families.reduce((sum, f) => sum + f.earned, 0);
  const available = families.reduce((sum, f) => {
    if (!f.assessable) return sum;
    return sum + (f.earned > 0 ? f.weight : f.weight * SILENT_WEIGHT);
  }, 0);

  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    score: available <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((earned / available) * 100))),
    reasons,
    warnings,
  };
}

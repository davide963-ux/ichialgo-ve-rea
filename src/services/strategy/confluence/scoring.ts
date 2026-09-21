/**
 * Explainable confidence scoring.
 *
 * Two rules shape this file, both from the spec:
 *
 * 1. EVERY point is attributable. The score is built from a list of
 *    {key, label, points, group} records, and the number returned is just
 *    their sum, normalised. There is no path by which confidence can move
 *    without a reason being appended, because the reason IS the arithmetic.
 *
 * 2. CORRELATED CONDITIONS DO NOT STACK. In a genuine uptrend, "price above
 *    cloud", "cloud is bullish", "Tenkan above Kijun" and "EMA sloping up" are
 *    all true — but they are four views of one fact, not four independent
 *    confirmations. Scoring them at full weight manufactures a 90% that is
 *    really a 40%. Members of a group are summed, then the group total is
 *    clamped to `maxGroupContribution`:
 *
 *      trend group raw:  14 + 10 + 8 = 32   ──clamp──▶  24
 *
 *    Independent evidence — structure, the confluence zone, pullback quality,
 *    price-action confirmation — is ungrouped, so it carries full weight. That
 *    is deliberate: those are the things that actually distinguish setups.
 *
 * NORMALISATION
 * ─────────────
 * The raw total is mapped onto 0–100 against the maximum attainable positive
 * score, so thresholds in the config stay meaningful if weights are re-tuned.
 */
import type { ScoreWeights, ThresholdConfig } from '../../../config/confluence';
import type { ConfluenceSignal, Direction, ScoreReason } from './types';

export interface ScoreInput {
  direction: 'long' | 'short';
  trendAligned: boolean;
  cloudAligned: boolean;
  tenkanKijunAligned: boolean;
  chikouFree: boolean | null;
  structureAligned: boolean;
  structureOpposed: boolean;
  /** 0–3 from ZONE_RANK. */
  zoneRank: number;
  cloudBacked: boolean;
  /** 0–1. */
  pullbackQuality: number;
  confirmed: boolean;
  higherTimeframe: Direction | null;
  mixedConditions: boolean;
  overextended: boolean;
  choppy: boolean;
  thinCloud: boolean;
}

export interface ScoreResult {
  /** 0–100. */
  confidence: number;
  reasons: ScoreReason[];
  raw: number;
  max: number;
}

const TREND_GROUP = 'trend';

/**
 * Score a setup.
 *
 * Symmetric by construction: nothing here branches on long vs short. The
 * caller has already resolved each condition to "aligned with the intended
 * direction", so a short setup is scored by identical arithmetic.
 */
export function scoreSetup(input: ScoreInput, weights: ScoreWeights): ScoreResult {
  const reasons: ScoreReason[] = [];
  const add = (key: string, label: string, points: number, group: string | null = null) => {
    if (points === 0) return;
    reasons.push({ key, label, points, group });
  };

  // ── Correlated trend evidence (capped as a group) ─────────────────────────
  if (input.trendAligned) add('trend', 'EMA50 sloping with the trade', weights.trendAlignment, TREND_GROUP);
  if (input.cloudAligned) add('cloud', 'Kumo position and colour agree', weights.cloudAlignment, TREND_GROUP);
  if (input.tenkanKijunAligned) add('tenkanKijun', 'Tenkan/Kijun on the trade side', weights.tenkanKijun, TREND_GROUP);

  // ── Independent evidence (full weight) ────────────────────────────────────
  if (input.chikouFree === true) add('chikou', 'Chikou clear of past price', weights.chikouFree);
  if (input.structureAligned) add('structure', 'Market structure agrees', weights.marketStructure);

  if (input.zoneRank > 0) {
    // Scaled by grade: a strong EMA/Kijun overlap is worth three times a weak one.
    const share = input.zoneRank / 3;
    add(
      'zone',
      `EMA50/Kijun confluence (${['none', 'weak', 'moderate', 'strong'][input.zoneRank]})`,
      Math.round(weights.emaKijunConfluence * share),
    );
  }
  if (input.cloudBacked) add('cloudZone', 'Zone backed by the cloud edge', weights.cloudConfluence);

  if (input.pullbackQuality > 0) {
    add('pullback', `Pullback quality ${(input.pullbackQuality * 100).toFixed(0)}%`, Math.round(weights.pullbackQuality * input.pullbackQuality));
  }
  if (input.confirmed) add('confirmation', 'Price-action entry confirmation', weights.entryConfirmation);

  if (input.higherTimeframe !== null && input.higherTimeframe !== 'none') {
    if (input.higherTimeframe === input.direction) add('htf', 'Higher timeframe agrees', weights.higherTimeframeAgrees);
    else add('htfConflict', 'Higher timeframe conflicts', weights.higherTimeframeConflicts);
  }

  // ── Penalties ─────────────────────────────────────────────────────────────
  if (input.mixedConditions) add('mixed', 'Mixed indicator conditions', weights.mixedConditions);
  if (input.overextended) add('extended', 'Price overextended from EMA50', weights.overextension);
  if (input.choppy) add('choppy', 'Choppy market regime', weights.choppyMarket);
  if (input.thinCloud) add('thinCloud', 'Cloud too thin to act as support', weights.thinCloud);
  if (input.structureOpposed) add('counterStructure', 'Structure opposes the trade', weights.counterStructure);

  const raw = applyGroupCaps(reasons, weights.maxGroupContribution);

  // Best case: every positive at full value, groups capped the same way.
  const max =
    Math.min(weights.trendAlignment + weights.cloudAlignment + weights.tenkanKijun, weights.maxGroupContribution) +
    weights.chikouFree +
    weights.marketStructure +
    weights.emaKijunConfluence +
    weights.cloudConfluence +
    weights.pullbackQuality +
    weights.entryConfirmation +
    weights.higherTimeframeAgrees;

  const confidence = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((raw / max) * 100)));
  return { confidence, reasons, raw, max };
}

/**
 * Sum the reasons, clamping each group's positive total.
 *
 * The clamp is applied to the group as a whole rather than per-reason so the
 * individual attributions stay honest in the UI — you still see that all three
 * trend conditions were met, you just don't get paid three times for it.
 */
function applyGroupCaps(reasons: readonly ScoreReason[], cap: number): number {
  const groups = new Map<string, number>();
  let total = 0;

  for (const r of reasons) {
    if (r.group === null) total += r.points;
    else groups.set(r.group, (groups.get(r.group) ?? 0) + r.points);
  }

  for (const sum of groups.values()) {
    total += sum > 0 ? Math.min(sum, cap) : sum;
  }
  return total;
}

export interface GateInput {
  confidence: number;
  direction: 'long' | 'short';
  trendStrength: number;
  zoneRank: number;
  pullbackQuality: number;
  confirmed: boolean;
  /** Hard blocks — no directional signal regardless of score. */
  blocked: boolean;
}

/**
 * Turn a score into a signal.
 *
 * The gates are ANDed with the confidence bands, so a high score cannot buy
 * its way past a missing entry confirmation. Failing a gate downgrades to
 * WATCH rather than to NEUTRAL: the setup is real and worth showing, it is
 * just not actionable yet, and hiding it is how you miss the entry.
 */
export function gradeSignal(input: GateInput, thresholds: ThresholdConfig): ConfluenceSignal {
  if (input.blocked) return 'NO_TRADE';
  if (input.confidence < thresholds.watch) return 'NEUTRAL';

  const long = input.direction === 'long';

  const gatesPass =
    input.trendStrength >= thresholds.minTrendStrength &&
    input.zoneRank >= thresholds.minZoneStrength &&
    input.pullbackQuality >= thresholds.minPullbackQuality &&
    (!thresholds.requireConfirmation || input.confirmed);

  if (!gatesPass) return long ? 'WATCH_LONG' : 'WATCH_SHORT';
  if (input.confidence >= thresholds.strong) return long ? 'STRONG_LONG' : 'STRONG_SHORT';
  if (input.confidence >= thresholds.actionable) return long ? 'LONG' : 'SHORT';
  return long ? 'WATCH_LONG' : 'WATCH_SHORT';
}

/** Signals that represent a tradeable decision rather than an observation. */
export function isActionable(signal: ConfluenceSignal): boolean {
  return signal === 'LONG' || signal === 'SHORT' || signal === 'STRONG_LONG' || signal === 'STRONG_SHORT';
}

/**
 * Setup state tracking — the anti-duplication layer.
 *
 * `analyseConfluence` is stateless: given the same candles it always returns
 * the same answer, which is what makes it testable and what lets the backtest
 * and the live scanner agree. But a setup does not vanish when it is found.
 * A CONFIRMED long stays confirmed for as long as the conditions hold, so an
 * engine that emitted on every scan would emit the same trade ten times.
 *
 * This module holds the memory. It compares the current analysis against what
 * it last saw for that (symbol, timeframe) and emits ONLY on a transition
 * worth telling someone about.
 *
 *                    ┌──────────── reset ─────────────┐
 *                    ▼                                │
 *   (none) ──▶ FORMING ──▶ CONFIRMING ──▶ CONFIRMED ──▶ ACTIVE ──▶ COMPLETED
 *                 │             │              │           │
 *                 └─────────────┴──────────────┴───────────┴──▶ INVALIDATED
 *
 * WHAT COUNTS AS A NEW SETUP
 * ──────────────────────────
 * Not "the direction is still long". A genuinely new setup means the previous
 * one ended — invalidated, completed, or the market left the zone and came
 * back. Tracking the IMPULSE the pullback belongs to is what distinguishes
 * "the same pullback, six bars later" from "a new pullback in the same trend":
 * the second one has a different impulse origin.
 *
 * WHY ACTIVE IS SEPARATE FROM CONFIRMED
 * ─────────────────────────────────────
 * CONFIRMED is "a trade is warranted now". ACTIVE is "a trade was taken and is
 * running". The scanner promotes CONFIRMED → ACTIVE when it records the
 * signal, and from then on the setup is not re-emitted; the TP/SL checker owns
 * it until it closes.
 */
import type { ConfluenceAnalysis, Direction, SetupStatus } from './types';
import { isActionable } from './scoring';

export interface TrackedSetup {
  key: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  status: SetupStatus;
  /** Bar the setup was first seen on. */
  firstBarTime: number;
  /** Bar of the most recent update. */
  lastBarTime: number;
  /**
   * Origin of the impulse this pullback belongs to. A different origin means a
   * different setup, even in the same trend and the same direction.
   */
  impulseOrigin: number | null;
  /** Confidence when it was last emitted — used to report a material upgrade. */
  emittedConfidence: number | null;
  emittedAt: number | null;
}

export type EmitReason = 'new-setup' | 'confirmed' | 'invalidated' | 'upgraded';

export interface TrackerDecision {
  /** True when the caller should record/publish this analysis. */
  emit: boolean;
  reason: EmitReason | null;
  setup: TrackedSetup;
}

export interface TrackerOptions {
  /**
   * Re-emit an already-emitted setup only if confidence improved by at least
   * this much. Without it, noise around the threshold produces a stream of
   * near-identical signals.
   */
  upgradeDelta?: number;
  /** A setup untouched for this many ms is forgotten. */
  staleMs?: number;
  now?: () => number;
}

const DEFAULTS = { upgradeDelta: 12, staleMs: 24 * 60 * 60 * 1000 };

export const setupKey = (symbol: string, timeframe: string): string => `${symbol}|${timeframe}`;

/**
 * Tracks one setup per (symbol, timeframe).
 *
 * Deliberately not a store or a singleton: the scanner owns an instance, the
 * backtest owns its own, and neither can contaminate the other. State that
 * must survive a restart is rehydrated with `load()`.
 */
export class SetupTracker {
  private readonly setups = new Map<string, TrackedSetup>();
  private readonly upgradeDelta: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(options: TrackerOptions = {}) {
    this.upgradeDelta = options.upgradeDelta ?? DEFAULTS.upgradeDelta;
    this.staleMs = options.staleMs ?? DEFAULTS.staleMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Rehydrate from persisted state — a serverless scanner starts cold. */
  load(setups: readonly TrackedSetup[]): void {
    for (const s of setups) this.setups.set(s.key, { ...s });
  }

  snapshot(): TrackedSetup[] {
    return [...this.setups.values()].map((s) => ({ ...s }));
  }

  get(symbol: string, timeframe: string): TrackedSetup | null {
    return this.setups.get(setupKey(symbol, timeframe)) ?? null;
  }

  /** Mark a CONFIRMED setup as taken, so it stops being re-emitted. */
  activate(symbol: string, timeframe: string): void {
    const s = this.setups.get(setupKey(symbol, timeframe));
    if (s) s.status = 'ACTIVE';
  }

  /** Close an ACTIVE setup once its trade resolved. */
  complete(symbol: string, timeframe: string): void {
    const s = this.setups.get(setupKey(symbol, timeframe));
    if (s) s.status = 'COMPLETED';
  }

  /**
   * Feed an analysis in; get back whether it is worth acting on.
   *
   * The order of the checks is the policy:
   *   1. an ACTIVE trade suppresses everything — one position per pair
   *   2. invalidation is always news, and clears the slot
   *   3. a different impulse means a genuinely new setup
   *   4. crossing into CONFIRMED is the signal
   *   5. a materially better CONFIRMED setup is an upgrade
   *   6. anything else is the same setup, still developing → silence
   */
  update(analysis: ConfluenceAnalysis): TrackerDecision {
    const key = setupKey(analysis.symbol, analysis.timeframe);
    this.evict();

    const existing = this.setups.get(key);
    const impulseOrigin = analysis.setup.retracementPct === null ? null : (analysis.risk.suggestedStopReference ?? null);
    const nowMs = this.now();

    const fresh = (status: SetupStatus): TrackedSetup => ({
      key,
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      status,
      firstBarTime: analysis.barTime,
      lastBarTime: analysis.barTime,
      impulseOrigin,
      emittedConfidence: null,
      emittedAt: null,
    });

    // 1. A running trade owns the pair until the TP/SL checker releases it.
    if (existing?.status === 'ACTIVE') {
      existing.lastBarTime = analysis.barTime;
      return { emit: false, reason: null, setup: existing };
    }

    // 2. Invalidation is worth recording — it is how a watched setup ends.
    if (analysis.setup.status === 'INVALIDATED') {
      if (!existing || existing.status === 'INVALIDATED') {
        const setup = fresh('INVALIDATED');
        this.setups.set(key, setup);
        return { emit: false, reason: null, setup };
      }
      existing.status = 'INVALIDATED';
      existing.lastBarTime = analysis.barTime;
      return { emit: true, reason: 'invalidated', setup: existing };
    }

    // 3. Direction flip or a different impulse — the old setup is over.
    const differentSetup =
      existing !== undefined &&
      (existing.direction !== analysis.direction ||
        existing.status === 'COMPLETED' ||
        existing.status === 'INVALIDATED' ||
        (impulseOrigin !== null && existing.impulseOrigin !== null && impulseOrigin !== existing.impulseOrigin));

    if (existing === undefined || differentSetup) {
      const setup = fresh(analysis.setup.status);
      this.setups.set(key, setup);
      const emit = analysis.setup.status === 'CONFIRMED' && isActionable(analysis.signal);
      if (emit) {
        setup.emittedConfidence = analysis.confidence;
        setup.emittedAt = nowMs;
      }
      return { emit, reason: emit ? 'new-setup' : null, setup };
    }

    // 4/5/6. Same setup: only a state change or a real improvement is news.
    const wasConfirmed = existing.status === 'CONFIRMED';
    existing.status = analysis.setup.status;
    existing.lastBarTime = analysis.barTime;
    existing.direction = analysis.direction;
    if (impulseOrigin !== null) existing.impulseOrigin = impulseOrigin;

    const nowConfirmed = analysis.setup.status === 'CONFIRMED' && isActionable(analysis.signal);
    if (!nowConfirmed) return { emit: false, reason: null, setup: existing };

    if (!wasConfirmed || existing.emittedConfidence === null) {
      existing.emittedConfidence = analysis.confidence;
      existing.emittedAt = nowMs;
      return { emit: true, reason: 'confirmed', setup: existing };
    }

    if (analysis.confidence - existing.emittedConfidence >= this.upgradeDelta) {
      existing.emittedConfidence = analysis.confidence;
      existing.emittedAt = nowMs;
      return { emit: true, reason: 'upgraded', setup: existing };
    }

    return { emit: false, reason: null, setup: existing };
  }

  /** Forget setups nothing has touched in a long time. */
  private evict(): void {
    const cutoff = this.now() - this.staleMs;
    for (const [key, s] of this.setups) {
      if (s.emittedAt !== null && s.emittedAt < cutoff && s.status !== 'ACTIVE') this.setups.delete(key);
    }
  }
}

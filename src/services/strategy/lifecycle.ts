/**
 * Setup lifecycle tracking — plumbing, not strategy.
 *
 * WHY THIS SURVIVED THE STRATEGY WIPE
 * ───────────────────────────────────
 * This answers "is this news?", which is a different question from "is this a
 * good trade?". Whatever rules replace the old ones, a scanner running every
 * fifteen minutes will re-derive the same conclusion from the same candles
 * over and over, and something has to turn that stream of states into a
 * stream of EVENTS. That job does not change when the rules do, and the
 * `setup_state` table already stores exactly this shape.
 *
 * It is also the only thing enforcing one position per pair, which is a
 * risk rule rather than an opinion about the market.
 *
 * It reads just four fields of an analysis — symbol, timeframe, direction,
 * status — plus the strategy's own `anchor`. It cannot see confluence,
 * pullbacks or clouds, and must not learn to.
 */
import { isActionable, type Direction, type SetupStatus, type StrategyAnalysis } from './contract';

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
  /** The strategy's `anchor` — a different one means a different setup. */
  anchor: number | null;
  /** Confidence when last emitted, so a material upgrade can be spotted. */
  emittedConfidence: number | null;
  emittedAt: number | null;
}

export type EmitReason = 'new-setup' | 'confirmed' | 'invalidated' | 'upgraded';

export interface TrackerDecision {
  /** True when the caller should record and publish this analysis. */
  emit: boolean;
  reason: EmitReason | null;
  setup: TrackedSetup;
}

export interface TrackerOptions {
  /**
   * Re-emit an already-emitted setup only if confidence improved by at least
   * this much. Without it, noise either side of a threshold produces a stream
   * of near-identical signals for one opportunity.
   */
  upgradeDelta?: number;
  /** A setup untouched for this long is forgotten. */
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
 * must survive a restart is rehydrated with `load()`, because a serverless
 * scanner starts cold every time.
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

  /**
   * Release an ACTIVE setup once its trade resolved.
   *
   * Nothing else clears ACTIVE, and an ACTIVE setup suppresses every future
   * signal for its pair — so a caller that forgets to call this leaves the
   * pair permanently silent while the scanner still looks healthy.
   */
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
   *   3. a direction flip or a different anchor means a genuinely new setup
   *   4. crossing into CONFIRMED is the signal
   *   5. a materially better CONFIRMED setup is an upgrade
   *   6. anything else is the same setup, still developing → silence
   */
  update(analysis: StrategyAnalysis): TrackerDecision {
    const key = setupKey(analysis.symbol, analysis.timeframe);
    this.evict();

    const existing = this.setups.get(key);
    const nowMs = this.now();

    const fresh = (status: SetupStatus): TrackedSetup => ({
      key,
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      status,
      firstBarTime: analysis.barTime,
      lastBarTime: analysis.barTime,
      anchor: analysis.anchor,
      emittedConfidence: null,
      emittedAt: null,
    });

    // 1. A running trade owns the pair until the TP/SL checker releases it.
    if (existing?.status === 'ACTIVE') {
      existing.lastBarTime = analysis.barTime;
      return { emit: false, reason: null, setup: existing };
    }

    // 2. Invalidation is worth recording — it is how a watched setup ends.
    //    Emitting requires a PREVIOUS live setup: without one there was never
    //    anything to invalidate, and a strategy reporting INVALIDATED on a
    //    cold start would otherwise fire a signal about nothing.
    if (analysis.status === 'INVALIDATED') {
      if (!existing || existing.status === 'INVALIDATED') {
        const setup = fresh('INVALIDATED');
        this.setups.set(key, setup);
        return { emit: false, reason: null, setup };
      }
      existing.status = 'INVALIDATED';
      existing.lastBarTime = analysis.barTime;
      return { emit: true, reason: 'invalidated', setup: existing };
    }

    // 3. Direction flip, a finished setup, or a different anchor — the old one is over.
    const differentSetup =
      existing !== undefined &&
      (existing.direction !== analysis.direction ||
        existing.status === 'COMPLETED' ||
        existing.status === 'INVALIDATED' ||
        (analysis.anchor !== null && existing.anchor !== null && analysis.anchor !== existing.anchor));

    if (existing === undefined || differentSetup) {
      const setup = fresh(analysis.status);
      this.setups.set(key, setup);
      const emit = analysis.status === 'CONFIRMED' && isActionable(analysis.signal);
      if (emit) {
        setup.emittedConfidence = analysis.confidence;
        setup.emittedAt = nowMs;
      }
      return { emit, reason: emit ? 'new-setup' : null, setup };
    }

    // 4/5/6. Same setup: only a state change or a real improvement is news.
    const wasConfirmed = existing.status === 'CONFIRMED';
    existing.status = analysis.status;
    existing.lastBarTime = analysis.barTime;
    existing.direction = analysis.direction;
    if (analysis.anchor !== null) existing.anchor = analysis.anchor;

    const nowConfirmed = analysis.status === 'CONFIRMED' && isActionable(analysis.signal);
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

  /**
   * Forget setups nothing has touched in a long time.
   *
   * ACTIVE is never evicted: a running trade must keep suppressing its pair
   * however long it stays open.
   */
  private evict(): void {
    const cutoff = this.now() - this.staleMs;
    for (const [key, s] of this.setups) {
      if (s.emittedAt !== null && s.emittedAt < cutoff && s.status !== 'ACTIVE') this.setups.delete(key);
    }
  }
}

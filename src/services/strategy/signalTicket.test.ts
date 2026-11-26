/**
 * The exit, bar by bar — including the break-even move.
 *
 * `stepExit` is the single place that decides whether a bar ended a trade, and
 * it is called from three: the detector (which must know when a pair is free
 * again), the backtest, and the live scanner resolving stored trades. A
 * second opinion anywhere would put the published result and the stored
 * history in disagreement, which this project has already done once.
 *
 * The tests below are mostly about ambiguity, because that is where a
 * backtest lies: what a candle does NOT tell you is the order its high and
 * low arrived in, and every rule here resolves that ignorance against the
 * trade rather than for it.
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '../marketData/types';
import { openExit, stepExit, type ExitRules } from './signalTicket';

const bar = (o: number, h: number, l: number, c: number): Candle => ({
  time: 0,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: null,
  complete: true,
});

/**
 * A long: entry 100, stop 90, target 120. At 110 the stop moves to 101 —
 * one unit the PROFITABLE side of the entry, not onto it.
 *
 * That one unit is the whole point of the destination being configurable. A
 * stop resting exactly on the entry gives the spread back every time it is
 * hit, and this rule scratches most of its trades; resting just beyond it
 * makes the scratch cost nothing instead.
 */
const LONG: ExitRules = {
  direction: 'LONG',
  entry: 100,
  stop: 90,
  target: 120,
  breakEven: { trigger: 110, stop: 101 },
};
/** The mirror image, so nothing can be right for longs only. */
const SHORT: ExitRules = {
  direction: 'SHORT',
  entry: 100,
  stop: 110,
  target: 80,
  breakEven: { trigger: 90, stop: 99 },
};

describe('stepExit without the break-even rule', () => {
  const plain: ExitRules = { ...LONG, breakEven: null };

  it('stops out, takes profit, or does neither', () => {
    expect(stepExit(bar(100, 101, 89, 100), plain, openExit(plain)).exit).toBe('sl');
    expect(stepExit(bar(100, 121, 99, 120), plain, openExit(plain)).exit).toBe('tp');
    expect(stepExit(bar(100, 105, 95, 102), plain, openExit(plain)).exit).toBeNull();
  });

  /**
   * The oldest rule here, and the one that keeps the whole thing honest: a
   * bar that covers both levels cannot say which came first, so it is read
   * as the stop. The alternative invents wins.
   */
  it('reads a bar covering both levels as the stop', () => {
    const both = bar(100, 125, 85, 100);
    expect(stepExit(both, plain, openExit(plain)).exit).toBe('sl');
    expect(stepExit(both, plain, openExit(plain)).price).toBe(90);
  });
});

describe('the break-even move', () => {
  it('does not arm until the trigger price actually trades', () => {
    const near = stepExit(bar(100, 109.99, 99, 105), LONG, openExit(LONG));
    expect(near.state.movedToBreakEven).toBe(false);
    expect(near.state.stop).toBe(90);

    const hit = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG));
    expect(hit.exit).toBeNull();
    expect(hit.state.movedToBreakEven).toBe(true);
    // 101, not 100: the stop locks in a profit rather than landing on entry.
    expect(hit.state.stop).toBe(101);
  });

  /**
   * The reason the destination is not the entry. A scratch has to end up on
   * the right side of the spread, or a rule that scratches most of its
   * trades pays the spread most of the time for nothing.
   */
  it('locks the stop the profitable side of the entry, both directions', () => {
    const long = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG)).state;
    expect(long.stop).toBeGreaterThan(LONG.entry);

    const short = stepExit(bar(100, 101, 90, 95), SHORT, openExit(SHORT)).state;
    expect(short.stop).toBeLessThan(SHORT.entry);
  });

  /**
   * THE RULE THAT DECIDES WHETHER ANY OF THIS IS HONEST.
   *
   * A bar that trades up to 110 and down to 90 both triggers break-even and
   * touches the original stop. The candle cannot say which happened first.
   * Arming within the bar would let the backtest choose the order that
   * flatters the rule — a scratch instead of a full loss — on exactly the
   * bars where the choice is worth the most.
   *
   * So the trigger bar is still resolved against the ORIGINAL stop, and the
   * move applies from the next bar. Every measured benefit of break-even is
   * therefore an understatement.
   */
  it('still books the full loss on a bar that reaches both the trigger and the stop', () => {
    const whipsaw = bar(100, 115, 89, 95);
    const out = stepExit(whipsaw, LONG, openExit(LONG));
    expect(out.exit).toBe('sl');
    expect(out.price).toBe(90);
    expect(out.state.movedToBreakEven).toBe(false);
  });

  it('exits at the locked price, labelled apart from a real stop-out', () => {
    const armed = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG)).state;
    const back = stepExit(bar(105, 106, 101, 102), LONG, armed);
    expect(back.exit).toBe('be');
    expect(back.price).toBe(101);
  });

  /**
   * The cost of locking a profit rather than the entry: the stop now sits
   * ABOVE the entry for a long, so a dip to the entry — which a break-even
   * stop would have survived — takes the trade out.
   */
  it('is reached by a dip that a stop on the entry would have survived', () => {
    const armed = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG)).state;
    const dip = stepExit(bar(105, 106, 100.5, 104), LONG, armed);
    expect(dip.exit).toBe('be');
    expect(dip.price).toBe(101);
  });

  /**
   * A scratch is not a stop-out and the two must not be pooled. Both come out
   * slightly negative once the spread is paid, so a pip total cannot tell
   * them apart — and "how many losses did this avoid" is the only question
   * the rule exists to answer.
   */
  it('never reports a break-even exit as a stop-out', () => {
    const armed = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG)).state;
    // Even a bar that plunges far below the ORIGINAL stop exits at the entry:
    // that is where the order was resting by then.
    const crash = stepExit(bar(105, 105, 50, 60), LONG, armed);
    expect(crash.exit).toBe('be');
    expect(crash.price).toBe(101);
  });

  it('never moves the stop back down once it has moved up', () => {
    let state = openExit(LONG);
    state = stepExit(bar(100, 110, 99, 105), LONG, state).state;
    for (const b of [bar(105, 106, 102, 103), bar(103, 109, 101.5, 108)]) {
      state = stepExit(b, LONG, state).state;
      expect(state.stop).toBe(101);
      expect(state.movedToBreakEven).toBe(true);
    }
  });

  it('lets the target win when the bar reaches it without touching the stop', () => {
    const armed = stepExit(bar(100, 110, 99, 105), LONG, openExit(LONG)).state;
    const run = stepExit(bar(110, 121, 109, 120), LONG, armed);
    expect(run.exit).toBe('tp');
    expect(run.price).toBe(120);
  });

  it('is off entirely when the rule is null', () => {
    const off: ExitRules = { ...LONG, breakEven: null };
    const state = stepExit(bar(100, 119, 99, 118), off, openExit(off)).state;
    expect(state.movedToBreakEven).toBe(false);
    expect(state.stop).toBe(90);
  });

  describe('a short is the mirror image, not a special case', () => {
    it('arms on the low and scratches on a return to entry', () => {
      const armed = stepExit(bar(100, 101, 90, 95), SHORT, openExit(SHORT));
      expect(armed.exit).toBeNull();
      expect(armed.state.movedToBreakEven).toBe(true);
      expect(armed.state.stop).toBe(99);

      const back = stepExit(bar(95, 99, 94, 98), SHORT, armed.state);
      expect(back.exit).toBe('be');
      expect(back.price).toBe(99);
    });

    it('still books the full loss when one bar reaches both', () => {
      const out = stepExit(bar(100, 111, 85, 105), SHORT, openExit(SHORT));
      expect(out.exit).toBe('sl');
      expect(out.price).toBe(110);
      expect(out.state.movedToBreakEven).toBe(false);
    });
  });
});

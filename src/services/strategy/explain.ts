/**
 * The four confirmations in words, for tooltips and the detail panel.
 *
 * Kept out of the detector so that prose changes cannot touch trading logic,
 * and kept out of the components so the wording is the same everywhere — a
 * tooltip and a panel that describe the same check differently is how a
 * reader ends up believing the system does two things.
 */
import { ICHIMOKU_SIGNAL_CHECKS } from '../../config/ichimokuStrategy';
import type { Direction, IchimokuSignal } from './types';

export interface Check {
  label: string;
  /** Null when the data could not answer it — never silently a failure. */
  pass: boolean | null;
  detail: string;
}

/** The four checks, read in the direction being traded. */
export function explainSignal(
  s: Pick<IchimokuSignal, 'direction' | 'cloudBullish' | 'futureCloudBullish' | 'chikouFree' | 'tenkanAgrees' | 'kumo'>,
): Check[] {
  const long = s.direction === 'LONG';
  return [
    {
      label: `Cloud in effect ${long ? 'bullish' : 'bearish'}`,
      pass: long ? s.cloudBullish : !s.cloudBullish,
      detail: `Senkou A is ${s.cloudBullish ? 'above' : 'below'} Senkou B over this bar`,
    },
    {
      label: `Cloud 26 bars ahead ${long ? 'bullish' : 'bearish'}`,
      pass: s.futureCloudBullish === null ? null : long ? s.futureCloudBullish : !s.futureCloudBullish,
      detail:
        s.futureCloudBullish === null
          ? 'the leading cloud is not determined at this bar'
          : `the cloud this trend walks into is ${s.futureCloudBullish ? 'bullish' : 'bearish'}`,
    },
    {
      label: 'Chikou free',
      pass: s.chikouFree,
      detail:
        s.chikouFree === null
          ? 'fewer than 26 bars behind this one'
          : `the lagging line is ${s.chikouFree ? 'clear of' : 'blocked by'} the candles 26 bars back`,
    },
    {
      label: `Tenkan ${long ? 'above' : 'below'} Kijun`,
      pass: s.tenkanAgrees,
      detail: s.tenkanAgrees ? 'the fast line agrees' : 'the fast line is on the other side of the base line',
    },
  ];
}

/** One line per check, for a title attribute. */
export const explainLines = (s: Parameters<typeof explainSignal>[0]): string[] =>
  explainSignal(s).map((c) => `${c.pass === true ? '✓' : c.pass === null ? '·' : '✕'} ${c.label} — ${c.detail}`);

/** "4/4 confirmations for a LONG". */
export const scoreLabel = (s: Pick<IchimokuSignal, 'score' | 'direction'>): string =>
  `${s.score}/${ICHIMOKU_SIGNAL_CHECKS} confirmations for a ${s.direction as Direction}`;

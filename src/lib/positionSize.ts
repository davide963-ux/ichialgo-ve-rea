/**
 * Forex position-size calculator — pure functions, no UI, no strategy.
 * Account currency: USD.
 *
 *   pip size          = 0.01 (JPY quote) | 0.0001 (others)
 *   pip value / lot   = contractSize × pipSize × (USD per 1 unit of quote ccy)
 *   risk amount       = balance × risk% / 100
 *   stop distance     = |entry − stop| / pipSize                (pips)
 *   position (lots)   = risk amount / (stop pips × pip value/lot)   → floored to 0.01
 *   potential loss    = stop pips × pip value/lot × lots
 *   potential profit  = target pips × pip value/lot × lots
 *   risk/reward       = target pips / stop pips
 */
import { getPair } from '../config/pairs';
import { pipSize } from './pips';

export const STANDARD_LOT = 100_000;
export const LOT_STEP = 0.01;

/** Returns the live mid price of a symbol like "USD/JPY", or null if unknown. */
export type RateLookup = (symbol: string) => number | null;

export interface PositionInput {
  balance: number;
  riskPct: number;
  symbol: string;
  entry: number;
  stopLoss: number;
  takeProfit: number | null;
}

export interface PositionResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  direction: 'LONG' | 'SHORT' | null;
  pipSize: number;
  pipValuePerLot: number | null;
  riskAmount: number | null;
  stopPips: number | null;
  targetPips: number | null;
  lotsExact: number | null;
  lots: number | null;
  units: number | null;
  potentialLoss: number | null;
  potentialProfit: number | null;
  riskReward: number | null;
}

/** USD value of ONE unit of the pair's quote currency. */
export function quoteToUsd(symbol: string, entry: number, lookup: RateLookup): number | null {
  const { base, quote } = getPair(symbol);
  if (quote === 'USD') return 1;
  if (base === 'USD') return entry > 0 ? 1 / entry : null; // USD/JPY, USD/CHF, USD/CAD
  const usdQuote = lookup(`USD/${quote}`);
  if (usdQuote && usdQuote > 0) return 1 / usdQuote;
  const quoteUsd = lookup(`${quote}/USD`);
  if (quoteUsd && quoteUsd > 0) return quoteUsd;
  return null;
}

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function calculatePosition(input: PositionInput, lookup: RateLookup = () => null): PositionResult {
  const pip = pipSize(input.symbol);
  const empty: PositionResult = {
    ok: false, errors: [], warnings: [], direction: null, pipSize: pip, pipValuePerLot: null,
    riskAmount: null, stopPips: null, targetPips: null, lotsExact: null, lots: null, units: null,
    potentialLoss: null, potentialProfit: null, riskReward: null,
  };
  const r = { ...empty, errors: [] as string[], warnings: [] as string[] };
  const { balance, riskPct, entry, stopLoss, takeProfit, symbol } = input;

  if (!valid(balance) || balance <= 0) r.errors.push('Enter an account balance above 0.');
  if (!valid(riskPct) || riskPct <= 0 || riskPct > 100) r.errors.push('Risk % must be between 0 and 100.');
  if (!valid(entry) || entry <= 0) r.errors.push('Enter an entry price above 0.');
  if (!valid(stopLoss) || stopLoss <= 0) r.errors.push('Enter a stop loss above 0.');
  if (r.errors.length) return r;
  if (stopLoss === entry) {
    r.errors.push('Stop loss must differ from the entry price.');
    return r;
  }

  r.riskAmount = (balance * riskPct) / 100;
  r.direction = stopLoss < entry ? 'LONG' : 'SHORT';
  r.stopPips = Math.abs(entry - stopLoss) / pip;

  if (valid(takeProfit)) {
    const correctSide = r.direction === 'LONG' ? takeProfit > entry : takeProfit < entry;
    if (!correctSide) {
      r.errors.push(
        r.direction === 'LONG'
          ? 'Stop is below entry (long), so take profit must be above entry.'
          : 'Stop is above entry (short), so take profit must be below entry.',
      );
      return r;
    }
    r.targetPips = Math.abs(takeProfit - entry) / pip;
    r.riskReward = r.targetPips / r.stopPips;
  }

  const q2usd = quoteToUsd(symbol, entry, lookup);
  if (q2usd === null) {
    r.errors.push(`Cannot convert ${getPair(symbol).quote} to USD: load a USD pair for that currency.`);
    return r;
  }
  r.pipValuePerLot = STANDARD_LOT * pip * q2usd;

  r.lotsExact = r.riskAmount / (r.stopPips * r.pipValuePerLot);
  r.lots = Math.floor(r.lotsExact / LOT_STEP + 1e-9) * LOT_STEP;
  r.units = Math.round(r.lots * STANDARD_LOT);
  r.potentialLoss = r.stopPips * r.pipValuePerLot * r.lots;
  r.potentialProfit = r.targetPips !== null ? r.targetPips * r.pipValuePerLot * r.lots : null;

  if (r.lots < LOT_STEP) r.warnings.push('Risk amount is below the minimum 0.01 lot for this stop distance.');
  if (entry > 20 && pip === 0.0001) r.warnings.push('Entry looks too large for a non-JPY pair — check the price.');
  if (entry < 20 && pip === 0.01) r.warnings.push('Entry looks too small for a JPY pair — check the price.');
  if (riskPct > 5) r.warnings.push('Risking more than 5% of the account on one trade.');

  r.ok = true;
  return r;
}

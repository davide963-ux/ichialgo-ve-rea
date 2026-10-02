/**
 * Forex pair registry.
 * Add a pair here and it appears in the scanner, pair details and calculator.
 * Symbols are stored in canonical "BASE/QUOTE" form; each provider maps them
 * to its own format if it needs to.
 */
export interface PairConfig {
  symbol: string; // "EUR/USD"
  base: string; // "EUR"
  quote: string; // "USD"
  /** Decimal places the pair is quoted with (display precision). */
  digits: number;
}

export function makePair(symbol: string): PairConfig {
  const [base = '', quote = ''] = symbol.toUpperCase().split('/');
  return { symbol: `${base}/${quote}`, base, quote, digits: quote === 'JPY' ? 3 : 5 };
}

export const MAJOR_PAIRS: PairConfig[] = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/CHF',
  'AUD/USD',
  'USD/CAD',
  'NZD/USD',
].map(makePair);

/**
 * Extra pairs — append here to extend the scanner, e.g.
 *   ['EUR/GBP', 'EUR/JPY', 'GBP/JPY']
 * Crosses work in the calculator as long as a USD conversion pair is loaded.
 */
const EXTRA_SYMBOLS: string[] = [];

export const PAIRS: PairConfig[] = [...MAJOR_PAIRS, ...EXTRA_SYMBOLS.map(makePair)];

export const PAIR_MAP: ReadonlyMap<string, PairConfig> = new Map(PAIRS.map((p) => [p.symbol, p]));

export function getPair(symbol: string): PairConfig {
  return PAIR_MAP.get(symbol) ?? makePair(symbol);
}

/** URL-safe slug: "EUR/USD" <-> "EURUSD" */
export const pairToSlug = (symbol: string) => symbol.replace('/', '');
export const slugToPair = (slug: string) =>
  PAIRS.find((p) => pairToSlug(p.symbol) === slug.toUpperCase())?.symbol;

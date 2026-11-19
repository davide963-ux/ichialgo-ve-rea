/**
 * The strategy, packaged for the server.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The scanner runs in a Vercel function, which is plain JavaScript; the
 * strategy is TypeScript under src/ and is written for the browser. The
 * tempting shortcut is to re-implement "EMA50 touch" in .mjs next to the
 * route. This project has already been burnt by exactly that: an earlier
 * design had a server-side scanner writing its opinion to Postgres while the
 * page computed another, and the two could disagree with nothing to say which
 * was right.
 *
 * So there is no second implementation. `scripts/bundle-strategy.mjs` runs
 * esbuild over THIS file and emits `server/strategy.bundle.mjs`, which the
 * scanner imports. The server and the browser execute the same functions,
 * compiled from the same source, in the same build.
 *
 *   src/services/strategy/*.ts
 *            │
 *            ├── vite build ─────▶ dist/   (the browser)
 *            └── esbuild ────────▶ server/strategy.bundle.mjs  (the scanner)
 *
 * Nothing here may import a browser-only module. Everything re-exported below
 * is pure computation over candles — no fetch, no stores, no DOM — which is
 * what lets one bundle serve both sides.
 */
export { analyseEma50Touch } from './ema50Touch';
export { ticketLevels } from './tradePlan';
export { pipsOf, resolveBar } from './backtest';
export { pipSize, toPips } from '../../lib/pips';
export { PAIRS, getPair } from '../../config/pairs';
export { EMA50_TOUCH, ICHIMOKU_CONFLUENCE, STRATEGY_CONFIG, TRADE_PLAN } from '../../config/strategy';
export { TIMEFRAME_SECONDS } from '../../config/timeframes';
// Candle plumbing: the scanner talks to Yahoo directly rather than through
// this app's proxy, but must agree with the browser about what a bar is.
export { yahooQuery, parseYahooChart, toYahooSymbol, resample, rangeFor } from '../marketData/providers/yahooCandles';
export { tdSeriesQuery, parseTdSeries } from '../marketData/providers/twelveDataSeries';
export type { Timeframe } from '../../config/timeframes';
export type { TouchSignal, WatchLevel } from './types';

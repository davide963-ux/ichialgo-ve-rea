# Ichialgo — Forex terminal

**Live Forex market data, a 24/7 multi-timeframe confluence scanner, a backtest that replays the
same code the scanner runs, and an R-multiple results page.**

| Stack | |
|---|---|
| UI | React 19 + TypeScript, React Router 7 |
| Charts | TradingView Lightweight Charts v5 (open-source charting library) |
| Build | Vite 8 |
| Server | `server/api.mjs` read-only market-data proxy (used by dev, preview and `npm start`), with Twelve Data multi-key failover |
| Strategy | Multi-timeframe confluence: structure, BOS/CHoCH, S/R, patterns, EMA50, Ichimoku |
| Tests | Vitest — 336 across the engine, indicators, lifecycle, backtest, scanner, proxy |
| Data | Twelve Data, behind a provider interface |

---

## 1. Quick start

```bash
npm install
cp .env.example .env      # fill in ONE provider (see below)
npm run dev               # http://localhost:5173
npm test                  # calculator unit tests
npm run build             # typecheck + production bundle
npm start                 # production server: dist/ + proxy on http://127.0.0.1:8080
```

### Twelve Data keys

Twelve Data is the only provider. It is the one free forex source that serves intraday OHLC
candles **to a server, from any country, without a broker account** — OANDA is licensed per
country, Finnhub puts forex candles behind a paid plan, and Yahoo's unofficial endpoint blocks
datacenter IPs, so none of them work from a cloud host.

```
TWELVEDATA_API_KEY_1=key_from_account_1
TWELVEDATA_API_KEY_2=key_from_account_2
TWELVEDATA_API_KEY_3=key_from_account_3
TWELVEDATA_API_KEY_4=key_from_account_4
TWELVEDATA_API_KEY_5=key_from_account_5
```

One key per Twelve Data account; the numbering is the **failover order**. `TWELVEDATA_API_KEYS`
(comma-separated) and a single `TWELVEDATA_API_KEY` also work and can be mixed — see
`server/twelveDataKeyPool.mjs`.

#### The budget, and what more keys buy you

Free Basic is **8 credits/min and 800 credits/day PER KEY**, and `/quote` costs **1 credit per
symbol** — so a 7-pair refresh spends 7 credits. Candles (charts + the strategy) come out of the
same budget.

| Keys | Credits/min | Credits/day | Warm-up | Runtime/day at 60s polling |
|---|---|---|---|---|
| 1 | 8 | 800 | several minutes | ~1 h |
| 3 | 24 | 2400 | ~46 s | ~2.9 h |
| 5 | 40 | 4000 | ~46 s | **~4.8 h** |

Past ~3 keys the per-minute limit stops being the constraint and the **daily cap** becomes it.
More keys buy runtime, not speed. To trade speed for runtime, change one number:

| `VITE_TWELVEDATA_POLL_MS` | Credits/hour | 5 keys (4000/day) |
|---|---|---|
| `30000` (30 s) | ~1680 | ~2.4 h |
| `60000` (1 min, default) | ~840 | ~4.8 h |
| `120000` (2 min) | ~420 | ~9.5 h |
| `300000` (5 min) | ~168 | ~24 h |

(Quotes are 7 credits per refresh; candles cost roughly the same again.)

Check the pool any time at **`/api/td-rest/_status`** — key count, credits used today and each
key's state, with the keys masked to their last 4 characters.

> **Restart `npm run dev` after editing `.env`.** The keys have no `VITE_` prefix, so they stay in
> the Node proxy and are never bundled into browser code.

#### Background tabs do not spend credits

Polling suspends while the tab is hidden and takes one fresh reading when it comes back.

This matters more than it sounds. Seven pairs at the default 60-second interval spend ~420
credits an hour, so a single forgotten background tab exhausts a 4,000-credit daily budget in
under ten hours — and then the charts, the backtest and the scanner all fail on an exhausted
key. The failure has no error of its own; it surfaces days later as "the data stopped working".

Streaming is deliberately left running: a websocket the provider is already pushing to costs
nothing per message, and tearing it down on every tab switch would trade a real reconnect for
an imaginary saving.

### Security: the proxy is read-only
`server/api.mjs` forwards only an allowlist of **GET** endpoints (`quote`, `time_series`, and the
local `_status` report). Everything else gets `403`/`405`, and any non-GET method gets `405`.
Keeping it read-only and explicit means a bug here cannot turn the proxy into a general-purpose
relay, and your API keys never leave the server.
`npm start` binds to `127.0.0.1`. Don't expose it publicly without authentication in front.

### Why not TradingView for data?
TradingView does not offer a public market-data API for this. We use their **open-source chart library**
for rendering and a real Forex provider for data.

---

## 2. Architecture

```mermaid
flowchart TD
    subgraph Browser
      UI["UI components<br/>(pages + components)"]
      Hooks["Hooks<br/>useMarketStore / useCandles / useNow"]
      Store["Market Data State<br/>state/marketStore.ts"]
      Svc["MarketDataService<br/>streaming · polling · staleness · errors · candle cache"]
      IF{{"MarketDataProvider interface"}}
      TD["TwelveDataProvider"]
    end
    Proxy["server/api.mjs (read-only GET allowlist)<br/>injects the API key"]
    Pool["twelveDataKeyPool.mjs<br/>failover across N API keys"]
    TDAPI[("Twelve Data")]

    UI --> Hooks --> Store
    Svc -- "setState()" --> Store
    Hooks -- "getCandles()" --> Svc
    Svc --> IF
    IF --> TD
    TD -- "/api/td-rest" --> Proxy
    Proxy --> Pool
    Proxy --> TDAPI
```

Rules enforced by the structure:

- UI **never** imports a provider. It reads `marketStore` and calls `marketDataService`.
- Provider-specific code lives only in `services/marketData/providers/`.
- The factory `providers/index.ts` is the only file that knows concrete providers.

### Folder map

```
src/
  config/        pairs.ts (add pairs here), timeframes.ts, app.ts, strategy.ts
  services/marketData/
    types.ts                 provider contract, Quote, Candle, ProviderError
    http.ts                  fetch + timeout + HTTP→error mapping
    MarketDataService.ts     orchestration (the heart of the data layer)
    providers/               TwelveDataProvider, creditBudget, factory
    index.ts                 singleton + public exports
  services/strategy/
    analyse.ts               the orchestrator: scores both sides, picks the better
    contract.ts              StrategyAnalysis + tiers, the types every consumer reads
    engine/config.ts         every threshold, scaled to typical candle range
    engine/scale.ts          typical range + directional efficiency (no ATR)
    engine/structure.ts      swings, trend, BOS vs CHoCH (pure, tested)
    engine/levels.ts         S/R zones, breakout episodes, retests (pure, tested)
    engine/chartPatterns.ts  reversal / continuation / bilateral (pure, tested)
    engine/candles.ts        21 candlestick patterns (pure, tested)
    engine/trendTools.ts     EMA50, Ichimoku, momentum readers
    engine/scoring.ts        weighted confluence, contextual + capped (tested)
    engine/risk.ts           structural stop, structural targets, RR gate (tested)
    lifecycle.ts             SetupTracker: turns states into events (pure, tested)
    backtest.ts              replays candles through analyse() (pure, tested)
    performance.ts           R-multiple metrics, shared with live results (tested)
  state/marketStore.ts       immutable external store (useSyncExternalStore)
  state/accountStore.ts      balance + risk %, persisted; shared by plans and calculator
  hooks/                     useMarketData, useCandles, useChartIndicators,
                             useSignalStorage, useBacktest, useNow
  lib/indicators/            ema, atr, ichimoku (+tests)
  lib/                       positionSize (+tests), pips, format, time, locale
  components/                Navbar, MetricCard, ForexTable, ForexRow, MarketStatus,
                             PriceChange, PairDetails, CandlestickChart, TimeframeSelector,
                             EmptyState, BacktestPanel, BacktestResults, EquityCurve,
                             Calculator, ConnectionBanner, KumoMark, ScannerStatus
  components/chart/          kumoPrimitive (the Kumo fill)
  pages/                     Dashboard, PairPage, Results, Backtest, CalculatorPage
server/
  api.mjs                    read-only GET allowlist + Twelve Data key failover
  twelveDataKeyPool.mjs      multi-key credit pool (+ tests next to it)
  index.mjs                  production server (dist/ + the same proxy)
api/                         Vercel entry points wrapping server/api.mjs
```

---

## 3. How live data flows

```mermaid
sequenceDiagram
    participant App
    participant Svc as MarketDataService
    participant P as Provider
    participant S as marketStore
    participant UI as ForexRow (×7)

    App->>Svc: start()
    Svc->>S: status = LOADING
    Svc->>P: assertConfigured()
    alt missing / rejected credentials
        P-->>Svc: ProviderError(config | auth)
        Svc->>S: status = ERROR (halt until Reconnect)
    end
    Svc->>P: getQuotes(7 pairs)  (initial snapshot)
    P-->>Svc: { quotes, failed }
    Svc->>S: quotes, status = ONLINE
    S-->>UI: each row re-renders only for its own symbol
    else polling (Twelve Data)
        loop every pollIntervalMs
            Svc->>P: getQuotes()
        end
    end
```

### Connection state machine

```mermaid
stateDiagram-v2
    [*] --> LOADING
    LOADING --> ONLINE: first quotes
    LOADING --> ERROR: config / auth error
    LOADING --> ERROR: no data and nothing cached
    ONLINE --> OFFLINE: no contact for 12s (stream)\nor 2×poll+10s (polling)
    ONLINE --> OFFLINE: network / provider error
    OFFLINE --> ONLINE: data resumes (auto retry 5s → 60s backoff)
    ONLINE --> ERROR: token revoked (auth)
    ERROR --> LOADING: user clicks Reconnect
```

**Stale data is never shown as live.** When status is not `ONLINE`, rows are dimmed and tagged
`STALE`, the header shows `● MARKET DATA OFFLINE`, and a banner explains why.
Weekend closures are different: the connection stays `ONLINE` and rows show `CLOSED`.

### Error handling matrix

| Error kind | Example | What the service does | What the user sees |
|---|---|---|---|
| `config` | proxy not running, bad account id | halt | red banner + fix instructions + Reconnect |
| `auth` | 401/403 | halt | "Twelve Data rejected the API key…" |
| `rate_limit` | 429 / Twelve Data credits | wait `Retry-After` (default 60s) | banner with countdown; OFFLINE if data ages out |
| `network` | timeout, stream stalled | exponential backoff 5s→60s, stream re-open 15s→5min | OFFLINE + STALE rows |
| `invalid_symbol` | pair not offered | drop that pair only | row tagged UNAVAILABLE |
| `no_data` | empty response | retry | ERROR/OFFLINE banner |

### Streaming (not used today)

`MarketDataService` can drive a push stream and fall back to polling when it dies, but Twelve
Data's WebSocket needs a Pro plan, so `capabilities.streaming` is `false` and the app polls.
The plumbing is kept because adding streaming later means implementing `subscribe()` on the
provider and nothing else.

### Candles

`useCandles(symbol, timeframe)` loads 300 candles, refreshes every `candleRefreshMs`
(≥120s on Twelve Data), and patches the **forming** candle's high/low/close with live ticks.
It never creates bars. `CandlestickChart` calls `series.update()` for small changes (keeps the user's zoom)
and `setData()` when the pair or timeframe changes.

**24H change**
Twelve Data's own `percent_change`, measured against the previous daily close — the column header
tooltip says so. There is no bid/ask on the REST quote, so those columns show `—`.

---

## 4. Strategy: multi-timeframe confluence

Weighted confluence over market structure, support/resistance, chart and
candlestick patterns, EMA50 and Ichimoku — scored across three timeframes.

### The hierarchy

```
4H  ──▶ directional context      (endorses or objects; never vetoes)
1H  ──▶ where setups are found   (the working timeframe)
15M ──▶ entry timing             (confirmation bonus)
```

They are deliberately **not** required to agree. The 4H supplies context, the
1H finds the setup, the 15M times the entry. Demanding all three look identical
is the over-filtering that makes a scanner silent for days.

### What is measured

| Family | Weight | What it reads |
|---|--:|---|
| Market structure | 20 | HH/HL/LH/LL, swing highs and lows, trend, ranging |
| BOS / CHoCH | 15 | break of structure vs change of character |
| Support / resistance | 15 | multi-touch zones, role flips, headroom |
| Chart pattern | 10 | reversal, continuation, bilateral |
| Candlestick | 10 | 21 patterns, weighted by **location** |
| EMA50 | 10 | side, slope, retest, reclaim, breakdown, extension |
| Ichimoku | 10 | cloud side, Tenkan/Kijun, future cloud, Chikou |
| Breakout / momentum | 10 | breakout, retest-and-hold, directional drive |
| Multi-timeframe | 10 | 4H agreement, 15M confirmation |

### BOS vs CHoCH

The same price action is one or the other depending on the trend **in force
when it happened**:

```
uptrend   + break of last swing HIGH → BOS   (continuation)
uptrend   + break of last swing LOW  → CHoCH (character change)
downtrend + break of last swing LOW  → BOS   (continuation)
downtrend + break of last swing HIGH → CHoCH (character change)
```

Neither requires the other. A CHoCH followed by a BOS **in the new direction**
is the strongest reversal evidence available and is reported as such. The trend
is rebuilt bar by bar rather than read from the end of the series — classifying
an old break with today's trend is hindsight, and it relabels the CHoCH that
*started* the current trend as a BOS.

### Scoring is contextual, not additive

- A bullish **CHoCH in a downtrend** is a reversal warning — near-full points.
  The same CHoCH in an uptrend is a swing break; a quarter of that.
- A bullish **BOS in an uptrend** is continuation — full points. In a downtrend
  it is a counter-trend poke, worth far less.
- A **candlestick's location is a multiplier**: mid-range it earns 30% of its
  weight, at support/EMA/a retested breakout it earns all of it.
- **Bilateral patterns get no direction.** A symmetrical triangle damps the
  score and warns; it never picks a side before the breakout.
- **Correlated evidence is capped.** Price above cloud + bullish cloud +
  Tenkan over Kijun is one trending fact seen three ways, so the family is
  capped at its weight.

### The score is normalised against available evidence

This is the mechanism that stops over-filtering. A family that had data but
found nothing counts at **half weight** in the denominator; a family with no
data at all is excluded. The spec's own wording is the model: *"No recent BOS,
therefore confidence is reduced slightly"* — slightly, not by fifteen points.

Without it, a clean trend reaction at support with a good candle and full
indicator agreement could not reach the tradeable band, because three unrelated
families happened to be silent.

### Tiers

| Score | Tier |
|--:|---|
| 85–100 | STRONG BUY / STRONG SELL |
| 72–84 | BUY / SELL |
| 62–71 | EARLY BUY / EARLY SELL |
| 52–61 | WATCHLIST |
| < 52 | NEUTRAL |

Only **BUY and above are recorded as trades**. EARLY and WATCHLIST are visible
in the scan's ranked `opportunities` list but never entered — recording a setup
the strategy itself called unconfirmed would book the outcome of a trade nobody
should have taken.

### One entry, one stop, one target

No TP1/TP2/TP3 ladder. Reaching the target is a win worth its reward/risk;
reaching the stop is −1R. There is no third outcome.

> The ladder was structurally losing and is worth recording. Its first rung sat
> at the nearest opposing level — the likeliest place for price to turn — and
> reaching it banked **nothing**, it only pulled the stop to breakeven. So the
> commonest winner paid 0R while every loser paid −1R, and the system profited
> only when price broke clean *through* the level it was aimed at. On a pure
> random walk it lost 0.14R a trade, where the arithmetic says it must return
> zero.

Stops are anchored to **structure only** — the swing the setup was built on,
the zone it rejected, or the pattern's invalidation — plus a small wick
allowance, because a stop sitting exactly on an obvious swing low is the most
reliably hunted price in the market. There is no volatility floor or cap: an
earlier ATR minimum manufactured very tight stops paired with very distant
targets, which showed a flattering reward/risk and were taken out by ordinary
noise far more often than their geometry implied.

If a level sits so close that price is already standing on it, the stop steps
**out** to the next structural level rather than being padded to a constant.

The target is the next real obstacle, placed just short of it — the level is
where the opposing orders are, so price routinely turns a few pips before
reaching it. A target that does not pay `minRewardRisk` **rejects the ticket**,
and an actionable tier with no ticket is demoted to EARLY rather than emitted.

### Refusing to trade a range

The strategy is trend-following, so it earns in trends and bleeds in ranges —
and real intraday forex spends most of its time ranging. That is why an early
version came back negative on *every* pair over *every* period.

Swing structure cannot see the difference: a range prints a higher low on every
bounce. So a separate, purely structural measure gates it — **directional
efficiency**, net displacement over total path length:

```
|close[end] − close[start]|  ÷  Σ |close[i] − close[i−1]|
```

A market travelling below the threshold can be WATCHED but never TRADED,
whatever its confluence score. Swept, not guessed:

| min efficiency | trades | blended R/trade |
|--:|--:|--:|
| 0.00 (off) | 624 | **−0.061** |
| 0.15 | 373 | +0.073 |
| 0.22 | 277 | +0.154 |
| **0.28** | 232 | **+0.206** |
| 0.35 | 204 | +0.204 |

It improves monotonically to 0.28 then flattens — a knee, not a fitted peak.

### What is measured, not assumed

Expectancy across three deliberately different generated markets, 14 seeds
each, in R per trade:

| Market | Result |
|---|--:|
| Trending | **+0.39R** |
| Pure random walk | **+0.03R** (≈0, as it must be) |
| Mean-reverting | −0.37R, on 25 trades instead of 548 |

The random-walk column is the honest check: on a driftless walk expectancy is
mathematically **zero** for any reward/risk, so anything far from zero is a bug
rather than an edge. It reads −0.12R with the chop filter off.

The mean-reverting column never becomes positive — a trend strategy in a range
should lose. What changed is that it now takes 25 trades there instead of 548,
so the damage is −9R rather than −166R.

- **~1–2%** of bars carry a tradeable signal; **~64%** carry an EARLY or
  WATCHLIST reading, so the scan list is never empty
- **causality verified**: replacing every bar after the analysed one with
  garbage does not change the answer, at any of 120 sample points

> None of this is evidence of a live edge. Generated data cannot provide that.
> What these numbers establish is that the engine is **causal**, that its
> tickets are **coherent**, and that it is **not systematically losing** — which
> is the bar a strategy has to clear before real-money questions are worth
> asking.

### Tuning

Every threshold lives in `src/services/strategy/engine/config.ts`, expressed
as a multiple of the **typical candle range** on the pair and timeframe being
analysed, so one number means the same thing on EUR/CHF and GBP/JPY, and on
15M as on 4H.

That scale is a plain mean of recent high-to-low ranges — deliberately *not*
ATR: no true-range gap handling, no Wilder smoothing. It answers one question
("is this distance large relative to normal movement?") and is never used to
place a stop.

### Seeing why a pair is or is not signalling

```bash
curl -sS -H 'x-scanner-token: TOKEN' \
  'https://<your-app>/api/scanner?dry=EUR/USD&tf=1H'
```

Writes nothing; returns the full analysis including `reasons`, `warnings` and
the complete score breakdown.


## 5. Position-size calculator

Pure functions in `src/lib/positionSize.ts`, tested in `positionSize.test.ts`. Account currency is USD.

```mermaid
flowchart TD
    I[balance, risk %, pair, entry, SL, TP] --> V{valid?}
    V -- no --> E[show errors]
    V -- yes --> D[direction = SL < entry ? LONG : SHORT]
    D --> P["pip = 0.01 if quote is JPY else 0.0001"]
    P --> Q{quote currency}
    Q -- USD --> Q1[1]
    Q -- "base is USD (USD/JPY…)" --> Q2[1 / entry]
    Q -- "cross (EUR/JPY…)" --> Q3[live USD/XXX or XXX/USD rate]
    Q1 & Q2 & Q3 --> PV["pip value per lot = 100,000 × pip × USD-per-quote"]
    PV --> L["lots = risk / (stop pips × pip value), floored to 0.01"]
    L --> R["loss, profit, R:R"]
```

Worked example (unit test): USD/JPY at 150.00, stop 150.50, $10,000, 1% risk
→ 50 pips, pip value $6.67/lot, **0.30 lots**.

---

## 6. Signal history (database)

Every signal the scanner produces is written to Postgres, so the record survives a page reload,
a redeploy and a browser change. The **Results** page reads it back.

The browser never writes. Signals come from the server-side scanner alone — an earlier version
also computed them in the browser and posted them, which gave the app two sources of truth that
could disagree.

### The shape of it

```mermaid
flowchart LR
    CRON["cron every 15 min<br/>x-scanner-token"] --> SC["/api/scanner<br/>server/scannerCore.ts"]
    SC --> AN["analyse()"] --> TR[SetupTracker]
    TR -- "rpc/record_signals<br/>service key" --> PG[("Supabase Postgres<br/>public.signals")]
    SC -- "rpc/close_signal<br/>TP/SL checks" --> PG
    RP[Results page] -- "GET /api/signals?symbol=&timeframe=&result=" --> API["server/signals.mjs<br/>read-only"]
    API -- "select, newest first" --> PG
```

The browser never talks to Supabase. It posts to our own proxy, which holds the **service key**
server-side — the same rule as the market-data keys. The table has RLS enabled with **no
policies**, so the anon key cannot read or write it even if it leaks; only the service role gets
through.

### Why an upsert, and why signals change

A touch is first seen while its bar is still forming (`outcome: 'pending'`, `source: 'live'`) and
is re-examined once the bar closes, when it becomes a bounce, a cross or inside. So the same
signal is sent more than once with better information. `upsert_signals` merges on the signal id:

```sql
where s.source = 'live' or s.outcome = 'pending'   -- only overwrite a provisional row
detected_at = least(s.detected_at, excluded.detected_at)  -- keep the first sighting
```

A confirmed row is never downgraded by a later live one, and the timestamp stays the moment the
touch was first seen. Client-side, `signalVersion = id|source|outcome` decides what to re-send:
a signal whose outcome changed gets a new version, so it goes up again; an unchanged one doesn't.

### Setup

Three environment variables, server-side only:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<service_role key from Project Settings → API>
SCANNER_TOKEN=<any long random string you invent>
```

`SUPABASE_SERVICE_KEY` is the **service_role** key, not the anon/publishable one. It bypasses RLS,
so it belongs only in the server environment — never in `VITE_*`, never in the bundle.

`SCANNER_TOKEN` is what stops anyone who finds the URL from triggering a scan. The cron service
sends it as the **`x-scanner-token`** header; `/api/signals` is read-only and needs no token.

Vercel binds environment variables to a **deployment**, so changing this in the dashboard does
not affect the deployment already running — redeploy, or the function keeps comparing against
the old value. A `401` from `/api/scanner` reports `headerPresent` and `lengthMatch` so you can
tell "no header sent" from "trailing newline" from "genuinely a different secret".

Apply `supabase/migrations/` to the project (Supabase SQL editor, or `supabase db push`) to create
the table and the RPC.

**Without these variables the app still works.** `/api/signals` answers `503` with
`{"configured": false}` and the Results page explains what is missing instead of erroring.

### Table

| column | notes |
|---|---|
| `id` | the app's own signal id — `strategy\|symbol\|timeframe\|barTime`, which is what makes the upsert idempotent |
| `symbol`, `timeframe`, `bar_time`, `detected_at` | when and what |
| `source` | `candle` (a closed bar) or `live` (a forming one) |
| `outcome` | `pending` · `bounce` · `cross` · `inside` |
| `approach`, `trend`, `bias` | direction of the touch and the EMA50 slope |
| `ichimoku` (jsonb), `ichimoku_score` | the five checks, and how many passed |
| `plan` (jsonb) | entry, structural stop, target, lot size |

`toRow()` in `server/signals.mjs` validates every field against the same CHECK constraints the
table enforces and **drops** a bad row rather than failing the batch — one malformed signal
cannot block the rest. `historyQuery()` whitelists the filter columns and caps `limit` at 1000, so
the query string cannot be used to construct an arbitrary PostgREST request.

---

## 7. Extending

**Add a pair:** append to `EXTRA_SYMBOLS` in `src/config/pairs.ts`. Nothing else changes.

**Add a provider:** the interface is still there, so the UI, strategy and backtest need no changes.
1. Implement `MarketDataProvider` in `providers/MyProvider.ts` (map symbols, map errors to `ProviderError`).
2. Register it in `providers/index.ts` and add `'myprovider'` to `ProviderId`.
3. Add a read-only route for it in `server/api.mjs` (`routes` array).
4. **Create the serverless entry point** re-exporting `_lib/handler.mjs`, and get the SHAPE right:

   | The route your proxy serves | The file Vercel needs |
   |---|---|
   | `/api/<prefix>/something` | `api/<prefix>/[...path].js` |
   | `/api/<prefix>` (bare, params in the query) | `api/<prefix>.js` |

   A `[...path]` catch-all matches `/api/foo/bar` but **not** `/api/foo` — it needs at least one
   segment. Neither mistake fails locally, because Vite pipes every request through the shared
   middleware whatever is in `api/`. `server/api.routes.test.mjs` derives the required shape from
   the route regexes and fails if a route and its file disagree.



**Tune the strategy:** everything is in `src/services/strategy/engine/config.ts`. **Replace** it:
rewrite `analyse.ts` against the same `StrategyAnalysis` contract and bump `STRATEGY_ID` in
`server/scannerCore.ts`. Nothing else changes — the tracker, scanner, database, backtest and
Results page are all strategy-agnostic, and `analyse.test.ts` asserts the contract they depend on.

```mermaid
flowchart LR
    MDS[MarketDataService] -->|"getCandles()"| BT["useBacktest"] --> BE["runBacktest()"]
    BE --> AN["analyse()"]
    CRON[cron] --> SC["/api/scanner"] --> AN
    AN --> TR[SetupTracker] --> PG[("signals")]
    PG --> RP[Results page]
    BE --> BR[Verdict · equity curve · trades]
```

Both paths into `analyse()` are the point: the backtest and the live scanner cannot diverge,
because there is only one implementation to diverge from.

---

## 8. Production deployment

```bash
npm run build
npm start          # serves dist/ and the proxy; reads .env
```

`server/index.mjs` is a small Express server that uses the **same** proxy module as `npm run dev`.
Configure it with `PORT` and `HOST` in `.env`. Put HTTPS and authentication (nginx, Caddy, Cloudflare Access, a VPN) in front
before exposing it beyond your machine.

If you use your own reverse proxy instead, copy the **GET-only allowlist** from `server/api.mjs`.
Don't use a catch-all `/v3/` rule.

### Testing against a mock provider
`TWELVEDATA_REST_URL` overrides the upstream host, for local testing only. Point it at a mock
server that returns Twelve Data-shaped JSON to exercise LOADING, ONLINE, OFFLINE and ERROR states
offline — including credit exhaustion, which is otherwise awkward to reproduce on purpose.

# Multi-symbol support: scope

What it would take to go from one tradable symbol to many, on the terminal (candlestick) shell.

Written after reading the engine rather than from the outside, so every claim below cites the code
that supports it. Nothing here is built yet.

---

## 0. Where we are today

**One symbol per brand, and the protocol has no concept of a second one.**

| Fact | Evidence |
|---|---|
| One `MarketSymbol` exists | `packages/shared/src/candles.ts` — `export const XAUUSD: MarketSymbol = { symbol: "XAUUSD", digits: 2, anchor: 2650, scale: 85 }` and nothing else |
| One price series per site | `apps/engine/src/siteregistry.ts` builds a single `new MarketHistory(...)` per site, passing no `instrument`, so it defaults to `XAUUSD` |
| The socket carries one instrument | `GameSocketProvider` — `getMarket: () => { instrument: MarketSymbol; anchor } \| null`. There is no symbol list in the protocol |
| A position does not record its symbol | `packages/db/migrations/0180_position_execution_price.sql` adds an execution price; no column names a symbol |

The eleven Volatility indices are **not** a counter-example: they live in the digits shell
(`components/game/digits/`), not the terminal.

---

## 1. The thing that makes this cheap: the mechanism already exists

The digits shell already runs **independent per-instrument price series off one day seed**, in
production. `packages/shared/src/instrumentfeed.ts`:

```ts
constructor(private readonly daySeed: string, readonly instrument: Instrument, K = 5) {
  const rng = new SeededRng(daySeed, `inst:${instrument.id}`);
```

The per-instrument **domain separator** (`inst:${id}`) is what makes each instrument's series
independent while staying deterministic from the one day seed. The engine caches them per
`(seed, instrumentId)`:

```ts
private feedFor(seed: string, instrumentId: string): InstrumentFeed {
  const key = `${seed}:${instrumentId}`;
```

The terminal's curve does **not** do this yet. `packages/shared/src/curve.ts` uses a fixed domain:

```ts
const rng = new SeedKeystream(serverSeed, "curve", 1 + 3 * WALK_POINTS);
```

Changing `"curve"` to `` `curve:${symbol}` `` is the entire mechanism for per-symbol curves. Keeping
the literal `"curve"` for XAUUSD makes it backwards compatible, so every historical day and every
settled position reconstructs exactly as before.

---

## 2. Does this touch the win/loss engine? Two paths, two answers

> **GATE RESULT: PASSED.** Measured, not assumed, in `settle.calibration.test.ts`. The realised win
> rate and RTP hold on six symbols' own curves at both the production config (edge 0.75, win rate
> 0.125) and a marketer-shaped one (edge 0.05, win rate 0.8); two symbols' per-second increments
> correlate at |r| < 0.1, so they are genuinely independent rather than transforms of one series; and
> the default symbol reconstructs bit-for-bit, so nothing already settled moves.

This is the question that decides whether the work is allowed at all, and the two paths differ.

### Pool path — the curve is already cosmetic

`apps/engine/src/game.ts`, verbatim comment:

> *"the shared curve entry/exit rate remain as cosmetic backdrop; the win/loss/amount come from the
> pool controller."*

The outcome comes from `pool.controller.decideReserve({ ... targetRtp, targetWinRate ... })`. The
curve supplies `entryRate`/`exitRate` for the record and the chart, and decides nothing.

**All production brands run pool mode**, so for them per-symbol curves cannot affect an outcome at
all.

### Statistical path — the curve DOES decide

`packages/shared/src/settle.ts`:

```ts
settle(stakeCents, dir, entryT): Outcome {
  const move = this.signedMove(dir, entryT);   // reads this.curve
  if (move >= p.tau) { ...win... }
  return { result: "loss", ... };
}
```

So with pool mode off (and for marketers), the curve's own movement decides win or loss.

**It still does not change the engine, and here is why.** Every per-symbol curve is *the same
stochastic process with a different seed* — identical `GameConfig`, identical generator, identical
distribution. The calibration that pins `targetWinRate` and RTP (`tau`, `gain`) is a property of
that distribution, not of any particular seed. A second symbol is another sample from the same
process, so the calibrated win rate holds on it unchanged.

That is a claim worth testing rather than asserting, and it is cheap to test: run the existing
calibration test (`packages/shared/src/settle.calibration.test.ts`) across N symbol seeds and assert
the realised win rate stays inside its tolerance for each. **That test is a precondition of shipping
this, not a nice-to-have.**

---

## 3. Real market data cannot drive settlement

The request was to pull prices from TradingView or another free source. Two separate problems.

### 3a. Licensing — surveyed, and the answer is harder than expected

Full survey in [11-market-data-sources.md](./11-market-data-sources.md). Three findings.

**TradingView has no data API at all.** Its own support page: *"We don't have an API that gives
access to data as of now, but we are planning to add it in the future."* Its terms go further than
barring redistribution: *"price referencing"* is named in the prohibited **non-display** list, so
reading a TradingView price to drive anything in this system is already out before redistribution is
reached. What it gives away is chart CODE: Lightweight Charts (Apache 2.0) and Advanced Charts
(proprietary, free with their logo). TradingView's own words: *"Advanced Charts is a chart with your
data."*

This chart already uses Lightweight Charts, and already sets `attributionLogo: true`, which carries
the link the Apache-2.0 NOTICE requires. **We are compliant today and gain nothing by changing.**

**There is no free, licence-clean source of redistributable intraday FX or spot-metals prices.** Not
one. Every free FX source is end-of-day only (ECB), or keyed to a trivial quota, or explicitly
personal-use. Metals benchmarks are paid outright: LBMA requires an IBA licence *"in order to obtain,
use or redistribute"* its data. **If this product ever showed live gold or FX to end users, that is a
paid line item**, not a free one. The two exceptions are crypto (CoinGecko's Demo tier permits it
with attribution) and end-of-day EUR-base FX (ECB, free, with conditions).

Worth knowing for this product specifically: **the ECB reference set does not include KES.** Verified
live.

**Reference metadata, though, is solved free and commercially.** Digit counts and contract sizes are
market conventions and need no licence at all; OpenFIGI identifiers are dedicated to the public
domain; GLEIF's LEI data is CC0. That is exactly the half we need.

### 3b. The architectural problem, which is the bigger one

If settlement followed real prices, the engine would lose control of the win rate. `targetWinRate`
(0.125), `houseEdge` (0.75), the pool RTP budget and the marketer win rate are all knobs on a
*synthetic* process. Point them at a real market and they stop being knobs: the outcome becomes
whatever the market did, the house edge becomes market-dependent, and the product stops being a
fixed-odds game.

If instead the chart showed real prices while the engine settled on its own curve, the chart would
be lying about the thing it is drawn to explain. This codebase has been careful about exactly that:

> *"History bars are the same seeded curve the settlement engine scores — not a re-render of it."*
> — `CandleChart.tsx`

**So: real data for REFERENCE, synthetic for PRICES.** Open data decides what a symbol *is* — its
name, description, category, digit count, and the price level it should sit near — and the engine
generates its movement. XAUUSD near 2650 at 2 digits, EURUSD near 1.08 at 5, BTCUSD near 60000 at 2.
That is reference data, it is static, and it is the low-risk half of the licensing question.

---

## 4. Work breakdown

| # | Piece | Where | Size |
|---|---|---|---|
| 1 | Symbol catalogue: `MarketSymbol[]` with digits/anchor/scale + MT5 metadata (description, path, category) | `packages/shared/src/candles.ts` (+ a new `symbols.ts`) | S |
| 2 | Per-symbol curve domain separator, XAUUSD keeping the current literal for compatibility | `packages/shared/src/curve.ts` | **XS** |
| 3 | Calibration test across many symbol seeds | `packages/shared/src/settle.calibration.test.ts` | S |
| 4 | ~~`MarketHistory` per symbol, cached per `(site, symbol)`~~ **DONE** | `apps/engine/src/symbolhistories.ts` (new), `siteregistry.ts`, `markethistory.ts` | M |
| 5a | ~~Socket protocol: symbol list, symbol on the candles and anchors requests~~ **DONE (engine)** | `apps/engine/src/multiengine.ts` | S |
| 5b | ~~Per-symbol LIVE quotes: subscribe/unsubscribe, one quote message per socket per tick~~ **DONE** | `apps/engine/src/multiengine.ts`, `GameSocketProvider` | M |
| 6 | Position records its symbol (migration + repo + receipts) — **BLOCKED, see 6a** | `packages/db/migrations/0182_*`, repo | M |
| 7 | Per-brand symbol assignment, so a brand can offer a subset | DB + admin | M |
| 8 | ~~Market Watch becomes a real list; the context menu's `Symbols`, `Sort`, `Hide` become live~~ **DONE** | `MarketWatch.tsx`, `MT5SymbolsDialog.tsx`, `lib/game/symbolSet.ts` | M |
| 9 | ~~Chart symbol switching~~ **DONE** (drawings and properties already keyed off symbol) | `CandleChart.tsx`, `GameCurve.tsx`, `lib/game/chartSymbol.ts` | S |

Items 8 and 9 are the only UI work; 1 to 7 are platform.

**Order:** 2 and 3 first. They are small, and 3 is the gate: if the win rate does not hold across
symbol seeds, the whole plan changes and nothing after it is worth building.

### 4a. What item 4 turned out to cost, measured

A `MarketHistory` is one instrument's chain of days walked forward from genesis, so multi-symbol
means one history object per symbol. `SymbolHistories` owns the set: built on first use, evicted
least-recently-used past a cap, with the default symbol pinned because it is also the brand's price
axis and a cold rebuild of it would sit in the path of a trade rather than a chart request.

Eviction is safe for a reason worth stating: the chain is deterministic from the day seeds, so a
rebuilt history produces bit-for-bit the same bars. That is tested, not assumed.

**The cost is real and it is CPU, not memory.** Measured on this container, EURUSD, 400-day window:

| Request | Cold | Warm |
|---|---|---|
| `liveAnchor()` | 2.2 s | 0 ms |
| `candles("H1", 48)` | 2.3 s | 0 ms |
| `candles("M15", 200)` | 2.4 s | 3 ms |
| `candles("D1", 365)` | 8.1 s | 10 ms |

Nearly all of the cold figure is the chain itself: one `CurveGenerator` per day at ~8ms each, and
the generator is expensive because it materialises an 86,402-step walk from the keystream up front.
There is no shortcut — the day's closing value IS the end of that walk — so ~2.2 s per symbol is the
floor for a 400-day window.

Two things were fixed on the way, and both help the single-symbol brand that exists today:

- **Hourly bars are no longer built in the chaining pass.** The chain needs exactly two numbers from
  each day, its opening and closing curve value; it was also sampling 1440 points and folding them
  on all 400 days whether or not anything asked. Bars are now built when something asks for them.
- **The chain fills the days a request actually needs from the curve it is already holding.** Which
  days are wanted is known before the walk starts, so the walk fills those and skips the rest,
  instead of building each wanted day's curve a second time afterwards.

Together those took a cold `H1` request from ~8.7 s to ~2.3 s, and a cold year of dailies from
~8.7 s to ~8.1 s. Nothing got slower. There are now two code paths to a day's bars — the chain's own
fill and the later fold — and a test asserts they agree, because otherwise which timeframe a client
asked for FIRST would change the prices it saw.

**What this means for item 5.** A ~2.2 s synchronous stall is fine for a chart request that was
going to wait anyway, and not fine on the engine's event loop while it serves every other brand. So
the socket protocol should warm a symbol when a client SUBSCRIBES to it, off the critical path,
rather than discovering the cost inside the first candles request. That is item 5's problem and it
is noted here so it is not rediscovered.

`MarketHistoryOptions.historyDays` exists for the same reason: a caller that needs a short window
can say so instead of paying for a year. It is not a free knob — a shorter chain re-anchors on a
later day, so it changes that brand's prices — which is why production stays at 400.

### 5a. What the protocol carries now

`candles` and `anchors` take an optional `symbol`. Absent (or null) means the brand's default, which
is every client written before multi-symbol, so nothing already shipped has to change. A symbol the
brand does not offer is **refused** with `UNKNOWN_SYMBOL` rather than served the default's bars under
the requested name — serving gold's prices labelled EURUSD is the worst failure available here,
because the chart would look entirely right and be a different instrument.

A new `symbols` request returns the brand's list: symbol, description, group and digits, plus
`defaultSymbol` so a client need not work out which row that is. It is unauthenticated for the same
reason the candles are, and it carries **no prices** — a quote is the tick stream's job, and a quote
embedded in a list reply is one nothing can age.

**Why the UI did not follow immediately.** The chart could already draw any symbol's history, but
the live tick stream was still the brand's single curve, so switching the chart's symbol would have
drawn that symbol's bars with the default symbol's live edge: a chart that disagrees with itself at
the right-hand edge. Market Watch had the same problem one step worse. So 5b came first.

### 5b. Live quotes, and why there is no quote streamer

The original plan said "a quote streamer per `(site, symbol)`". There is none, and that is better.

A quote is emitted on the brand's EXISTING tick loop: `onTick` sends the brand tick as before, then
one `symbol_ticks` message per socket carrying every symbol that socket watches. Three consequences,
each of which a separate timer would have cost:

- **A symbol's quote cannot drift out of step with the brand's own tick.** For the default symbol
  the two are the same number, and a terminal shows the brand tick in its price header and the watch
  list beside it; on separate timers the same instrument would show two prices on one screen. There
  is a test that pins them equal at a shared timestamp.
- **One message per socket per tick, not one per symbol.** Twenty rows would otherwise be twenty
  messages a tick.
- **Nothing to start, stop or garbage-collect.** No idle-streamer bookkeeping, because there is no
  streamer.

What a quote needs is a rate AND the anchor it belongs to, so a subscription is answered in two
parts: `subscribed_symbols` immediately (what was accepted, what was rejected and the cap), then a
`symbol_quote` per symbol once its chain is warm, carrying the instrument, its day anchor and a
first price. The tick stream afterwards carries only `{symbol, rate, delta}`. A symbol that is not
warm yet is **skipped rather than quoted**: its rate is available, since that needs only today's
curve, but a rate without its anchor cannot be turned into a price, so sending it would be a number
the client could only misplot.

**Warming is sliced.** `MarketHistory.warm()` walks the chain two days at a time and yields to the
event loop between slices, so the ~2.2s is wall time rather than a stall. `SymbolHistories.warm()`
queues them: one chain at a time per brand, because concurrency cannot make any of them finish
sooner on one thread and would interleave the stalls that slicing exists to avoid. The candles and
anchors handlers warm the same way instead of chaining inline.

**Two caps that have to agree.** The engine holds `DEFAULT_MAX_RESIDENT = 24` histories per brand
and a socket may watch `MAX_WATCHED_SYMBOLS = 20`. The order matters: a watched symbol is touched
every tick, so a watch list LONGER than the resident set would evict and rebuild every symbol on it
continuously, and because a rebuilt history starts cold, not one of them would ever be warm enough
to quote. The quotes would simply never arrive. A test asserts the inequality rather than trusting
the two numbers to stay in step.

### 8. Market Watch, as MetaTrader's actually works

MetaQuotes is explicit that the window "shows the symbols selected by the trader" — a broker's
catalogue runs to hundreds and the window shows a dozen. So the list is a stored per-device
preference (`lib/game/symbolSet.ts`), seeded with the seven majors plus gold, curated through the
Symbols dialog (Ctrl+U) and the context menu's Hide / Hide All / Show All / Sort.

The stored list is **filtered against the brand's catalogue on every read**, because the preference
outlives the catalogue: a symbol the brand stops offering would otherwise sit in the window for ever,
never quoting and never explaining itself. An EMPTY stored list is respected rather than replaced
with the default, because `Hide All` is a thing a trader can choose.

The context menu's reasons were rewritten, not just unlocked. `Hide`, `Show All`, `Symbols`, `Sort`
and `Grid` are real actions now. The rest still carry a reason, and the reasons had to change: they
used to say "this brand quotes one symbol", which is no longer true of anything. `Popup Prices` is
refused because it is a separate always-on-top window and this terminal is a browser tab; `Columns`
because MetaTrader's optional columns are Bid, Ask, Spread and Time, and there is no spread on these
contracts and one price rather than two.

`Show All` is the one place the cap shows through: MetaTrader shows everything, this shows as many
as the feed quotes at once, and the dialog says how many that is rather than silently truncating.

### 8a. The row itself, read off MetaTrader's own pixels

A second pass took the row from "symbol, change, price" to MetaTrader's own shape, every detail from
[10-market-watch.md](./10-market-watch.md) section 2:

- **The three-state gutter glyph** — a thin green arrow up (`#00A91C`), a thin red arrow down
  (`#D83933`), or a grey filled dot (`#A1A1A1`) where the price has not moved. It sits INSIDE the
  Symbol column rather than in a column of its own, which is why MetaTrader gives it no header. Note
  its colours are not the quote's: the arrow is green and red while the price beside it is blue and
  red. MetaTrader is inconsistent with itself there, and copying it is the point.
- **It replaced an invention.** A blue bar had marked which symbol the chart was on. MetaTrader's
  Market Watch does not mark that, because the chart's own title says so.
- **The Time column** — "the last quote arrival time" — in MetaTrader's column order, after the
  prices and before Daily Change. MetaTrader drops Time and Daily Change off the right edge when the
  window is narrow; this panel does the same with a breakpoint rather than by clipping, and a test
  now asserts no column is ever cut off mid-number.
- **Daily Change has no space before its `%`**, while the account summary strip writes
  `1 076.68 %` WITH one. Both are copied as found.
- **The add row** at the BOTTOM of the list: `+ click to add...` with the shown/available counter
  right-aligned on the same row (`8 / 96`), both verbatim from the help. The `+` button that used to
  sit in the panel header is gone, because MetaTrader has no such control there.

**Drag a symbol onto the chart to chart it**, which is MetaTrader's own gesture: *"A symbol chart
can be opened by dragging it to the chart viewing area using a mouse (Drag'n'Drop)."*

Double-click charts it too, and that is a **deviation worth naming**. MetaTrader's double-click
"opens a new position opening window"; this terminal's order ticket is permanently docked, so there
is no window for it to open, and dropping the gesture would leave a phone — which has neither a
right-click nor a drag — with no way to change the chart at all.

---

## 5. Decisions needed before building

1. **How many symbols, and which?** FX majors, metals, crypto and indices all behave differently and
   need different `digits`/`anchor`/`scale`. A catalogue of ~20 is a different job from ~200.
2. **Per brand, or global?** MT5 brokers offer per-account symbol sets. Item 7 only matters if
   brands differ.
3. ~~**Do open positions survive a symbol switch?**~~ **DECIDED: yes, a trader may hold positions on
   several symbols at once**, as MetaTrader does. This is the largest single consequence of the
   whole plan and it is now in scope. See section 7.
4. **Historical reconstruction.** A new symbol has no past. Either its history starts today, or the
   generator backfills it from the same seeds — the latter is free, because the curve is
   deterministic from the day seed, and is what the chart already does for XAUUSD.

---

## 7. Concurrent positions across symbols (DECIDED: yes)

MetaTrader holds many positions at once and so will this. It is the largest consequence of the plan,
because several things in the engine and the UI assume exactly one open contract.

What it reaches, found by reading rather than guessed:

| Assumes one open contract | Where |
|---|---|
| `activePosition` is a single value on the socket context | `GameSocketProvider` |
| The Toolbox's Trade tab renders `live` as one row, and the account strip prints "1 open" | `MT5Toolbox.tsx` |
| `openStakeCents` feeds Margin as a single stake | `accountSummary`, shared |
| The chart draws one open-position price line | `CandleChart.tsx` |
| The order ticket's Stop Loss text says "the stake", singular | `MT5OrderTicket.tsx` |
| Exposure already handles many, and nets them per symbol | `exposureRows`, shared — **already correct** |

The money side needs care rather than courage:

- **Margin becomes the SUM of open stakes**, which `accountSummary` takes as one number today. That
  is a small change with a large blast radius, because Equity, Free margin and Margin level all hang
  off it.
- **The pool budget is per brand, not per position.** Several contracts open at once draw on one
  RTP budget concurrently. `decideReserve` already reserves atomically per position id, so the
  mechanism holds, but the concurrency is new and wants a test that N simultaneous opens cannot
  over-reserve.
- **A per-symbol open limit** is worth having from the start, so one account cannot hold a hundred
  contracts and make the Toolbox unusable.

`exposureRows` was written to take a list and net per symbol, so the Exposure tab needs no change at
all. That was not foresight about this decision; it was what the MetaTrader tab genuinely means.

### 6a. Why the position's symbol is blocked, and why it is not like the execution price

The display price (migration 0180) is written by a separate UPDATE after the atomic money RPC
returns, never awaited, because a missed stamp costs nothing: the column stays null and the client
prints "at market".

**The symbol cannot work that way.** It is an input to settlement, not a record of it: in the
statistical path the curve decides win or loss, so a position opened on EURUSD has to settle on
EURUSD's curve. Crash recovery reconstructs a position from its seed, nonce and config version, so
if a fire-and-forget symbol write were lost, recovery would settle that position on the wrong
curve — different money, not a missing label. That makes it a trade attribute like `direction` and
`duration_s`, and those live inside `fn_open_position`.

So item 6 needs the atomic open RPC extended, and this container has no `DATABASE_URL`. Writing a
377-line money-RPC rewrite that cannot be executed even once is the wrong kind of brave, so it is
not written here. What it needs, when the database is reachable:

1. `positions.symbol text` (nullable; null means the brand's own symbol, which is every row that
   exists today).
2. `fn_open_position` extended with `p_symbol`. Note the signature trap: `create or replace` with an
   extra parameter creates an OVERLOAD rather than replacing, and a default would then make the
   10-argument call ambiguous. The old signature has to be dropped in the same migration.
3. The engine settling on that symbol's curve, which means `SeedManager` caching a context per
   `(day, config, symbol)` rather than per `(day, config)`.
4. Recovery reading the symbol back, since it is what decides which curve to reconstruct.

### 9. Chart symbol switching, and the honest state of the ones it cannot trade

The chart switches symbol: double-click a Market Watch row, or `Chart Window` from its context menu.
The choice is stored per device, the drawings and chart properties were already keyed off the
symbol, and the live edge follows the charted instrument rather than the brand's own tick stream.

The interesting part is what happens to the ORDER TICKET, because item 6 is blocked and this brand
settles exactly one symbol. The ticket follows the chart, as MetaTrader's does, and on any other
symbol it refuses the order and says `Trade disabled for <SYMBOL>` with a link back to the tradable
one.

That is not a gap dressed up as a feature. `Trade` is a real row in MetaTrader's own Specification
dialog, and `Disabled` is one of its five values: a broker sets it on a symbol it quotes and charts
but will not accept an order on. The Specification dialog here now prints exactly that for every
symbol the brand does not settle, so the ticket and the specification agree, and a trader who checks
why gets MetaTrader's own answer. When item 6 lands, those symbols become `Full access` and the same
ticket starts taking orders on them.

Two guards behind the disabled buttons, because a disabled button is not a money-path argument:
`place()` returns early on a disabled symbol, and an OPEN position is named and priced with the
symbol the brand settles rather than the charted one — otherwise a gold contract would be labelled
EURUSD and its P/L drawn against the wrong axis.

## 8. What is NOT in scope

- Real-money market exposure, or any claim that these prices are real.
- Prices sourced from a vendor whose terms forbid redistribution.
- Any change to how a win, a loss, a payout or the house edge is computed.

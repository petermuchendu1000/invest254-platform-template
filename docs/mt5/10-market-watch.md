# MT5 Market Watch, Depth of Market and Symbol Specification — verified specification

Researched 2026-10-05 from MetaQuotes' own MT5 help, the mobile help, and MetaQuotes' own help
screenshots read pixel by pixel after 2.4–12× upscaling, with per-pixel colour sampling. Every
claim carries a source. Where a fact could not be established this document says so rather than
filling the gap, and the gaps are listed in "Could not verify" at the end. MT4 material is not
mixed in anywhere.

**The help page is where we thought it was**, for once:
[`trading/market_watch`](https://www.metatrader5.com/en/terminal/help/trading/market_watch) and
[`trading/depth_of_market`](https://www.metatrader5.com/en/terminal/help/trading/depth_of_market)
both resolve. `trading/symbols` and `trading/instruments` are 404 — **the Symbols dialog has no
page of its own**; it is a section ("How to Manage Symbols") inside the Market Watch page. So is
Symbol Specification ("Viewing Symbol Specification"), the Details tab ("How to View Trade
Statistics…"), the Trading tab ("One Click Trading"), the Ticks tab and Popup Prices. One page
carries all seven surfaces.

## The headline answers

1. **Window name: `Market Watch`**, and the title bar carries the live server time:
   **`Market Watch: 16:56:57`**. Read off five independent current-build screenshots.
2. **`Ctrl+M` confirmed**, verbatim: *"Ctrl+M — Open/close the "Market Watch" window."*
3. **Four tabs, confirmed twice over** — once from pixels, once from the Hot Keys page:
   `Symbols | Details | Trading | Ticks`. Our guess of a two-tab set was wrong.
4. **Symbols tab columns: `Symbol | Bid | Ask | Spread | Time | Daily Change`.**
   Our `Symbol | Bid | Ask | ! | Spread` is a **2015-build** memory — see §2.2, where the `!`
   column is identified and its meaning proved arithmetically.
5. **The tick colour rule is confirmed verbatim and the exact colours are measured**:
   blue `#0000FF` up, red `#FF0000` down, **and the "grey" state is not grey — it is the
   theme foreground** (`#000000` on the white Market Watch, `#FFFFFF` on the black Popup Prices
   window). Timeout **15 seconds**, verbatim.
6. **Bid and Ask are coloured independently of each other**, by each cell's own tick direction.
   MetaQuotes' prose says the opposite ("the color is determined by the Bid price"). The pixels
   win — see §3.3.
7. **Symbol Specification's window title is `Specification`**, and for a Forex symbol it is
   **23 label rows + two bold section headers**, not ~40. The ~40 figure is the help's
   *documented superset*; the dialog renders only what the broker set for that instrument type.
   The exact rendered order is in §7.2.
8. **There are two different, mutually inconsistent Market Watch context menus live on the same
   help page today** (one with `Use System Colors` and no `Fundamental Data`, one with
   `Fundamental Data` and no `Use System Colors`). Both are in §4.

## Corrections to assumptions we held

1. **There is no `!` column in the current build.** `Spread` is spelled out. The `!` header is
   real but belongs to the ~2015 build (§2.2).
2. **The `!` column *is* the Spread column.** Proven on 9 of 9 rows of `ru/market_watch.png` by
   subtracting Bid from Ask. Not inferred — computed.
3. **"Grey after 15 seconds" is wrong about the colour.** Nothing renders grey. The price
   reverts to the normal text colour; only the row's **leading glyph** turns grey (`#A1A1A1`).
4. **Tick colouring is per-cell, not per-row.** `XAGUSD` renders Bid blue and Ask red in the
   same row, in MetaQuotes' own screenshot, five separate times across four screenshots.
5. **`02-toolbox-and-panels.md` §5e is wrong**: the Trading tab's SELL and BUY halves do **not**
   share one colour. `NZDCAD` renders SELL blue and BUY red in one panel.
6. **Depth of Market is not exchange-only.** MetaQuotes publishes a DoM screenshot for
   **GBPUSD**, an OTC Forex pair, with a reduced toolbar. §6.4.
7. **The DoM window's title is the symbol, not "Depth of Market"**: `LKM6, Futures contract
   LKOH-6.26`, `GBPUSD, Pound Sterling vs US Dollar`.
8. **The DoM toolbar has 9 buttons, not 10** (`02` said 10), and drops to **5** for an OTC
   instrument.
9. **`Alt+B` and `Ctrl+U` and `F10` are context-menu strings only.** None of the three is on the
   Hot Keys page. The Hot Keys page's only Market Watch entries are `F9`, `Space/Tab`, `A`, `G`
   — and `Ctrl+M` in the global block.
10. **The Symbols dialog has three tabs** (`Specification | Bars | Ticks`) and **three buttons
    plus OK**, not the "Hide"/"Show" the prose names: `Show Symbol`, `Hide Symbol`,
    `Create Custom Symbol`, `OK`.
11. **`Popup Prices` has three different names** in MetaQuotes' own material: `Popup Prices`
    (context menu), `Popup prices:` (its own title bar, lowercase p), and **`"Quotes Window"`**
    (Hot Keys page, F10).
12. **Mobile's equivalent is `Quotes`, and it has two modes with no official names** — "full and
    reduced" (Android prose) vs "adapted for mobile devices (default mode)" and "as a table used
    in the desktop platform version" (iPhone prose). Not "simple/advanced".

---

## 1. The window

### 1.1 Name, title bar and chrome

| Where | String |
|---|---|
| Title bar, floating and docked | **`Market Watch: HH:MM:SS`** — e.g. `Market Watch: 16:56:57`, `05:54:19`, `18:01:11`, `04:13:11`, `23:39:22` |
| Help body, verbatim | *"The Market Watch window provides an overview of price data of financial instruments: quotes, price statistics and tick chart. It also provides details of contract specifications and One Click Trading options."* |
| Hot Keys page, verbatim | *"Ctrl+M — Open/close the "Market Watch" window."* |
| Russian build (2015 asset) | **`Обзор рынка: 09:35:33`** ( = "Market Review"), not a transliteration |

**The time in the title is the broker's server time**, not local: the `Time` column values in
`market_watch_x2.png` top out at exactly the title's `16:56:57`, and the help defines the Time
column as *"The last quote arrival time. Specified according to the time zone of the broker's
trading server."*

- An **`✕`** sits at the far right of the title bar. There is no minimise, no maximise, no pin.
- The tab strip (`Symbols | Details | Trading | Ticks`) runs along the **bottom** edge, like the
  Toolbox's and the Navigator's.
- The active tab is a raised white tab; inactive tabs are grey text separated by thin vertical
  rules. When the panel is too narrow, **`◀ ▶` scroll arrows** appear at the right of the strip.

### 1.2 Opening it

```
Ctrl+M    Open/close the "Market Watch" window.
```
Verbatim from the [Hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys)
page, "Common Actions in the Platform" block.

**There is no documented menu route**, exactly as with the Toolbox. The User Interface page says
only *"You can choose to display only the tools that you currently need. For example, you can
hide Market Watch and Navigator, and show the Depth of Market and Data Window."* It never names
the View menu item. (`08`/`09` recorded MetaQuotes' live typo in the same menu list: `Inset`.)

### 1.3 Market-Watch-scoped hot keys (Hot Keys page, verbatim, complete)

| Key | Action |
|---|---|
| `F9` | Call the "New Order" window. |
| `Space/Tab` | Switch between "Symbols", "Details", "Trading" and "Ticks" tabs. |
| `A` | Auto arrange columns in the "Symbols" tab. |
| `G` | Show/hide grid. |

**That is the entire block.** `Space/Tab` is MetaQuotes' own spelling, with a slash. Note `A` is
scoped *"in the "Symbols" tab"* here, where the Toolbox block writes the same key as the
unscoped *"Enable/disable auto sizing of columns"*.

### 1.4 Docking

Docked **top-left by default, with the Navigator directly below it** (verified in
`bulk_positions.png`, `position_manage.png`). Unlike the Toolbox, a docked Market Watch keeps a
**horizontal title bar** with the `✕` at the right — it does not get the Toolbox's rotated
left-gutter caption.

**How it is undocked, resized or auto-hidden is not documented anywhere.** Same gap as the
Toolbox (`09`, "Could not verify" #2–3).

### 1.5 The tab strip, verbatim

```
Symbols | Details | Trading | Ticks
```

Confirmed from **pixels** (`market_watch_x2.png`, `market_watch_details_x2.png`,
`market_watch_trading_x2.png`, `tick_chart_x2.png`, `market_watch_fast_add_x2.png`) **and from
prose** (Hot Keys page, `Space/Tab`). The Russian 2015 build has the same four:
`Символы | Детали | Торговля | Тики`. **Four tabs, this order, unchanged across eleven years.**

---

## 2. The Symbols tab

> **One line:** the quote grid — one row per subscribed symbol, a tick-direction glyph in the
> gutter, an inline add row at the bottom, and a shown/available counter.

### 2.1 Columns, default visible set

Read off `en/market_watch_x2.png` at 3×:

```
Symbol | Bid | Ask | Spread | Time | Daily Change
```

- `Symbol` is left-aligned. **Every other column is right-aligned, header included.**
- `Symbol` carries **no header text for the glyph gutter** — the direction glyph sits inside the
  `Symbol` column, left of the name. It is not a separate column.
- At narrow widths `Spread` truncates to **`Spre…`** and `Time`/`Daily Change` fall off the
  right edge entirely (`market_watch_fast_add_x2.png`).

The help's numbered callouts for these six, verbatim and in order:

1. *"Financial instrument name"*
2. *"Bid price"*
3. *"Ask price"*
4. *"Spread — the difference between the Bid and Ask prices"*
5. *"The last quote arrival time. Specified according to the time zone of the broker's trading server."*
6. *"The difference between the last price of the instrument and the close price of the last session in percentage terms."*

`Daily Change` renders as a signed percentage with **no space before `%`**: `0.09%`, `-2.85%`,
`1.00%`. (The account summary strip writes `1 076.68 %` *with* a space — `09` §4.2. MetaQuotes
is inconsistent across panels.)

`Spread` renders as a bare integer in **points**: `0`, `7`, `15`, `160`, `1500`, `2420`.

### 2.2 The `!` column — identified

It is real, and it is **the Spread column under an older header string**. `ru/market_watch.png`
(the 2015 Win7-era Russian asset, still served) shows:

```
Символ | Bid | Ask | Последняя | Объем | ! | Время
Symbol | Bid | Ask | Last      | Volume| ! | Time
```

The `!` header is literally a single exclamation mark, right-aligned, verified at 12×. Its
values are `88, 7, 9, 4, 756, 1, 11, 14, 30`. Subtracting Bid from Ask on the same nine rows:

| Row | Bid | Ask | Ask − Bid, in points | `!` |
|---|---|---|---|---|
| EURUSD | 1.10384 | 1.10472 | 88 | **88** |
| GBPUSD | 1.53932 | 1.53939 | 7 | **7** |
| USDCHF | 1.27249 | 1.27258 | 9 | **9** |
| USDJPY | 121.359 | 121.363 | 4 | **4** |
| USDMXN | 15.81072 | 15.81828 | 756 | **756** |
| DG-20150729 | 500.3 | 500.4 | 1 | **1** |
| GAZR-9.15 | 13957 | 13968 | 11 | **11** |
| LKOH-9.15 | 24343 | 24357 | 14 | **14** |
| RTS-9.15 | 86360 | 86390 | 30 | **30** |

**Nine of nine exact.** The `!` column is `Spread`.

**Do not ship a `!` column.** The current build writes `Spread`, confirmed on five independent
current-build screenshots. Record the `!` only as the historic header.

The same 2015 asset shows two other columns the current default set drops — `Last` (`Последняя`)
and `Volume` (`Объем`) — and omits `Daily Change`. **The default visible set is not stable
across builds.** (Same finding as `09` §6.1 for the History tab.)

### 2.3 Which columns are default and which are added

MetaQuotes states only: *"The displayed data can be configured in the context menu. For example,
you can show the "Source" field — the provider of the financial instrument liquidity."* The
control is **`Columns ▸`**, the last item of the context menu, present in both published menu
variants.

**MetaQuotes publishes no screenshot of the `Columns ▸` submenu and no list of its entries.**
`i/help/terminal/en/market_watch_columns.png` and `…_x2.png` are both 404.

Two rules the help *does* state, both conditional and both worth implementing:

> *"In the High and Low columns of symbols whose charts are built at Bid prices, the Bid High and
> Bid Low prices are displayed. If a symbol chart is constructed using Last prices, Last High and
> Last Low prices are shown for this symbol. **If Market Watch contains at least one symbol whose
> chart is drawn based on Last prices, the Last column is automatically enabled in addition to
> High/Low.**"*

> *"No more than 5000 financial instrument can be added to "Market Watch"."* (MetaQuotes' own
> missing plural.)

**Third-party only, medium confidence:** [myforex.com](https://myforex.com/en/mt5guide/columns-marketwatch.html)
lists the `Columns ▸` submenu as **46 entries**, in this order:
`Last, High/Low, Volume, Spread, Time, Daily Change, Source, Tick Size, Tick Value, Face Value,
Accrued Interest, Initial margin, Maintenance margin, Initial Buy margin, Initial Sell margin,
Lower Limit, Upper Limit, Settlement Price, Bid High, Bid Low, Ask High, Ask Low, Last High,
Last Low, Volume High, Volume Low, Deals, Deals Volume, Turnover, Open Interest, Buy Orders,
Buy Volume, Sell Orders, Sell Volume, Open Price, Close Price, Average Weighted Price,
Volatility, Theoretical Price, Delta, Theta, Gamma, Vega, Rho, Omega, Sensitivity`.
Note `Bid` and `Ask` are **not** in that list — they are not toggleable. **This is not a
MetaQuotes source. Treat as a sketch, not as fact.**

### 2.4 Row rendering

```
glyph  SYMBOL      Bid        Ask        Spread   Time       Daily Change
 ↗     EURUSD      1.13828    1.13828         0   16:56:57         0.09%
 ↘     USDJPY      163.870    163.870         0   16:56:57         0.08%
 •     XAUUSD      4621.82    4621.97        15   09:22:06        -2.85%
 ↘     XAGUSD       57.082     57.101        19   16:56:56        -2.25%
 •     USDRUB       77.701     79.201      1500   16:00:04         0.23%
 ↗     AUDCAD      0.98265    0.98269         4   16:56:57        -0.43%
 ＋    click to add...                                              16 / 134
```

- **The gutter glyph is three-state**: a thin **green `↗`** (`#00A91C`), a thin **red `↘`**
  (`#D83933`), or a **grey filled dot `•`** (`#A1A1A1`). It is not documented anywhere.
- **The add row** reads **`＋ click to add...`** with a green `+`, grey italic-weight text and
  three ASCII dots. Clicking it turns the row into an inline text field with a live
  autocomplete list below it — e.g. typing `XAUU` offers
  **`XAUUSD, Gold (one troy ounce) vs United States Dollar`**. Verbatim help: *"To quickly add a
  symbol in the Market Watch, click + below the list and enter the name of the symbol. While you
  type in the name, the list of suitable symbols is shown."*
- **The counter** is right-aligned on the same add row: **`16 / 134`** = shown / available.
  Verbatim: *"Information about the current number of symbols in the Market Watch and the total
  number of available symbols is available at the bottom of the list."*
- **Row backgrounds alternate** `#FFFFFF` / `#EBEBEB`; grid lines `#C8C8C8`; the selected row is
  a pale blue `#E1F1FE` wash across the whole row (not a blue fill — the text keeps its colours).
  In the 2015 build the selected row was instead a **solid blue fill with white text**.
- A **green clock glyph** replaces the arrow for a symbol on delayed data — observed on `AMD` in
  `market_watch_fundamental_x2.png`, and matched by the mobile `quotes_delayed.png`, where
  delayed symbols (`AA`, `AAPL`, `BLK`, `BRN`, `CL`) carry a clock before the time. **MetaQuotes
  never documents the glyph**; the only adjacent string is the context menu's
  `Subscribe to Realtime Datafeed`, and the mobile spec field `Subscription` — *"the broker may
  offer access to real-time quotes through a paid subscription. Without a subscription, data may
  be streamed with a delay. In this case, the value of this parameter will indicate the length of
  the delay."*
- An **expired contract renders its symbol name in grey** (`DG-20150729` in `ru/market_watch.png`).

### 2.5 Sorting

> *"To sort the list of symbols, click on any column header. For example, the list can be sorted
> by symbol name, close price, daily change or other variables. The context menu features the
> most popular sorting options. For example, sorting by the highest growth and fall based on a
> daily symbol price change can be useful when trading exchange instruments."*

The control is **`Sort ▸`** in the context menu. **Its entries are not published** — no
screenshot shows the submenu open, and the prose names no strings. See "Could not verify" #2.

### 2.6 Export

> *"To save the current state of Market Watch data to a CSV file, select 'Export'. All columns
> and their values displayed at the time of export will be saved to the file."*

`Export` is a flat menu item with a green outbound-arrow icon. No dialog is published.

### 2.7 Drag and double-click behaviour, verbatim

> *"Double-clicking on one of the instruments opens a new position opening window. A symbol chart
> can be opened by dragging it to the chart viewing area using a mouse (Drag'n'Drop); in this
> case windows of currently open charts will be closed. If you hold down "Ctrl" while dragging,
> the chart is opened in a separate tab, and other charts remain open."*

> *"If there are open positions or pending orders for the financial instrument, or when its chart
> is open, the instrument cannot be hidden from the Market Watch."*

> *"If a symbol is hidden in Market Watch, its data cannot be used in MQL5 programs and the
> Strategy Tester."*

---

## 3. Tick-direction colouring — the exact rule

### 3.1 MetaQuotes' wording, verbatim, in full

> *"Prices in the "Market Watch" window have different colors:*
> ***Blue** — the current price is higher than the previous one;*
> ***Red** — the current price is lower than the previous one;*
> ***Gray** — the price has not changed for the last 15 seconds.*
> *If the depth of market and the Last trade price is available for a symbol, the color is
> determined by the Last price. Otherwise, the color is determined by the Bid price."*

The **same four sentences appear a second time on the same page**, for the Trading tab, with one
word changed:

> *"Depending on the quotes, **the trade operation execution and price field** may have different
> colors: Blue — the current price is higher than the previous one; Red — the current price is
> lower than the previous one; Gray — the price has not changed for the last 15 seconds. If the
> depth of market and the Last trade price is available for a symbol, the color is determined by
> the Last price. Otherwise, the color is determined by the Bid price."*

**15 seconds is confirmed, twice, verbatim.** It is the only timeout MetaQuotes states anywhere
for this.

### 3.2 The measured colours

Sampled from `en/market_watch_x2.png` with PIL, dominant non-background pixel per cell:

| State | Measured | Hex |
|---|---|---|
| Price ticked **up** | `(0, 0, 255)` | **`#0000FF`** — pure blue |
| Price ticked **down** | `(255, 0, 0)` | **`#FF0000`** — pure red |
| Price **unchanged ≥15 s** | `(0, 0, 0)` | **`#000000`** — plain black, *not* grey |
| Gutter glyph, up | `(0, 169, 28)` | **`#00A91C`** — green |
| Gutter glyph, down | `(216, 57, 51)` | **`#D83933`** — red |
| Gutter glyph, unchanged | `(161, 161, 161)` | **`#A1A1A1`** — grey |
| Selected-row wash | `(225, 241, 254)` | `#E1F1FE` |
| Alternating row bg | `(255,255,255)` / `(235,235,235)` | `#FFFFFF` / `#EBEBEB` |
| Grid line | `(200, 200, 200)` | `#C8C8C8` |

⚠ **"Gray" is MetaQuotes' word and it is wrong for the price text.** The unchanged price renders
in the window's normal foreground colour. The proof is `popup_prices_x2.png`, the same data on a
**black** background: there the unchanged prices (`XAUUSD 4015.15`, `XAGUSD 56.146`,
`USDRUB 76.894`, `EURRUB 88.841`) render **white**, while up/down stay the same blue and red.
**Only the gutter glyph is literally grey.** Implement "unchanged" as `currentColor`, not as a
grey.

### 3.3 Bid only, or Bid and Ask? — Bid **and** Ask, independently

MetaQuotes says *"the color is determined by the Bid price"*. The pixels say otherwise. Every
counter-example below is a single row in a single MetaQuotes screenshot:

| Screenshot | Row | Bid | Ask | Gutter glyph | Time |
|---|---|---|---|---|---|
| `market_watch_x2.png` | XAGUSD | 57.082 **blue** | 57.101 **red** | **red ↘** | **red** |
| `market_watch_x2.png` | AUDCAD | 0.98265 **blue** | 0.98269 **red** | **green ↗** | **blue** |
| `market_watch_fundamental_x2.png` | EURJPY | 186.539 **red** | 186.542 **blue** | **green ↗** | — |
| `market_watch_fast_add_x2.png` | EURUSD | 1.13599 **red** | 1.13600 **blue** | **red ↘** | — |
| `market_watch_fast_add_x2.png` | GBPNOK | 13.03800 **blue** | 13.04260 **red** | **red ↘** | — |
| `popup_prices_x2.png` | CHFJPY | 201.122 **red** | 201.163 **blue** | n/a | n/a |

**Conclusion, safe to implement:** `Bid` and `Ask` each carry their own three-state tick colour.
So does `Time`. `Spread` is **always plain black** in every published screenshot — it is never
tick-coloured. `Daily Change` is coloured **by its own sign**, not by tick direction (GBPUSD in
`market_watch_x2.png` has blue prices and a red `-0.02%`; USDJPY has red prices and a blue
`0.08%`).

⚠ **The gutter glyph and the `Time` cell do not follow a rule we can state.** XAGUSD and AUDCAD
have the identical Bid-blue/Ask-red pattern and disagree on both the glyph and the Time colour.
MetaQuotes documents neither the glyph nor the Time cell's colouring. Recorded as a gap, not
resolved — see "Could not verify" #1.

### 3.4 Broker-set background colouring

> *"The individual background coloring for symbols can also be configured on the server. This
> enables their visual distinguishing by types, exchange and other properties. If you do not want
> to use the specified coloring, enable the "Use system colors" option in the context menu."*

Note **`Use system colors`** in prose vs **`Use System Colors`** in the menu. And note that the
option it tells you to *enable* is **already checked by default** in the published screenshot.

### 3.5 For a one-price instrument

**MetaQuotes has never published a Market Watch rendered without a bid/ask pair**, and the help
describes no single-price mode. Every published row in every asset has both. The nearest thing
to a one-sided price in MT5 is `Last`, and `Last` is an *additional* column, never a replacement:
*"If Market Watch contains at least one symbol whose chart is drawn based on Last prices, **the
Last column is automatically enabled in addition to High/Low**."*

Which Symbols-tab columns are intrinsically two-sided:

| Column | Two-sided? | Why |
|---|---|---|
| `Symbol` | no | — |
| `Bid` | **yes** | one of the pair |
| `Ask` | **yes** | one of the pair |
| `Spread` | **yes, definitionally** | *"the difference between the Bid and Ask prices"* |
| `Time` | no | last quote arrival time |
| `Daily Change` | no | last price vs last session close, in % |
| `Last`, `Volume`, `Open Price`, `Close Price`, `Turnover`, `Deals`, `Open Interest` | no | one-sided, all available as columns |
| `High`/`Low` | no, but **ambiguous** | resolve to Bid High/Low *or* Last High/Low per the symbol's chart mode |

A one-price platform keeps `Symbol`, `Time`, `Daily Change`, `Last`-family and the volume family
unchanged, and must delete `Bid`, `Ask` and `Spread` outright rather than fold them. There is no
MetaTrader precedent for a merged price column.

---

## 4. The right-click context menu

**There are two live variants on the same help page today.** Both are from the current build;
neither is obsolete. Record both; implement the newer one.

### 4.1 Variant A — `market_watch_industry_x2.png` (read at 2.2×, verbatim)

```
⊞   New Order
∿   Chart Window
∿   Tick Chart
▤   Depth Of Market        Alt+B
✕   Options Board                (greyed)
▤   Specification
▣   Popup Prices           F10
    ─────────────────────────
    Hide                   Delete
    Hide All
    Show All
💲  Symbols                Ctrl+U
    Sets                   ▸
    Sort                   ▸
↗   Export
    ─────────────────────────
✔   Use System Colors
    Show Milliseconds
✔   Auto Remove Expired
    Auto Arrange
✔   Grid
    ─────────────────────────
    Columns                ▸
```

### 4.2 Variant B — `market_watch_fundamental_x2.png` (read at 2.6×, verbatim)

```
⊞   New Order
∿   Chart Window
∿   Tick Chart
▤   Depth Of Market        Alt+B
✕   Options Board                (greyed)
▤   Specification
↻   Subscribe to Realtime Datafeed
    Fundamental Data       ▸
▣   Popup Prices           F10
    ─────────────────────────
    Hide                   Delete
    Hide All
    Show All
💲  Symbols                Ctrl+U
    Sets                   ▸
    Sort                   ▸
↗   Export
    ─────────────────────────
    Show Milliseconds
✔   Auto Remove Expired
    Auto Arrange
✔   Grid
    ─────────────────────────
    Columns                ▸
```

**The two differences, both real:**
1. Variant B inserts **`Subscribe to Realtime Datafeed`** (green circular-arrow icon) and
   **`Fundamental Data ▸`** between `Specification` and `Popup Prices`.
2. Variant B **has no `Use System Colors` item at all** — its penultimate block starts at
   `Show Milliseconds`. Variant A has it, checked.

Yet the help prose on the same page still instructs: *"…enable the "Use system colors" option in
the context menu."* **Unreconciled.**

**Verified details common to both:**
- **`Depth Of Market` is written with a capital `O`** here. The Toolbox Trade tab's menu writes
  **`Depth of Market`** with a lowercase `o` (`09` §3.5). Both are MetaQuotes'.
- The same item's shortcut is **`Alt+B`** here and **`B`** on the Trade tab (`09` §3.5).
- `Options Board` is **greyed** for a non-option symbol, with a greyed crossed-arrows icon.
- `Hide` carries the shortcut **`Delete`**.
- **`Auto Arrange` is UNCHECKED by default in Market Watch**, where it is checked in every
  Toolbox tab. `Grid` and `Auto Remove Expired` are checked; `Show Milliseconds` is not.
- `Symbols` carries the yellow `$` badge icon and **`Ctrl+U`**.
- **`New Order` carries no `F9`** in either Market Watch menu, although `F9` is listed for this
  window on the Hot Keys page and the Toolbox menu does print it.

### 4.3 `Sets ▸` (verbatim)

```
💾 Save as
   Remove        ▸
   Add           ▸
   ──────────────
   forex.all
   forex.crosses
   forex.major
```

Saved set names are listed below a separator. `Save as` carries a blue download-into-tray icon
and, notably, **no ellipsis** despite opening a name prompt.

**MetaQuotes names this feature three ways on one page**: the menu says **`Sets`**; one
paragraph says *"click "**Symbol Sets — Save as**""*; another says *"Click "**Sets \ Save**" and
specify a name for the set."* Neither prose string matches the menu, and the two prose strings
do not match each other.

Verbatim on what a set holds: *"The file will save the list of symbols and a set of selected
columns, which means that you will not need to set up the Market Watch window every time."*

### 4.4 `Sets ▸ Add ▸` — the sector tree (verbatim, complete)

```
Basic Materials          ▸
Communication Services   ▸
Consumer Cyclical        ▸
Consumer Defensive       ▸
Energy                   ▸
Financial                ▸
Healthcare               ▸
Industrials              ▸
Real Estate              ▸
Technology               ▸
Utilities                ▸
Currency                     (no submenu)
Crypto Currency              (no submenu)
Index                        (no submenu)
Commodities              ▸
```

Fifteen entries. **Three of them have no submenu arrow** — `Currency`, `Crypto Currency`,
`Index`. The rest cascade into industries; `Energy ▸` reads, verbatim:

```
All
──────────────────────────────
Oil & Gas Drilling
Oil & Gas E&P
Oil & Gas Equipment & Services
Oil & Gas Integrated
Oil & Gas Midstream
Oil & Gas Refining & Marketing
Thermal Coal
Uranium
```

Help body: *"Special trading instrument properties indicate the sector and industry which the
instrument belongs to… Select a category from the menu, and all available instruments will be
added to a list"* and *"If sector and industry data is not available, please contact your broker."*

### 4.5 `Fundamental Data ▸` (variant B only, verbatim, complete — 12 entries)

```
y!  Yahoo Finance
📊  Google Finance
W   Market Watch
🦅  SEC EDGAR
f   Finviz
Inv Investing
B   Bloomberg
🦚  CNBC
α   Seeking Alpha
🃏  The Motley Fool
B   Barrons
M   Morningstar
```

Each carries the site's own brand mark. **`Market Watch` here is MarketWatch.com, not the MT5
window** — MetaQuotes put a menu item named after the window inside the window's own menu.
Help body: *"You can easily view fundamental trading symbol data available on popular aggregator
websites: Yahoo Finance, Google Finance, Finviz and many others."*

### 4.6 Not in the menu

`High/Low` is **not** a context-menu item — it lives inside `Columns ▸`. Neither is `Spread`.
Our expectation list had both as top-level items; they are not.

---

## 5. The Details tab

> **One line:** the selected symbol's live trade statistics, as a two-column key/value list, not
> a grid.

Read off `en/market_watch_details_x2.png` at 4×, for `RIU6` (a futures contract). **Thirty rows,
in this exact order:**

```
RIU6, Futures Contract RTS-9.26          ← blue header line, symbol + description
Tick Size              10
Tick Value             15.12694
Face Value             1.00
Initial margin         137458.14
Maintenance margin     137458.14
Lower Limit            84650
Upper Limit            97090
Bid                    90100
Bid High               93720
Bid Low                89630
Ask                    90200
Ask High               93730
Ask Low                89650
Last                   90100
Last High              93730
Last Low               89620
Daily Change           -2.77%
Volume                 14
Volume High            100
Volume Low             1
Deals                  61317
Deals Volume           112.438K
Turnover               15 373 767 879
Open Interest          67136
Buy Orders             318
Buy Volume             1.055K
Sell Orders            666
Sell Volume            3.006K
Open Price             92700
Close Price            92670
```

- **Not a grid.** No column headers, no sort. Two columns: label left, value right-aligned.
- A **blue header line** at the top gives `SYMBOL, Description`.
- Rows **alternate** `#FFFFFF` / `#EBEBEB`.
- **Every row carries the same three-state direction glyph** as the Symbols tab, and its value is
  tick-coloured by the same rule. Static rows (`Tick Size`, `Face Value`, the margins, the
  limits, `Deals`, `Turnover`, `Open Interest`, `Open Price`, `Close Price`) show the grey dot
  and black text; live rows show green/red arrows and blue/red values.
- `Turnover` uses a **space thousands separator** (`15 373 767 879`); `Deals Volume`,
  `Buy Volume` and `Sell Volume` use **SI suffixes** (`112.438K`, `1.055K`, `3.006K`).

### 5.1 The documented superset, and the abbreviation split

The help's statistic list is longer than the rendered set and **uses abbreviated labels where
the dialog spells them out**:

| Help prose | Dialog |
|---|---|
| `B. High` / `B. Low` | `Bid High` / `Bid Low` |
| `A. High` / `A. Low` | `Ask High` / `Ask Low` |
| `L. High` / `L. Low` | `Last High` / `Last Low` |
| `V. High` / `V. Low` | `Volume High` / `Volume Low` |
| `Buy volume` (lowercase v) | `Buy Volume` |

Fields the help documents that the published screenshot does not render:
`Average Weighted Price`, `Settlement Price`, `Delta`, `Theta`, `Gamma`, `Vega`, `Rho`, `Omega`,
`Sensitivity`. Verbatim: *"The number of statistical values depends on the brokerage company."*

⚠ **MetaQuotes misspells one of its own field names in the same sentence that introduces it:**
*"The Greeks, which include Delta, Theta, Gamma, Vega, **Po** and Omega…"* — the list item three
lines below reads `Rho`.

`Daily Change`'s formula is given verbatim and depends on the chart mode:

> *"By Last prices: ((Last - Last price at session close)/Last price at session close)*100
> By Bid prices: ((Bid - Bid price at session close)/Bid price at session close)*100.
> For futures symbols, the clearing price is used instead of the the session close price, if the
> clearing price is provided by the broker (non-zero)…"*

(`the the` is MetaQuotes'.)

### 5.2 How the tab is reached

> *"To view statistics, select a financial instrument in the "Symbols" tab and click "Details"."*

---

## 6. Depth of Market

### 6.1 Title, opening, availability

- **The window title is the symbol, not the feature.** `LKM6, Futures contract LKOH-6.26`
  (exchange) and `GBPUSD, Pound Sterling vs US Dollar` (OTC). The string `Depth of Market` never
  appears in the title bar.
- **Opening:** *"To open the depth of market of a financial instrument, click "Depth of Market"
  in the context menu of the Market Watch."* The menu prints **`Depth Of Market    Alt+B`**.
  **`Alt+B` is not on the Hot Keys page** — it is read from the menu screenshot only. The
  Toolbox Trade tab's menu prints the same command as `Depth of Market   B`.
- **Availability, verbatim:** *"The number of bids and offers displayed in the DOM is determined
  by the symbol parameters set by the broker."* and *"**The availability of the Depth of Market
  feature for exchange instruments is not guaranteed and depends on your broker.**"*
- **It is explicitly not exchange-only:**
  > *"If an instrument is traded in the over-the-counter (OTC) market, the Depth of Market can be
  > formed based on the quotes of the broker, who may provide different prices depending on the
  > buy or sell volume. **If the broker does not provide volumes, the DOM window functions as a
  > scalping tool**, which allows placing of market and pending orders with a single click. In
  > this case, the Depth of Market displays price levels calculated based on the Bid and Ask
  > prices using the price change step."*

  MetaQuotes' own `pending_dom_example_x2.png` is a GBPUSD DoM — a Forex pair. **DoM exists for
  non-exchange symbols.** (MetaQuotes' typo in the same paragraph: *"The **Dept** of Market is
  different on the exchange and over-the-counter markets"*.)

### 6.2 Layout — exchange instrument (`dom_x2.png`)

```
┌ LKM6, Futures contract LKOH-6.26 ──────────────────────────────── ✕ ┐
│ [tick chart][T&S] │ [link][advanced][spread] │ [bid/ask][deals] │ [+][−] │
├──────────────────────────────┬──────────────────────────────────────┤
│                              │  Volume  │  Price   │     Trade      │
│  tick chart (blue Bid line,  │  ▓▓ 2073 (cumulative Buy volume bar) │
│  red Ask line, filled        │       2  │  53663▒  │  ˅        ˄    │  ← ASK side,
│  circles = deals)            │       3  │  53662▒  │  ˅        ˄    │    pink Price cells
│                              │          │  53661▒  │  ˅        ˄    │
│  cumulative volume bar at    │ ──────── • • • ────────────────────  │  ← spread divider
│  top (2 073) and bottom      │       5  │  53626░  │  ˅        ˄    │  ← BID side,
│  (2 545)                     │       9  │  53623░  │  ˅        ˄    │    blue Price cells
│                              │ ▓▓ 2545 (cumulative Sell volume bar) │
│  volume histogram strip      ├──────────────────────────────────────┤
│  beneath                     │ ▾ sl  5 ▴ │ ▾ vol  3 ▴ │ ▾ tp 10 ▴  │
│                              ├──────────────────────────────────────┤
│                              │   Sell    │   Close    │    Buy      │
└──────────────────────────────┴──────────────────────────────────────┘
```

**Ladder columns, verbatim and in order: `Volume | Price | Trade`.** Three, always.

- **Ask side on top**, Price cells washed **pink/magenta**; **Bid side below**, Price cells
  washed **light blue**. The two halves are separated by a **`• • •` row** in the exchange DoM
  and by a **plain black rule** in the OTC DoM.
- **Volume bars grow leftward from the Price column** inside the `Volume` cell — a grey-to-tint
  gradient, pinkish on the ask side, blue-grey on the bid side. The number sits at the bar's
  right end.
- The `Trade` column holds **two small outlined buttons per row**: a **red `˅`** at its left edge
  and a **blue `˄`** at its right edge. These place pending orders.
- Live orders and stop levels render **inside the `Trade` column as text badges**: `BL 0.2`
  (Buy Limit, 0.2 lots), `TP`, `SL`.
- **Bottom control strip: `▾ sl  N ▴`  `▾ vol  N ▴`  `▾ tp  N ▴`** — three spinners, labels
  lowercase, label left of the value inside the field.
- **Button row, verbatim: `Sell` · `Close` · `Buy`.** `Sell` is red/salmon-filled, `Buy` is
  blue-filled, `Close` is **grey and disabled when flat** (`dom_x2.png`) and **yellow/olive and
  enabled when a position exists** (`pending_dom_example_x2.png`). Three buttons, this order.

### 6.3 What the coloured bars represent

Two different bar families, and the help only documents one of them:

1. **The per-row bars inside the `Volume` column** are that price level's order volume — the
   ladder's depth. MetaQuotes never describes them in words; they are read from the pixels (the
   bar length tracks the number printed in the same cell, row by row).
2. **The two long cumulative bars**, one above the ask side and one below the bid side, printed
   with a single number each (`2 073`, `2 545`). Verbatim: *"At the top and bottom of the
   histogram, the total volumes of the current Buy and Sell offers are shown."*
3. **The tick-chart circles** (exchange only), verbatim: *"Red circles show Sell transactions.
   Blue circles show Buy transactions. Green circles appear when the direction of the transaction
   is undefined… The larger the circle, the greater the volume of the transaction."*
4. **Time & Sales colours**, verbatim: *"blue is used for Buy trades, pink for Sell trades, green
   means undefined direction. Trade volumes are additionally displayed in a histogram."*

### 6.4 Toolbar — 9 buttons, and 5 for OTC

The help lists nine, as icons with no captions. Verbatim descriptions, in order:

```
1  show/hide the tick chart
2  show/hide Time & Sales
   ──
3  binding the Market Depth to an active chart
4  switch to the advanced mode; every step of the price will be displayed in the depth of
   market, regardless of whether there are any offers at this price
5  show the spread in the depth of market
   ──
6  show/hide the Bid and Ask price charts
7  show/hide transactions that appear in the form of circles on the tick chart
   ──
8  zoom in the chart
9  zoom out the chart
```

**Verified against the pixels:** `dom_x2.png` renders all nine with separators after #2, #5 and
#7. **`pending_dom_example_x2.png` (GBPUSD, OTC) renders only the first five**, with the one
separator after #2 — there is no Time & Sales, no tick chart and no zoom for an OTC instrument.

> *"Most of these commands are also available in the context menu of the Market Depth and Time &
> Sales windows. The context menu of the scalping Depth of Market (for non-exchange instruments)
> also allows switching between the volume in lots and units."*

**No DoM context menu is screenshotted.** Its item strings are unverified.

### 6.5 Placing and managing orders from the DoM, verbatim

> *"To place a Buy Limit order, click ˅ in the Bid price area. To place a Buy Stop order, click ˅
> in the Ask price area. To place a Sell Limit order, click ˄ in the Ask price area. To place a
> Sell Stop order, click ˄ in the Bid price area."*

> *"Stop levels of open positions are displayed in the "Trade" column as TP (Take Profit) and SL
> (Stop Loss). These levels can be moved by mouse."*

> *"Hover the mouse cursor over the button… and click Shift. The button will change its view…
> Click the button to delete the level."*

> *"If we drag a limit order through the ask/bid border, it will change to a stop order (Buy
> Limit will be replaced by Buy Stop, while Sell Limit - by Sell Stop)."*

> *"If several same price orders are placed, they cannot be moved in the depth of market."* /
> *"If several same price orders are placed, the oldest one is removed first."*

Time & Sales export: **`Export Ticks to CSV`** in the context menu; header
`Time,Bid,Ask,Last,Volume,Type` with `Buy`/`Sell` in the Type column.
Time & Sales volume filter: *"Double click on the first line in the Time & Sales window, specify
the minimum volume in lots… the current filter value will appear in the volume column header."*

---

## 7. Symbol Specification

### 7.1 The window

- **Title: `Specification`.** Not "Symbol Specification", not "Contract Specification". With the
  yellow `$` badge icon at the left, and **a `?` help button beside the `✕`** in the title bar.
- Opened from the Market Watch context menu: *"To start viewing properties of the selected
  symbol, click "Specification" in the context menu of the Market Watch window."*
- Layout: a **blue header line** carrying `SYMBOL, Description`, then a two-column list with a
  **type glyph per row**, label left, value right-aligned, a scrollbar at the right, and a single
  **`Close`** button centred at the bottom.
- **Type glyphs** (left of each label): `ab` amber = string · `01` blue = integer ·
  `½` blue = fraction · `≡` red/blue stack = enumeration · `📅` blue calendar = day.
  Section-header rows carry **no glyph** and are drawn in **bold** on a white band.
- The header line can be a hyperlink: `ru/contract_specification.png` renders
  **`EURUSD, https://www.google.com/?finance?q=EURUSD, Euro vs US Dollar`** in blue. Verbatim:
  *"This parameter can be a link to a website containing symbol information. A popup tip with the
  link address appears when you hover the mouse over it."*

### 7.2 The EXACT rendered field list — EURUSD, current build

Read off `en/contract_specification_x2.png` (1058×1232) at 2.4×, and **independently
corroborated row-for-row** on `en/contract_specification.png` (649×764, a separate render) and
on the preview pane of `en/symbols_x2.png` (GBPUSD). **Twenty-three label rows, two bold section
headers, in this order:**

```
Specification                                              [?]  [✕]
EURUSD, Euro vs US Dollar                      ← blue header line
 ab  Exchange                                  XCCY
 ≡   Sector                                    Currency
 01  Digits                                    5
 ½   Contract size                             100 000 EUR
 01  Spread                                    floating
 01  Stops level                               0
 ab  Margin currency                           EUR
 ab  Profit currency                           USD
 ≡   Calculation                               Forex
 ½   Hedged margin                             100000
 ≡   Chart mode                                By bid price
 ≡   Trade                                     Full access
 ≡   Execution                                 Market
 ≡   GTC mode                                  Good till cancelled
 ≡   Filling                                   Fill or Kill
 ≡   Expiration                                All
 ≡   Orders                                    All
 ½   Minimal volume                            0.01
 ½   Maximal volume                            500
 ½   Volume step                               0.01
 ≡   Swap type                                 In points
 ½   Swap long                                 -0.7
 ½   Swap short                                -1
━━━  Swap rates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ← bold section header, no glyph
 📅  Monday                                    1
 📅  Tuesday                                   1
 📅  Wednesday                                 3
 📅  Thursday                                  1
 📅  Friday                                    1
━━━  Sessions ━━━━━━━━━━━━━━  Quotes ━━━━━━━━━━━━━━  Trade  ← bold header + 2 right-aligned
 📅  Sunday                   (blank)          (blank)         column headers
 📅  Monday                   00:00-24:00      00:00-24:00
 📅  Tuesday                  00:00-24:00      00:00-24:00
 📅  Wednesday                00:00-24:00      00:00-24:00
 📅  Thursday                 00:00-24:00      00:00-24:00
 📅  Friday                   00:00-24:00      00:00-24:00
 📅  Saturday                 (blank)          (blank)
                        [ Close ]
```

**Exactly two section headers group the rows: `Swap rates` and `Sessions`.** Nothing above
`Swap rates` is grouped. `Sessions` is the only one with its own column headers — **`Quotes`**
and **`Trade`**, both right-aligned and bold.

Two notes on the Sessions block: `specification_margin_x2.png` renders **seven** day rows
(Sunday…Saturday), while `contract_specification_x2.png` ends at Friday with `Close` directly
below. The window is scrollable in both; treat **Sunday…Saturday, seven rows** as the shape, and
treat the Friday-ending capture as a crop.

**For EURUSD there are no `Tick size` / `Tick value` rows at all** — MetaQuotes documents both,
but neither renders for this Forex symbol. For a futures symbol they appear instead on the
**Details** tab (§5), where `RIU6` leads with `Tick Size` and `Tick Value`. Field presence is
per-instrument-type and per-broker, exactly as the help says.

### 7.3 The margin block (`specification_margin_x2.png`)

Appended after `Sessions`, with its own bold header row carrying **four** right-aligned column
headers:

```
━━ Margin rates: floating, notional value per symbol, USD ━━ Initial ━━ usd / lot ━━ Maintenance ━━ usd / lot
 ½  Market buy
      0 - 300 000                        1.0000000   ~1 143.79    1.0000000   ~1 143.79
      300 000 - 500 000                  2.0000000   ~2 287.58    2.0000000   ~2 287.58
      500 000 - 10 000 000 000           3.0000000   ~3 431.37    3.0000000   ~3 431.37
 ½  Market sell
      0 - 300 000                        1.0000000   ~1 143.79    1.0000000   ~1 143.79
      300 000 - 500 000                  2.0000000   ~2 287.58    2.0000000   ~2 287.58
      500 000 - 10 000 000 000           3.0000000   ~3 431.37    3.0000000   ~3 431.37
```

- The header string is **generated**: `Margin rates: <floating|…>, <notional value per symbol>,
  <CCY>`. The help documents the two calculation modes as **`Notional value`** and
  **`Floating: ****`** (MetaQuotes' own asterisks).
- The per-lot money columns are **both headed `usd / lot`** — lowercase currency code, spaces
  around the slash — and their values carry a leading **`~`**.
- Range labels use a **space thousands separator** and a spaced hyphen: `500 000 - 10 000 000 000`.
- Operation rows observed: `Market buy`, `Market sell`. The help says the table covers *"each type
  of trading operation"*; the other operation names are not published.
- Warning worth carrying, verbatim: *"The margin is calculated based on the instrument price at
  the time the specification window opens and **is not updated in real-time**. Therefore, the
  values should be considered indicative."*
- And: *"The maintenance margin rate can be specified as zero, while the calculated value can be
  non-zero. This means that the maintenance margin rate is not explicitly specified, and the
  initial margin ratio is used instead."*

### 7.4 The documented superset — 39 fields plus four blocks

The help's field list, verbatim and in its own order. **This is the superset; the dialog renders
a subset.** Where the dialog's label differs, it is flagged.

```
Symbol name and description, ISIN, Spread, Digits, Stops level, Contract size, Margin currency,
Profit currency, Calculation, Chart mode, Tick size, Tick value, Trade, Execution,
Type of orders  ← dialog renders this as `GTC mode`,
Filling, Expiration, Orders, Minimal volume, Maximal volume, Volume step, Volume limit,
Swap type, Swap long, Swap short, Swap rates, First trade, Last trade, Face value,
Accrued interest, Category, Exchange, CFI, Sector, Industry, Country, Option type, Underlying,
Strike price
```
plus the blocks **`Commission`**, **`Sessions`**, **`Spreads`** and **`Margin`**.

⚠ **`Type of orders` (help) vs `GTC mode` (English dialog) vs `Тип ордеров` (Russian dialog).**
The Russian build keeps the help's wording; the English build does not. Both are current.

Enumerated values, verbatim from the help:
- `Calculation`: `Forex, Forex No Leverage, Futures, Exchange Futures, Exchange Stocks, FORTS Futures, Collateral`
- `Chart mode`: *"by last deal prices (Last) or by Bid prices"* — dialog renders **`By bid price`**
- `Trade`: `full access, long only, short only, close only` *"Also, trading can be completely prohibited."* — dialog renders **`Full access`**, capitalised
- `Execution`: `Instant, Request, Market, Exchange`
- `Type of orders`: `Good till today including SL/TP`, `Good till canceled`, `Good till today excluding SL/TP` — dialog renders **`Good till cancelled`**, with a double L
- `Filling`: `Fill or Kill, Immediate or Cancel, Book or Cancel, Return`
- `Expiration`: `Good till Canceled, Intraday, Specified time, Date` — dialog renders **`All`**
- `Orders`: *"market, limit, stop, stop-limit, Stop Loss and Take Profit"* — dialog renders **`All`**
- `Swap type`: `In points`, `In the base currency`, `In the margin currency`, `In the deposit currency`, `As a percentage of current price`, `As a percentage of the open price`, `In points, re-open at Close price`, `In points, re-open at the Bid price`

The `Commission` block's rendering, verbatim from the help (no screenshot is published):
```
Commission | Instant, volume, entry/exit deals
0  - 10   | 1.2 USD per deal
11 - 20   | 1.1 USD per loat
```
`per loat` is MetaQuotes' live typo, in the example table.

### 7.5 The Russian dialog is a different field list

`ru/contract_specification.png` (older build) renders, in order:
```
ISIN · Категория (Category) · Биржа (Exchange) · Сектор (Sector) · Точность (Digits) ·
Размер контракта (Contract size) · Спред (Spread) · Уровень стопов (Stops level) ·
Валюта маржи · Валюта прибыли · Способ расчетов (Calculation) · Построение графиков (Chart mode) ·
Торговля (Trade) · Исполнение (Execution) · Тип ордеров (Type of orders) · Заполнение (Filling) ·
Истечение (Expiration) · Ордера (Orders) · Минимальный объем · Максимальный объем · Шаг объема ·
Тип свопа · Своп длинных позиций · Своп коротких позиций ·
**Коэффициенты свопов** (Swap rates) · Пн–Пт ·
**Сессии** (Sessions) | **Котировочные** (Quotes) | **Торговые** (Trade) · Вс–…
```
Differences from the English current build: **`ISIN` and `Category` are present and come first**;
there is **no `Hedged margin`**; `Spread` is a number (`10`) not `floating`; and the two section
headers are the same two. Button: **`Закрыть`** (Close).

---

## 8. The Symbols dialog

### 8.1 Window

- **Title: `Symbols`**, with the yellow `$` badge icon. Minimise, maximise and close buttons —
  it is a resizable top-level window, not a modal.
- Opened with **`Symbols   Ctrl+U`** from the Market Watch context menu.
- **Three tabs across the top: `Specification | Bars | Ticks`.** The active tab is underlined in
  blue (a flat, modern tab style, unlike the Market Watch's raised tabs).

### 8.2 Layout and columns

```
┌ 💲 Symbols ──────────────────────────────────────── ─  ❐  ✕ ┐
│  Specification     Bars      Ticks                           │
├───────────────────┬──────────────────────────────────────────┤
│ 📁 Broker         │ [🔍 _________________________ ⌄]  ☐ Show expired contracts
│  ├─ 💲 Forex      │ ┌──────────┬──────────────────────┬────────────┐
│  ├─ 💲 Metals     │ │ Symbol   │ Description          │ Expiration │
│  ├─ 💲 Collateral │ │💲EURUSD  │ Euro vs US Dollar    │            │
│  └─ 💲 Custom     │ │💲GBPUSD  │ Pound Sterling vs …  │            │
│                   │ │💲USDCHF  │ US Dollar vs Swiss…  │            │
│                   │ └──────────┴──────────────────────┴────────────┘
│                   │ ┌ GBPUSD, Pound Sterling vs US Dollar ───────┐
│                   │ │ ab Exchange            XCCY                │  ← live Specification
│                   │ │ ≡  Sector              Currency            │     preview pane
│                   │ │ 01 Digits              5                   │
│                   │ └────────────────────────────────────────────┘
├──────────────────────────────────────────────────────────────┤
│ [ Show Symbol ] [ Hide Symbol ] [ Create Custom Symbol ]  [ OK ]
└──────────────────────────────────────────────────────────────┘
```

**Table columns, verbatim and in order: `Symbol | Description | Expiration`.** Three.

**Organisation:** a tree on the left, rooted at a **folder node named `Broker`** (the broker's
own name in a real install), whose children are the broker's symbol groups, each with the yellow
`$` badge: `Forex`, `Metals`, `Collateral`, `Custom`. **`Custom` carries a distinct badge with a
small sparkle** — it is the container for user-created instruments. Verbatim: *"Here you can also
create a custom financial instrument."*

**Buttons, verbatim and in order: `Show Symbol` · `Hide Symbol` · `Create Custom Symbol` · `OK`.**
`OK` is right-aligned and focused (blue outline).

⚠ **The prose names the buttons differently**: *"A double click on a symbol name is used for
hiding or showing it in the Market Watch window. The same actions can be performed by buttons
**"Hide" and "Show"**."* The dialog says `Hide Symbol` and `Show Symbol`.

**Filter:** a search field with a magnifier icon and a history dropdown chevron, above the table.
Verbatim: *"To quickly find a symbol, use the filter at the top of the window. Type the first
letters of the symbol name or description in it."*

**`Show expired contracts`** is a checkbox at the top right, unchecked by default. Verbatim
sorting rule:

> *"All expired symbols are hidden to preserve a more compact display… A non-relevant symbol is
> the expired one, which is defined by the "Last trade" parameter. This date is specified in the
> "Expiration" column of the list of symbols. To view all symbols, click "Show expired contracts"."*
> *"For convenience, the list of symbols is automatically sorted: symbols without the expiration
> date are listed first / next go symbols with an expiration date starting with the nearest date /
> then follow expired symbols starting with the last expired one / other symbols sorted
> alphabetically"*

**The bottom pane is a live Specification preview** of the selected symbol — the same blue header
line, the same type glyphs, the same rows, in the same order as the standalone dialog. Verbatim:
*"At the bottom of the window, properties of the selected symbol are shown."*

### 8.3 The `Bars` and `Ticks` tabs

> *"To download data, open the symbol management dialog in the "Market Watch" context menu and
> switch to the Bars or Ticks tab. Select a symbol and a timeframe, and click **Request**. The
> platform requests all available data from the server… Click **Export** to save price data as a
> CSV file."*

Two buttons named: **`Request`** and **`Export`**. **Neither tab is screenshotted.**

> *"The import function is only available for custom financial instruments."*

Tick flags, verbatim: `2` bid changed · `4` ask changed · `8` last deal price changed ·
`16` volume changed · `32` tick from a buy trade · `64` tick from a sell trade;
*"If a tick has multiple flags, you will see the total value."*

---

## 9. The other two tabs, and Popup Prices

### 9.1 Trading tab — One Click Trading panels

A grid of panels, **two per row**, read off `market_watch_trading_x2.png` at 3.5×:

```
┌ EURUSD                                 05:00:28 ┐
│ [ SELL ] [▾] [   0.10   ] [▴] [ BUY ]           │   ← button strip
│ ┌──────────────┬──────────────┐                 │
│ │  1.13 59 ²   │  1.13 59 ²   │                 │   ← two big price blocks
│ └──────────────┴──────────────┘                 │
│   LOW    │  Spread: 0   │   HIGH                │
│ 1.13541  │ Swap: -1.00/-0.70 │ 1.13747         │
└─────────────────────────────────────────────────┘
```

- Header: symbol name bold left, **last quote time right**.
- Price rendering: **`<small prefix><BIG two digits><superscript last digit>`** —
  `1.13` small, `59` large, `2` superscript = `1.13592`. Verified on four panels
  (`213 25⁷` = 213.257, `0.80 00⁰`, `1.31 83³`).
- Footer, two lines: `LOW | Spread: N | HIGH` over `<low value> | Swap: <long>/<short> | <high value>`.
- Verbatim callouts: *"Current Bid price / Current Ask price / The lowest Bid price for the
  current day (Bid Low) / The highest Ask price for the current day (Ask High) / Current spread
  and swap for short and long positions. **If the price of the last executed deal is available
  for a symbol, it is displayed instead of spread and swap.**"*

⚠ **Correction to `02-toolbox-and-panels.md` §5e:** the two halves are **not** one colour.
`NZDCAD` renders its **SELL half blue and its BUY half red** in one panel. Each half takes the
tick colour of its own side's price. The `SELL`/`BUY` button above each half takes a lighter
tint of the same hue.

Conditions, verbatim: *"This trading mode is available under the following conditions: "One Click
Trading" option is enabled in the platform settings; The execution type of the selected
instrument is Instant, Market or Exchange. In other cases, a click on a button opens the order
creation window."* And: *"Be careful, once the "Sell" or "Buy" button is pressed, the
corresponding request… is immediately sent to the server **without any additional confirmation**."*

The symbol set is **not independent**: *"The set of symbols for quick trading is taken from the
list on the "Symbols" tab and can be adjusted using the "Symbols" command in the context menu."*

### 9.2 Ticks tab

> *"To view the tick chart of an instrument, select a symbol in the "Symbols" tab of the Market
> Watch and switch to the "Ticks" tab. The platform stores up to 2000 last ticks for each symbol."*

Rendered (`tick_chart_x2.png`): the symbol name top-left, a **blue step line (Bid, lower)** and a
**red step line (Ask, upper)**, a price scale down the right edge, a time axis along the bottom
whose first label is the full date (`2026.07.17`) and the rest times (`23:32`…), and **two
last-price tags** on the right edge — a red filled tag for the Ask (`218.531`) and a blue filled
tag for the Bid (`218.520`). No columns, no toolbar, no tabs of its own.

> *"The tick chart is cleared and then redrawn in case you delete and re-add a symbol in the
> Market Watch window."*

### 9.3 Popup Prices

- **Three names for one window.** Context menu: **`Popup Prices   F10`**. Its own title bar:
  **`Popup prices: 23:40:42`** — lowercase `p` in "prices", and the same live-time suffix as
  Market Watch. Hot Keys page: ***"F10 — Open "Quotes Window"."***
- Rendering: **black background, white column headers on a blue header band**, white gridlines,
  the same `Symbol | Bid | Ask` column set with the same tick colours. **Unchanged prices render
  white** — the proof that "grey" means "foreground", not grey (§3.2).
- Verbatim: *"This window allows displaying price information on screens of all sizes — its main
  feature is font scaling."* and *"The Popup Prices window features the **dame** information as
  is available in Market Watch: the same set of symbols and columns, with the same sorting."*
  (`dame` is MetaQuotes' live typo.)
- Its context menu is described but never screenshotted: *"Enable or disable the display of Popup
  Prices on top of other windows in the system and use full screen mode. Enable or disable any
  columns, hide the header and disable the display of milliseconds… In the properties window, you
  can customize colors and fonts, as well as the number of symbol columns."*

---

## 10. Mobile

**The mobile equivalent of Market Watch is a screen called `Quotes`.** Confirmed on both
platforms, in the bottom tab bar and as the help page title.

### 10.1 The two view modes

| | Android | iPhone |
|---|---|---|
| MetaQuotes' words for the modes | *"the **full** and **reduced** representation of price information"* | *"a form **adapted for mobile devices** (default mode) or as a **table used in the desktop platform version**"* |
| How to switch | *"open the context menu by tapping on any symbol"* | a mode button on the top panel |

**Neither platform calls them "simple" and "advanced".** Two different vocabularies for the same
pair of modes, in MetaQuotes' own two help pages.

### 10.2 Full / adapted mode — what a row shows

```
+151  0.14%                                   ← daily change in points, then %
EURUSD                                        ← symbol, bold
🕐 15:09:42  ⊢⊣ 0            1.08 07⁶   1.08 07⁶
                             L: 1.07740  H: 1.08100
```
- **Top line**: change in points (signed, grey) then change in percent (blue if +, red if −).
- **Middle line**: symbol name.
- **Bottom line**: last quote time, then a small **spread glyph `⊢⊣` followed by the spread in
  points**. A **clock glyph** precedes the time when the symbol is on delayed data.
- **Right block**: two large prices in the desktop's
  `<prefix><BIG>​<superscript>` format — **Bid on the left, Ask on the right** — with
  **`L: <low>` under the Bid and `H: <high>` under the Ask**.
- **A blue or red triangle in the row's top-left corner** marks an open position:
  *"If there are open positions for the symbol, a triangle on the right will show the total
  floating result of such positions: blue triangle means profit, red means loss."*
  (MetaQuotes says *"on the right"*; the screenshot draws it top-**left**.)

⚠ **The Android help lists the two prices in the wrong order** — *"The ask price / The bid
price"* — while its own screenshot and the whole iPhone page put **Bid first**. Arithmetically
settled: in every row the left price is the lower one.

### 10.3 Reduced mode

Symbol name, then the **two prices only** (Bid left, Ask right), tick-coloured blue/red/dark. No
time, no spread, no high/low, no change.

### 10.4 iPhone table mode — real columns

`ip/quotes_columns.png` shows the desktop-style table and its column picker:

```
Symbol | Bid | Ask | Spread | Day %
```

**Note `Day %`, not `Daily Change`.** The column picker is a full screen titled **`Columns`**,
split into a selected block (each with a red `⊖` remove button and a drag handle) and an
available block (each with a green `⊕` add button):

```
selected:   Bid · Ask · Spread · Day %
available:  Bid High · Bid Low · Ask High · Ask Low · Last · Last High · Last Low · Time
```

> *"In the table view, the list of symbols can be sorted by any column. To sort the list, tap on
> the relevant column name. The first tap sorts the column in ascending order, the second tab
> sorts in descending order, and the third tab resets to default sorting."*
> (`tab` for `tap`, twice, is MetaQuotes'.)

### 10.5 Bottom tab bars differ between the two platforms

| | Bottom tabs |
|---|---|
| **Android** (`quotes.png`, `quotes_delayed.png`) | `Quotes · Charts · Trade · History · Messages` |
| **iPhone** (`quotes.png`, `quotes_columns.png`) | `Quotes · Chart · Trade · History · Settings` |

Android says **`Charts`** plural and ends with **`Messages`** (badge-counted); iPhone says
**`Chart`** singular and ends with **`Settings`**. `04-mobile-app.md` and `09-toolbox.md` §9
recorded the iPhone set as *the* five tabs — that is only half true.

Top bar: Android `☰ Quotes` with `＋` (add) and `✎` (edit); iPhone `≣ Quotes ≣` with a search
field *"enter symbol for search"* below it.

### 10.6 How a symbol's specification is reached on mobile

> *"Symbol trading terms are shown in this window. You can go to this window using the
> **"Properties"** command in the context menu of the "Quotes" tab."*

The command is **`Properties`**, not "Specification". The screen (`and/symbol_specification.png`)
has a back arrow, the symbol name over its description, a globe/link button at the right, and a
single all-caps section header **`PROPERTIES`**, then:

```
Sector · Digits · Contract size · Spread · Stop levels · Margin currency · Profit currency ·
Calculation · Hedged margin · Trade · Execution · GTC mode · Fill policy · Expiration · Orders ·
Minimal volume · Maximal volume · Volume step · …
```

**Four labels differ from the desktop dialog:**

| Desktop | Android |
|---|---|
| `Stops level` | **`Stop levels`** |
| `Filling` | **`Fill policy`** |
| `Spread  floating` | **`Spread  Floating`** (capital F) |
| `Contract size  100 000 EUR` | **`Contract size  100000`** (no separator, no currency) |

And `Execution` renders **`Instant Execution`** on mobile where the desktop renders **`Market`**
/ `Instant`. Mobile adds one field the desktop list lacks — **`Subscription`** — and
**`3-days swap`** *"day of the week when a triple swap is charged"*, which the desktop replaces
with the five-row `Swap rates` block.

The mobile Details equivalent is a separate screen reached from the same menu
(`ip/symbol_statistics.png`), titled with the symbol (`Eu-9.17`) and an `✕` close:
```
Tick Size · Tick Value · Initial margin · Lower Limit · Upper Limit · Settlement Price ·
Bid · Ask · Last · Last High · Last Low · Price Change · Volume · Deals · Deals Volume ·
Turnover · Open Interest · …
```
**`Price Change` on iPhone vs `Daily Change` on desktop vs `Day %` in the iPhone table header** —
three strings for one quantity, all MetaQuotes'.

### 10.7 Mobile Depth of Market

Both mobile helps carry a **`Depth of Market`** page in the Quotes section. It is not researched
here. Flagged in "Could not verify" #10.

---

## 11. MetaQuotes' self-contradictions, collected

1. **Two different Market Watch context menus** are served by the same help page today — one
   with `Use System Colors` and no `Fundamental Data`, one with `Fundamental Data`,
   `Subscribe to Realtime Datafeed` and **no `Use System Colors`** — while the page's prose tells
   you to enable `Use system colors` in the context menu.
2. **`Depth Of Market` (Market Watch menu, capital O) vs `Depth of Market` (Trade tab menu,
   lowercase o)**, and **`Alt+B` vs `B`** for the same command.
3. **`Use System Colors` (menu) vs `Use system colors` (prose).**
4. **`Sets` (menu) vs `Symbol Sets — Save as` (prose) vs `Sets \ Save` (prose)** — three names on
   one page, two of them in adjacent paragraphs.
5. **`Popup Prices` (menu) vs `Popup prices:` (title bar) vs `"Quotes Window"` (Hot Keys, F10).**
6. **"the color is determined by the Bid price" (prose) vs Bid and Ask coloured independently
   (five rows across four screenshots).**
7. **"Gray — the price has not changed" (prose) vs `#000000` on white and `#FFFFFF` on black
   (measured).**
8. **`Type of orders` (help prose, and the Russian dialog) vs `GTC mode` (English dialog).**
9. **`Filling` (desktop dialog) vs `Fill policy` (mobile dialog and mobile help).**
10. **`Stops level` (desktop) vs `Stop levels` (Android).**
11. **`Daily Change` (desktop) vs `Price Change` (iPhone statistics) vs `Day %` (iPhone table).**
12. **`Hide`/`Show` (Symbols-dialog prose) vs `Hide Symbol`/`Show Symbol` (the buttons).**
13. **`B. High` / `A. Low` / `V. High` (Details prose) vs `Bid High` / `Ask Low` / `Volume High`
    (the Details tab).**
14. **"The Greeks, which include Delta, Theta, Gamma, Vega, `Po` and Omega"** — the field three
    lines below is `Rho`.
15. **Android lists the Quotes prices as "ask, bid"; iPhone lists them as "Bid, Ask".** Both
    screenshots render Bid first.
16. **Android's position triangle is documented *"on the right"* and drawn top-left.**
17. **Android bottom tabs end in `Messages` and say `Charts`; iPhone's end in `Settings` and say
    `Chart`.**
18. **Number formatting is inconsistent across one window**: `Daily Change` writes `-2.85%` with
    no space, the account summary strip writes `1 076.68 %` with one (`09` §4.2); `Turnover`
    uses space thousands separators, `Deals Volume` uses `K` suffixes, `Contract size` writes
    `100 000 EUR` on desktop and `100000` on Android.
19. **Live typos on the current pages**: *"The **Dept** of Market"*, *"No more than 5000 financial
    **instrument** can be added"*, *"the **dame** information"*, *"1.1 USD per **loat**"*,
    *"instead of the **the** session close price"*, *"the second **tab** sorts in descending
    order"*.
20. **`Market Watch` is an item inside the Market Watch context menu** (`Fundamental Data ▸ Market
    Watch`, meaning MarketWatch.com).

---

## Could not verify

1. **What drives the Symbols-tab gutter glyph and the `Time` cell colour.** Both are real and
   three-state, neither is documented, and `XAGUSD` vs `AUDCAD` in one screenshot rules out any
   simple Bid-or-Ask rule. Do not state a rule.
2. **The `Sort ▸` submenu's entries.** Described in prose (*"sorting by the highest growth and
   fall based on a daily symbol price change"*) with no strings and no screenshot.
3. **The `Columns ▸` submenu's entries.** MetaQuotes publishes neither a list nor an image;
   `market_watch_columns.png` is 404. The 46-item third-party list in §2.3 is not a MetaQuotes
   source. Which columns are on by default beyond the six observed is likewise unstated.
4. **The `Sets ▸ Remove ▸` submenu.** Only `Save as`, `Remove ▸`, `Add ▸` and three set names are
   visible; `Remove`'s contents are not.
5. **The Depth of Market's context menu.** The help says *"Most of these commands are also
   available in the context menu of the Market Depth and Time & Sales windows"* and names one
   item (`Export Ticks to CSV`, `Synchronize`) but publishes no menu.
6. **Whether `Alt+B`, `Ctrl+U` and `F10` are the real current shortcuts.** All three are read off
   context-menu screenshots; **none is on the Hot Keys page**, which for this window lists only
   `F9`, `Space/Tab`, `A`, `G` (and `Ctrl+M` globally). `F10` is on the Hot Keys page but under a
   different window name.
7. **The Symbols dialog's `Bars` and `Ticks` tabs.** Two button names (`Request`, `Export`) are
   given in prose; no screenshot, no columns, no layout.
8. **The `Commission` and `Spreads` blocks of the Specification dialog.** Described in prose with
   one ASCII example table; never screenshotted.
9. **Which margin-block operation rows exist beyond `Market buy` and `Market sell`.** The help
   says *"each type of trading operation"* and names none.
10. **Mobile Depth of Market.** Both mobile helps have a page for it; not read.
11. **How Market Watch is undocked, re-docked, resized or auto-hidden.** Same gap as the Toolbox.
12. **Whether a View-menu route to Market Watch exists, and its label.** Not documented.
13. **Whether MetaTrader ever renders Market Watch for a one-price instrument.** No published
    asset shows a row without both a Bid and an Ask, and the help describes no single-price mode.
    `Last` is documented only as an *additional* column.
14. **The `Options Board` window.** The menu item exists and is greyed for non-option symbols;
    its own help page is about options theory and its UI was not read here.
15. **The green clock glyph's exact meaning.** Observed on desktop and mobile for symbols on
    delayed data, and adjacent to `Subscribe to Realtime Datafeed` and the mobile `Subscription`
    field, but MetaQuotes never names or documents the glyph.
16. **Whether the Specification dialog's Sessions block always shows seven days.** One capture
    shows Sunday–Saturday, another ends at Friday; both windows are scrollable.
17. **The exact wording of the `Sets ▸ Save as` name prompt.** Not screenshotted.

---

## Sources

MetaQuotes MT5 help:
[Market Watch — the single page covering Symbols, Details, Trading, Ticks, Symbols dialog, Specification, Margin and Popup Prices](https://www.metatrader5.com/en/terminal/help/trading/market_watch) ·
[Depth of Market](https://www.metatrader5.com/en/terminal/help/trading/depth_of_market) ·
[Options Board](https://www.metatrader5.com/en/terminal/help/trading/options_board) ·
[Hot keys (Ctrl+M, and the four Market Watch keys)](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[User Interface](https://www.metatrader5.com/en/terminal/help/startworking/interface) ·
[Custom Instruments](https://www.metatrader5.com/en/terminal/help/trading_advanced/custom_instruments)

`trading/symbols` and `trading/instruments` are **404** — there is no standalone page for the
Symbols dialog.

MetaQuotes mobile help:
[Android — Quotes](https://www.metatrader5.com/en/mobile-trading/android/help/quotes) ·
[iPhone/iPad — Quotes](https://www.metatrader5.com/en/mobile-trading/iphone/help/quotes)

Screenshots read directly (desktop under `https://www.metatrader5.com/i/help/terminal/`):
`en/market_watch_x2.png` (642×682 — **the primary source: title bar, all six columns, the glyph
gutter, the add row, the counter and the tab strip**) ·
`en/market_watch.png` ·
`en/market_watch_fast_add_x2.png` (**the `Spre…` truncation and the inline add field with
autocomplete**) ·
`en/market_watch_industry_x2.png` (**context menu variant A, `Sets ▸`, `Add ▸` and the Energy
industry list**) ·
`en/market_watch_fundamental_x2.png` (**context menu variant B, `Fundamental Data ▸`, and the
delayed-data clock glyph on AMD**) ·
`en/market_watch_details_x2.png` (**all 30 Details rows**) ·
`en/market_watch_trading_x2.png` (**the four One Click Trading panels, and the NZDCAD
blue-SELL/red-BUY counter-example**) ·
`en/tick_chart_x2.png` (Ticks tab) ·
`en/popup_prices_x2.png` (**the black-background proof that "grey" means foreground**) ·
`en/symbols_x2.png` / `en/symbols.png` (**the Symbols dialog, its three tabs, three columns, tree
and four buttons**) ·
`en/contract_specification_x2.png` + `en/contract_specification.png` (**two independent renders
of the full Specification field list, agreeing row for row**) ·
`en/specification_margin_x2.png` (**the margin-rates block and the seven-day Sessions table**) ·
`en/dom_x2.png` (**exchange DoM: 9 toolbar buttons, the ladder, the `• • •` divider, sl/vol/tp,
Sell/Close/Buy**) ·
`en/pending_dom_example_x2.png` (**OTC DoM for GBPUSD: 5 toolbar buttons, the `BL 0.2` badge, an
enabled yellow `Close`**) ·
`en/market_example_dom_x2.png`, `en/time_and_sales_x2.png`, `en/dom_pending_place_x2.png` ·
`ru/market_watch.png` (**the 2015 build, and the only published instance of the `!` column**) ·
`ru/contract_specification.png` (**the Russian field list, with ISIN and Category, and
`Тип ордеров` where English writes `GTC mode`**) ·
`ru/symbols.png`, `ru/market_watch_details.png`, `ru/dom.png`

Mobile screenshots (`https://www.metatrader5.com/i/help/android/en/` and `/iphone/en/`):
`android/quotes.png` (**both Android modes side by side**) ·
`android/quotes_delayed.png` (**the clock glyph on delayed symbols**) ·
`android/symbol_specification.png` (**the `PROPERTIES` screen and its four relabelled fields**) ·
`iphone/quotes.png` (**default adapted mode, Bid left / Ask right**) ·
`iphone/quotes_columns.png` (**the table mode's `Symbol | Bid | Ask | Spread | Day %` and the
`Columns` picker**) ·
`iphone/symbol_statistics.png` (**the mobile Details equivalent, with `Price Change`**)

Third-party, explicitly not MetaQuotes, used for one claim only and labelled as such:
[myforex.com — "MT4/MT5: Manage columns in Market Watch"](https://myforex.com/en/mt5guide/columns-marketwatch.html)
(the 46-entry `Columns ▸` list in §2.3) ·
[metaquotes.net build 2530 release note](https://www.metaquotes.net/en/metatrader5/news/5232)
(Market Watch sorting was added in build 2530).

# MetaTrader 5 Toolbox & Docked Panels — Verified UI Specification

**Method note:** MetaQuotes' help pages render many UI strings only inside screenshots. So rather than rely on page prose (or on a summarising fetch, which paraphrased badly on first attempt and produced a *wrong* column list), I downloaded the raw HTML **and the official help screenshots at 2× resolution** and read them directly. Every column header, menu string and colour below marked "verified" was read off a current MetaQuotes screenshot (build ~2026, the `Copyright 2000-2026` pages) or off the help body text. Where I could not verify something, I say so.

**Primary sources (all MetaQuotes official):**
- Executing Trades (Trade tab, Exposure, History, Alerts): https://www.metatrader5.com/en/terminal/help/trading/performing_deals
- Market Watch: https://www.metatrader5.com/en/terminal/help/trading/market_watch
- Depth of Market: https://www.metatrader5.com/en/terminal/help/trading/depth_of_market
- User Interface: https://www.metatrader5.com/en/terminal/help/startworking/interface
- Mailbox: https://www.metatrader5.com/en/terminal/help/start_advanced/mail
- Platform Logs (Journal/Experts): https://www.metatrader5.com/en/terminal/help/start_advanced/journal
- Hot Keys: https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys
- Fundamental Analysis (News/Calendar): https://www.metatrader5.com/en/terminal/help/charts_analysis/fundamental
- Trading Report: https://www.metatrader5.com/en/terminal/help/trading/report and https://www.metatrader5.com/en/terminal/help/trading_advanced/history_report
- Screenshots under `https://www.metatrader5.com/i/help/terminal/en/<name>.png` (2× variant: `<name>_x2.png`) — named per item below.
- Mobile: https://www.metatrader5.com/en/mobile-trading/android/help/trade , `/history` , https://www.metatrader5.com/en/mobile-trading/iphone/help/trade ; images under `/i/help/android/en/` and `/i/help/iphone/en/`.

---

## 0. The actual Toolbox tab strip (correcting the premise)

**Verified** from `position_manage.png`, `bulk_positions.png`, `close_position.png`, `history.png`, `exposure_exchange.png`, `alerts.png`. The current build's Toolbox tabs, left to right:

> **Trade | Exposure | History | News | Mailbox | Calendar | Company | Alerts | Articles | Code Base | Experts | Journal**

Right-aligned on the same strip, as icon+label buttons (not tabs): **🔒 Market · ((•)) Signals · ☁ VPS · ⬤ Tester** (VPS appears greyed/disabled when no VPS is rented).

Two things to note against your brief:
- There is a **Company** tab you did not list. Per the User Interface page: *"A broker may choose to show a useful web resource here… This tab is hidden if the web page is disabled by the broker."* So Company is **conditional**.
- Tabs carry an **unread-count subscript** when applicable — e.g. `Mailbox₁₁`, `News₁₅` (verified in `exposure_exchange.png` and `fundamental_news.png`).
- Older builds (2015-era screenshots still on the site) had `Market` and `Signals` as ordinary tabs inline. Don't model from those.

`Ctrl+T` = *"Open/close the 'Toolbox' window."* `Ctrl+F9` = *"Open the 'Trade' tab in the 'Toolbox' window and switch the control focus to it."* (Hot Keys page.)

---

## 1. Trade tab

### 1a. Open-position columns — DEFAULT VISIBLE SET (verified, `position_manage.png`)

In order, left to right:

> **Symbol | Ticket | Time | Type | Volume | Price | S / L | T / P | Price | Profit**

Exact rendering details:
- Headers `S / L` and `T / P` are written **with spaces around the slash** (the help *body text* writes them `S/L` and `T/P` — the UI does not). 
- There are **two columns both headed `Price`** — the 6th is the open price, the 9th is the current market price.
- `Symbol` is left-aligned and carries the sort-direction triangle; everything from `Ticket` rightwards is **right-aligned**.
- `Profit` is the rightmost column.

### 1b. Full available column list (help body text, `performing_deals`)

The help enumerates more fields than are shown by default; the extra ones are enabled via the context menu's `Columns ▸`. Full documented list, in the order the help lists it:

> **Ticket, Symbol, ID, Time, Type, Volume, Price, S/L, T/P, Price, Value, Swap, Profit, Change, Magic**

- `ID` = position ID in an external trading system; *"The display of this parameter can be disabled depending on your broker's settings."*
- `Value` = market value of the position.
- `Change` = *"the change in the asset price as a percentage since the operation execution time."*
- `Magic` = Expert Advisor ID.
- **`Comment` is documented for pending orders, not for positions** — so your proposed list (`… Swap, Profit, Comment`) is wrong for the position table.

**Your proposed order is incorrect.** You had `Symbol, Ticket, …`; the help text lists `Ticket, Symbol, …` but the **actual default UI puts `Symbol` first, then `Ticket`** (verified in three separate screenshots). You also omitted `Value`, `Change`, `Magic`, `ID`, and included `Comment` and `Swap` in the visible set — `Swap` is a real column but is **not** in the default visible set in the current screenshots.

### 1c. Pending-order columns (help body text; rendering verified)

> **Symbol | Order | ID | Time | Type | Volume | Price | S/L | T/P | Price | Comment | State**

Note `Order` (not `Ticket`) is the ticket column name for pending orders, and the last column is `State`: *"in the last column, the current state of a pending order is displayed: 'Started', 'Placed', etc."*

### 1d. How a position row vs a pending-order row renders (verified, `position_manage.png`)

This is the structurally important bit and it is **not** two separate tables side by side:

```
Symbol   Ticket   Time                  Type       Volume     Price      S / L        T / P        Price      Profit
eurusd   328674   2026.06.22 14:49:50   buy        0.1        1.14590    1.16043 ×    1.16944 ×    1.16421    183.10 ×
eurusd   328681   2026.06.22 14:52:43   buy        0.05       1.14598    1.15441 ×    1.17442 ×    1.16421     91.15 ×
usdtry   328844   2026.07.29 21:30:41   buy        0.1       47.36027   46.24420 ×   49.24420 ×   48.24450    183.28 ×
usdtry   328845   2026.07.29 21:30:41   buy        0.1       47.36027   45.24420 ×   49.24420 ×   48.24450    183.28 ×
⊕ Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %      633.32
eurusd   328863   2026.08.28 07:05:35   buy limit  0.01 / 0   1.16000    1.15010 ×    1.17090 ×    1.16422    placed ×
```

- **Open positions sit ABOVE the account-summary line; pending orders sit BELOW it.** They share one column grid.
- Each row has a **small document/ticket glyph** in the leftmost gutter, before the Symbol text (blue-outlined for buy, red-outlined for sell — verified in `exposure_forex.png` / `close_position.png`).
- `Type` renders **lowercase**: `buy`, `sell`, `buy limit`.
- Pending-order `Volume` renders as **`requested / filled`**, e.g. `0.01 / 0`.
- The pending row's last cell shows the **State string (`placed`) in place of a Profit figure**, in grey.
- Symbol text is lowercase (`eurusd`) in these screenshots — that is **this broker's symbol naming**, not a UI convention. Do not treat lowercasing as a rule.

### 1e. Account summary line (verified)

Default (Retail Forex/Futures model), as one bold grey strip spanning the full width:

> `Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %`

…with the **total floating P/L right-aligned at the far right** of the same strip (`633.32`), under the Profit column.

Exact formatting rules verified:
- **Currency code appears only after Balance** (`3 370.75 USD`); the other figures are bare.
- Thousands separator is a **space** (`3 370.75`, `1 076.68`), decimal is a point.
- **Margin Level: value then a space then `%`** → `1 076.68 %`. (This differs from mobile — see §7/§4.)
- A **`⊕` / `⊖` expand-collapse glyph** sits at the left end of the strip; collapsed it shows the short set above, expanded it adds the remaining fields.
- `Free Margin` has a **capital M** on desktop.

The **full documented field set** (`performing_deals`), of which the strip shows a subset depending on account model and broker:
`Balance, Credit, Assets, Liabilities, Commission, Blocked, Equity, Margin, Free Margin, Margin Level, Total of deals`
- `Margin Level — percentage of the account equity to the margin volume (Equity / Margin * 100)`
- `Total of deals — total financial result of all open positions`

**The field set is NOT fixed.** Verified counter-example on an exchange-model account (`exposure_exchange.png`):
> `Balance: 99 995.00 USD  Liabilities: -25 181.40  Equity: 74 814.60  Free Margin: 74 814.60`
— no `Margin`, no `Margin Level`, but a `Liabilities` field. Design for a variable field list.

Critical state rule (help body): ***"The account state line is highlighted with the red color, if the account is in the Margin Call or Stop Out state."***

### 1f. The small close button on a row (verified)

- A small **`×`** at the **right edge of the Profit cell** on every position row = **close position**. On a pending-order row the same `×` at the right edge of the State cell = **delete order**.
- Additionally, a small **`×` appears immediately after the S/L value and after the T/P value** when those levels are set — these delete the respective stop level. When S/L or T/P is zero/unset the cell is blank and **no `×` is shown** (verified: `exposure_forex.png` top panel has empty S/L and T/P and no `×`).
- Help body confirms: *"The 'Profit' column of each open position has the button Close position/Delete order."*

### 1g. Trade tab row context menu (verified verbatim, `close_position.png` + `bulk_positions.png`)

```
⊞  New Order                F9
✓  Close Position
⚙  Modify or Delete
   ─────────────────────────
   Bulk Operations          ▸
   ─────────────────────────
▤  Depth of Market          B
∿  Open Chart               Space
   ─────────────────────────
   Trailing Stop            ▸
   Volumes                  ▸
   Profit                   ▸
   ─────────────────────────
   Deposit                     (greyed)
   Withdrawal                  (greyed)
   ─────────────────────────
   Report                   ▸
   Show on Charts           ▸
((•)) Register as Signal
   ─────────────────────────
   Show Milliseconds
✔  Auto Arrange             A
✔  Grid                     G
   ─────────────────────────
   Columns                  ▸
```

Note it is **"Modify or Delete"** in the menu (the help prose writes *"Modify or delete"*). `Auto Arrange` and `Grid` are checked by default.

**`Bulk Operations ▸` submenu (verified verbatim):**
```
Close All Positions
Close Profitable Positions
Close Losing Positions
Close Buy Positions
Close EURUSD Positions
Close Buy EURUSD Positions
Close by EURUSD
─────────────────────────
Delete All Orders
Delete Limit Orders
Delete Stop Orders
Delete Stop Limit Orders
```
The symbol-specific and direction-specific entries are **generated from the selected row** (so `EURUSD`/`Buy` are substituted). The `Delete …Orders` group is greyed when no pending orders exist. Help body: *"The list of available commands is formed automatically, depending on the selected operation and on your account type"* and *"These commands are only available if One Click Trading is enabled in platform settings."*

Chart-side position context menu (different, smaller): `Modify`, `Delete`, `Trailing Stop ▸`.

---

## 2. Exposure tab

**Verified** (`exposure_forex.png`, `exposure_exchange.png`). Columns, in order:

> **Assets | Volume | Rate | ⟨deposit-currency code⟩ | Graph | ⟨legend swatch⟩**  …then a separate right-hand panel titled **Long Positions**

- The 4th header is **the deposit currency code itself** (literally `USD` in both screenshots), **not** a generic label like "Value". If the account were EUR-denominated this header would read `EUR`.
- `Assets` column: each row has a **yellow `$` badge icon** then the currency/instrument code (`JPY`, `USD`, `EURUSD`, `GBPUSD`).
- `Volume` uses **SI suffixes**: `-5.7007M`, `60.288K`, `99.995K`.
- `Graph` column: a **horizontal bar chart**, bars drawn from a centre/zero baseline. Per help body: ***"long positions are displayed with blue bars and short positions are displayed with red ones."*** Verified — JPY (−357.44) renders a red bar, USD (+602.88) a blue/indigo gradient bar.
- A narrow **colour-swatch column** sits right of Graph, keying each row to the pie chart (red square, green square, blue square).
- Right-hand panel: a **filled circle / pie diagram** with wedge labels (`USD`, `EURUSD`) and the title **`Long Positions`**. Help: ***"To switch between the information on short and long positions click on the diagram title."*** So the title is a toggle and flips to the short-positions view.

Field meanings (help body, numbered callouts):
- *"The name of the currency or financial instrument."*
- *"The volume (in units) of a trader's position for the currency or financial instrument including leverage."*
- *"Instrument or currency exchange rates in the deposit currency."*
- *"The amount of deposit currency (excluding leverage) actually spent to buy/sell the currency or trading instrument."*
- *"The displayed account assets for the deposit currency take into account the free margin."*

**Exposure has its own summary strip**, distinct from the Trade tab's:
- Forex/futures model: `Balance: 3 791.48 USD  Equity: 3 960.32  Margin: 3 716.25  Free Margin: 244.07  Margin Level: 106.57 %`
- Exchange model: `Balance: 99 995.00 USD  Equity: 74 814.80  Liabilities: -25 181.40  Liquidation value: 99 996.20`
  (help: *"you can see the liquidation value here — amount of funds on the account and the price (result) of closing all current positions at the market price"*).
- The strip's left glyph here is the **yellow `$` badge**, not the `⊕` used on the Trade tab.

Help also notes: *"The platform adapts the display of assets depending on the risk management system applied to a trading account: Retail Forex, Futures or Exchange model."*

---

## 3. History tab

### 3a. View modes — there are FOUR, not three (verified, `history.png` context menu)

> **Positions · Deals · Orders · Orders & Deals**

Default selected is **`Deals`** (checkmark in the screenshot). Your brief said "Positions / Orders / Deals" — you're missing **`Orders & Deals`**, which the help describes as *"A tree view of all trading operations showing how the trade requests were processed."*

### 3b. Deals-mode columns — DEFAULT VISIBLE SET (verified, `history.png`)

> **Time | Symbol | Deal | Type | Direction | Volume | Price | S / L | T / P | Commission | Profit | Change**

Again `S / L` and `T / P` with spaced slashes. `Time` carries the sort triangle and is leftmost.

**Full documented Deals field list** (help body, in order):
> `Time, Deal, ID, Order, Symbol, Type, Direction, Volume, Price, Value, Cost, S/L, T/P, Commission, Fee, Profit, Change, Magic`

- `Cost` = *"the cost of a deal execution relative to the current mid-point price of the symbol (mid-point spread cost)… The availability of the parameter depends on the server."*
- `Fee` = *"separate type of fees charged by the broker per deals."*
- `Direction` = `"in"`, `"out"` or `"in/out"`.
- `Type` = `"Buy"` / `"Sell"`, or `Canceled buy` / `Canceled sell`.

### 3c. Positions / Orders mode columns

**I could not verify these from a screenshot** — MetaQuotes only publishes the Deals-mode screenshot. The help describes Positions-mode content in prose, not as a header list:
> *"Position opening and closing time determined by the first and last trade respectively / Position volume. If part of the position was closed, the record contains the closed volume and the source volume / The weighted average position opening price and its closing price / The total financial result of deals related to the position / Position Stop Loss and Take Profit…"*

and Orders mode as *"A list of orders containing all trade requests sent to a broker."* **I could not verify exact Positions-mode or Orders-mode header strings or their order for the desktop terminal.** (Mobile equivalents are documented — see §7.)

### 3d. Period selector strings — YOUR LIST IS THE MOBILE LIST, NOT THE DESKTOP LIST

**Desktop (verified verbatim, `history.png` context menu):**
```
All History
Last 3 Months
Last Month
⚙ Custom Period
```
Four entries only. Title Case. **There is no "Today", no "Last 3 days", no "Last week"** on desktop, and `All History` (which your list omits entirely) is present. `Custom Period` has a gear icon.

**Mobile (verified verbatim, `/i/help/android/en/history_period.png`):**
```
📅 Today            2017.08.18
📅 Last week        2017.08.11 - 2017.08.18
📅 Last month       2017.07.19 - 2017.08.18
③ Last 3 months     2017.05.20 - 2017.08.18
👤 Custom period    2015.08.18 - 2017.08.18   ✔
```
Sentence case, each with a resolved date-range subtitle, a tick on the active one. **Still no "Last 3 days"** and no "All History".

So: your six strings `"Today", "Last 3 days", "Last week", "Last month", "Last 3 months", "Custom period"` match **neither** surface exactly. Closest is mobile, minus `"Last 3 days"`. I could not find **"Last 3 days"** anywhere in MT5 desktop or mobile documentation — I believe it is an MT4 or third-party artefact. The Android help *prose* additionally says *tap "Select period"* for the custom range, which conflicts with the screenshot's `Custom period`; that's version drift in MetaQuotes' own docs.

### 3e. Summary row (verified, `history.png`)

> `⊕ Profit: 591.31  Credit: 0.00  Deposit: 3 000.00  Withdrawal: -250.00  Balance: 3 341.31`

…with **two right-aligned column totals** on the same strip: `0.00` (under Commission) and `626.68` (under Profit).

Your proposed set `(Profit, Credit, Deposit, Withdrawal, Balance)` is **correct and in the right order**. Help body confirms: *"Profit — profit or loss relative to the initial deposit / Credit — amount credited by the brokerage company / Deposit — deposit of the account (the sum of balance type operations with a positive value) / Withdrawal — amount withdrawn from the account (the sum of balance type operations with a negative value)"* and ***"The current account balance is displayed at the end of the line."***

### 3f. History right-click menu (verified verbatim, `history.png`)

```
⊞  New Order                F9
   ─────────────────────────
   Positions
✔  Deals
   Orders
   Orders & Deals
   ─────────────────────────
   Symbols                  ▸
   Volumes                  ▸
   ─────────────────────────
   All History
   Last 3 Months
   Last Month
⚙  Custom Period
   ─────────────────────────
   Report                   ▸
   Show on Charts           ▸
((•)) Register as Signal
   ─────────────────────────
   Show Milliseconds
✔  Auto Arrange             A
✔  Grid                     G
   ─────────────────────────
   Columns                  ▸
```

### 3g. `Report ▸` export formats

**Partially verified.** MetaQuotes' own help confirms only the first item: *"click 'Report \ Overview' in the context menu of the trading history section"* (Trading Report page), and *"To get a report, select 'Report' in the context menu of the History tab. HTML reports are generated from a template ReportHistory.htm, located in the /Templates folder of the platform"* (history_report page).

The full submenu, from **third-party broker/guide sources, not MetaQuotes**:
```
Overview
HTML (Internet Explorer)
Open XML (MS Office Excel 2007)
```
Sources: myforex.com/en/mt5guide/save-print-report.html (gives `Overview`, `Open XML`, `HTML`); bybit.com help centre and discovery-forex.com give the parenthesised long forms `HTML (Internet Explorer)` and `Open XML (MS Office Excel 2007)`. **I could not find a MetaQuotes page or screenshot carrying the parenthesised strings verbatim, so treat the exact parentheticals as medium-confidence.** Separately, the *visual* Trading Report window (reached via `Report ▸ Overview`) has its own **"Save report as HTML or PDF"** control — that's a different thing from the history export, and it's the only place PDF appears. (Trading Report page, which repeats "Save report as HTML or PDF." on each of its five report tabs.)

Do **not** carry MT4's `Save as Report` / `Save as Detailed Report` across; those are MT4-only.

---

## 4. News, Mailbox, Alerts, Articles, Journal, Experts, Calendar

### News
- Help: *"News items appear on the News tab of Toolbox window. To read the news, double click on its title."*
- **Partially verified columns.** The published screenshot (`fundamental_news.png`) shows a leftmost header **`Subject`**, a category/provider column showing values like `MQL5 News`, and a time column (`2015.11.04 15:08`). The Hot Keys page independently confirms a category column exists: ***"R key — Show/hide the column of news categories."***
- So: **`Subject | Category | Time`**, with `Category` toggleable via **R**. In that screenshot there appeared to be a *fourth* narrow column (values like `3.27 13:56`); **I could not determine what it is or its header** — the chart window overlaps the header row. Flagging rather than inventing.
- Rows: small globe/parcel icon in the gutter; **unread items render in bold**, read items in normal weight.
- Context menu includes a news-categories submenu with a **`Customize`** entry: *"Open the context menu in the news tab. Click 'Customize' in the submenu of news categories to open their setup window."*
- Language configured under `Tools → Options`, field **"News Language"**, with an **"Edit"** button and an **"Enable news"** checkbox.

### Mailbox (verified, `mail.png`)
Columns, in order:
> **Subject | From | To | Time**

Help's callouts confirm the semantics: *"Email subject / Email sender's name / Email recipient's name / Email sending or receiving time."*

Row icons (gutter): unread envelope, read envelope, outgoing marker, and a **thread marker** — *"When the function of response to an email is used, messages are joint into threads… Email threads are marked with icon. To expand a thread, click on this icon."*

**Mailbox context menu (verified verbatim):**
```
➕  Create...        Insert
🔍  View...          Enter
❌  Delete           Delete
⊞   Expand           Space
    ─────────────────────
✔   Auto Arrange     A
✔   Grid             G
```
Note the **ellipses** on `Create...` and `View...`.

Email reader toolbar (help body): `Reply`, `Save`, `Print`, `Print Preview`, `Attachment`. Compose window fields: `To`, `Subject`, `Attachments`, plus a three-tab body editor: **`Edit` | `View` | `Source`**. Attachment limits: 8 MB per file, 16 MB total, max 5 files.

### Alerts (verified, `alerts.png`)

**Columns, in order:**
> **Symbol | Condition | Counter | Limit | Timeout | Expiration | Event**

Example rows:
```
🔔 EURUSD   Bid < 1.15604    0    10    10 sec            alert
🔔 GBPUSD   Bid < 0.36450    0    10    10 sec            BOE
⛔ USDCHF   Ask > 13.25560   0    10    10 sec            Email Notification
```
Gutter icon is a **yellow bell for enabled** alerts and a **red stop/disabled glyph for disabled** ones.

**Alerts context menu (verified verbatim):**
```
➕  Create        Insert
⚙   Modify        Enter
❌  Delete        Delete
✓   Enable        Space
    ──────────────────
✔   Auto Arrange  A
✔   Grid          G
```
(No ellipses here, unlike Mailbox.)

**The dialog is titled `Alert Editor`, NOT "Create Alert".** Verified layout (the help HTML even carries pixel callout coordinates confirming the grid):

```
┌ Alert Editor ─────────────────────────────────── ? ✕ ┐
│  🔔   To add a new or modify the existing alert       │
│       please define all conditions and select the     │
│       necessary action.                               │
│                                                       │
│         ☑ Enable                                      │
│                                                       │
│      Action: [Mail        ▾]   Expiration: [      ▾]  │
│      Symbol: [USDCHF      ▾]    Condition: [Ask > ▾]  │
│                                       Value: [13.25560]│
│      Source: [Email Notification            ]  [ ... ] │
│     Timeout: [10 sec      ▾]  Maximum iterations:[10▾] │
│                                                       │
│            [  OK  ]  [  Test  ]  [ Cancel ]           │
└───────────────────────────────────────────────────────┘
```
Field labels verified verbatim: **`Enable`, `Action:`, `Expiration:`, `Symbol:`, `Condition:`, `Value:`, `Source:`, `Timeout:`, `Maximum iterations:`**. Buttons: **`OK`, `Test`, `Cancel`** in that order. `Source` has a **`...` browse button** to its right. `Expiration` is a date control with a clear/checkbox affordance.

**Conflict you should know about:** your brief lists the field as "Action" with option strings — the help *prose* names the Action options **`Sound`, `File`, `Email`, `Notification`**, but the **screenshot's Action dropdown shows `Mail`**. MetaQuotes' own text and UI disagree. I'd trust the screenshot (`Mail`) for the current build and treat `Email` as stale prose.

**`Condition` options (help body, verbatim, in order):**
```
Bid <    Bid >    Ask <    Ask >    Last <    Last >    Volume <    Volume >    Time =
```
*"Time = — an alert triggers at the specified time. Specify the local computer time in the format 'HH:MM', for example 15:00."*

**`Source` content depends on Action:** a `*.wav`/`*.mp3`/`*.wma` file; an `*.exe`/`*.vbs`/`*.bat` file; an email template; or push-notification text (**max 255 characters**).
**`Timeout`** = *"Time between alert repetitions."* **`Maximum iterations`** = *"Maximum number of alert repetitions."*
**`Expiration`** = *"Alert lifetime. An alert can be automatically deleted at the specified time. The local computer time should be indicated here."*

Alerts render on charts as **red arrows on the right side of the chart**, draggable to re-price. Alerts created from a chart auto-expire on a timeframe-derived schedule (M1→1 hour, M5→5 hours, H1→1 day, D1→24 days, W1→2 weeks, MN1→2 months).

### Calendar (verified, `fundamental_calendar.png`)
Columns, in order:
> **Time | Curr… | Event | Pri… | Period | Actual | Forecast | Previous**

(`Curr…` and `Pri…` are the truncated renderings of **Currency** and **Priority** at default column width.)
- A **country flag icon** sits in the gutter left of the Time value.
- **Date group separator rows** render as **red bold text**, e.g. `Wednesday, 11 November`, spanning the table.
- `Priority` renders as a **signal-fan glyph** (three arcs = high, a dot = low).
- Values carry units/percent inline: `3.4%`, `101.7`, `798.2B`, `1,050.0B`.
- **Colour rule (help body, verbatim):** ***"If this value is less than the predicted one, the indicator is highlighted in red. If the current value is larger, the indicator is shown in blue."***
- Default period: *"By default, the calendar displays current week events, including past and upcoming events. Use the context menu to switch to another period. You can access events for the previous, current and next week, as well as appropriate months."* (I could not verify the exact period menu strings.)
- Filters via context menu: **by priority, by currency, by country**. Also `Add All Events` to plot on charts.
- Double-click an event name → detailed description / history as graph or table.

### Journal (verified, `journal.png` + help body)
Columns, in order:
> **Time | Source | Message**

Help body verbatim: *"Time — the date and time of the event. Specified according to the time zone on the user's computer. / Source — event type: Network, Alert, HistoryBase, Experts, the name of a separate Expert Advisor or indicator, etc.; / Message — description of the event."*
Gutter icons: **informational message / warning / error message** (three distinct icons).

**Journal context menu (help body, verbatim list):** `Open`, `Copy`, `Send`, `Alerts` *(Experts journal only)*, `Viewer`, `Clear`, `Auto Scroll`, `Auto Arrange`, `Grid`.
Log files: `Logs` directory (platform) and `MQL5\Logs` (experts), named `YYYYMMDD.LOG`.
The `Viewer` opens a **Log Viewer** with a search bar and a filter of entries: **`Full`, `No connection`, `Errors only`**, a time range, and a **`Request`** button.
Find dialog fields: `Find`, `Match Whole Word Only`, `Match Case`, `Direction up/down`, `Find Next` (F3), `Cancel`.

### Experts
Help body: *"Experts Journal is displayed on the Experts tab of the Toolbox window. It contains information about the running indicators and Expert Advisor, including opening/closing of positions, modification of orders, Expert Advisor alerts and comments, etc."* The same context-menu list applies, plus the `Alerts` item which is **Experts-only**.
**I could not verify the Experts tab's exact column headers from a screenshot.** They are *most likely* identical to Journal (`Time | Source | Message`) since MetaQuotes documents them as one logging subsystem, but I did not see it rendered — flagging rather than asserting.

The EA alert popup table shows: *"Date and time; Name of the MQL5 application, chart symbol and timeframe; Alert message."*

### Articles and Code Base
**Verified only that these tabs exist** (present in every current Toolbox screenshot). **I could not verify their column headers or row rendering** — MetaQuotes publishes no screenshot of either tab in the help, and the Articles tab isn't described in the help prose at all. The only concrete datum: Hot Keys page says ***"D — Download the selected application at the Code Base tab."***

### Company
Not a table. Help body: *"A broker may choose to show a useful web resource here, for example a support website. Any link added here opens in a separate web browser window. This tab is hidden if the web page is disabled by the broker."*

### Toolbox-wide hotkeys (Hot Keys page, verbatim)
| Key | Action |
|---|---|
| `F9` | Call the "New Order" window. |
| `Enter` | View a selected news, e-mail, application or modify a selected alert - depending on the tab selected. |
| `Insert` | Create a new e-mail or alert - depending on the tab selected. |
| `Delete` | Delete an e-mail or alert - depending on the tab selected. |
| `Space` | Unwrap a branch of mails or enable/disable an alert - depending on the tab selected. |
| `C` | Copy the selected journal line of the platform or Expert Advisors to the clipboard. |
| `D` | Download the selected application at the Code Base tab. |
| `R key` | Show/hide the column of news categories. |
| `A` | Enable/disable auto sizing of columns. |
| `G` | Show/hide grid. |

---

## 5. Navigator and Market Watch

### 5a. Navigator (verified, `bulk_positions.png`)
Docked **left, directly below Market Watch**. Title bar reads `Navigator` with an `✕`. Tree, with `>` disclosure chevrons:
```
🔼 Terminal
   > 👥 Accounts
   > 📈 Indicators
   > 🤖 Expert Advisors
   > 📜 Scripts
     ⚙ Services
   > 🔒 Market
   > ((•)) Signals
     💳 Payments
```
Tabs along the **bottom** edge of the Navigator: **`Common` | `Favorites` | `Chats`** (`Common` active by default).
Note: the root node label is **`Terminal`** in the current build; a 2015-era screenshot shows `Client Terminal` and another shows `MetaTrader 5` — don't model from those. `Services`, `Market`, `Signals`, `Payments` and the `Chats` tab are newer additions.
Help body: *"The Navigator allows switching between accounts and provides functions for running trading robots and indicators. It contains a list of applications purchased from the Market and downloaded from the Code Base. From the navigator, users can rent a virtual platform…"*

### 5b. Market Watch — Symbols tab (verified, `market_watch.png`)
Title bar: **`Market Watch: 16:56:57`** — i.e. the panel title **embeds the live server time**. `✕` close button at right.

Columns, in order:
> **Symbol | Bid | Ask | Spread | Time | Daily Change**

- Gutter glyph per row: **green ↗ (rising), red ↘ (falling), grey • (unchanged)**.
- Bottom of list: a **`＋ click to add...`** row, and a right-aligned counter **`16 / 134`** (shown / total available).
- Tabs along the **bottom** edge: **`Symbols` | `Details` | `Trading` | `Ticks`**. When the panel is too narrow, **`◀ ▶` scroll arrows** appear at the right of the tab strip (verified in `bulk_positions.png`).
- Help body on extra columns: *"you can show the 'Source' field — the provider of the financial instrument liquidity"*; `High`/`Low`/`Last` columns behave per the symbol's chart mode; *"If Market Watch contains at least one symbol whose chart is drawn based on Last prices, the Last column is automatically enabled in addition to High/Low."*
- Limit: *"No more than 5000 financial instrument can be added to 'Market Watch'."*

**Market Watch colour rule (help body, verbatim):**
> *"Prices in the 'Market Watch' window have different colors: Blue — the current price is higher than the previous one; Red — the current price is lower than the previous one; Gray — the price has not changed for the last 15 seconds. If the depth of market and the Last trade price is available for a symbol, the color is determined by the Last price. Otherwise, the color is determined by the Bid price."*

Brokers can also set per-symbol background colouring server-side; **`Use System Colors`** in the context menu disables it.

### 5c. Market Watch context menu (verified verbatim, `market_watch_industry.png`)
```
⊞   New Order
∿   Chart Window
∿   Tick Chart
▤   Depth Of Market        Alt+B
✕   Options Board              (greyed)
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
Note **`Depth Of Market`** with a capital **O** here (the Trade-tab menu writes `Depth of Market`), and the shortcut is **`Alt+B`** here vs plain **`B`** in the Trade tab menu. `Auto Arrange` is **unchecked** by default in Market Watch but **checked** in the Toolbox tabs.

**`Sets ▸` submenu:** `Save as`, `Remove ▸`, `Add ▸`, then saved set names listed below a separator (`forex.all`, `forex.crosses`, `forex.major`). `Add ▸` cascades into sector/industry categories: `Basic Materials`, `Communication Services`, `Consumer Cyclical`, `Consumer Defensive`, `Energy`, `Financial`, `Healthcare`, `Industrials`, `Real Estate`, `Technology`, `Utilities`, `Currency`, `Crypto Currency`, `Index`, `Commodities`, each cascading again (e.g. Energy → `All`, `Oil & Gas Drilling`, `Oil & Gas E&P`, `Oil & Gas Equipment & Services`, `Oil & Gas Integrated`, `Oil & Gas Midstream`, `Oil & Gas Refining & Marketing`, `Thermal Coal`, `Uranium`).

### 5d. Market Watch — Details tab (verified, `market_watch_details.png`)
Not a grid — a **two-column key/value list**, with a blue header line giving symbol + description (`RIU6, Futures Contract RTS-9.26`), alternating row shading, a direction glyph per row, and values coloured by the same blue/red/grey tick rule. Rows observed in order:
`Tick Size, Tick Value, Face Value, Initial margin, Maintenance margin, Lower Limit, Upper Limit, Bid, Bid High, Bid Low, Ask, Ask High, Ask Low, Last, Last High, Last Low, Daily Change, Volume, Volume High, Volume Low, Deals, Deals Volume, Turnover, Open Interest, Buy Orders, Buy Volume, Sell Orders, Sell Volume, Open Price, Close Price`

The help body's full documented statistic list adds: `B. High, B. Low, A. High, A. Low, L. High, L. Low, V. High, V. Low, Average Weighted Price, Settlement Price, Delta, Theta, Gamma, Vega, Rho, Omega, Sensitivity`. Help: *"The number of statistical values depends on the brokerage company."* — i.e. the abbreviated forms (`B. High`) and full forms (`Bid High`) both appear in MetaQuotes material; the **screenshot shows the full forms**.

### 5e. Market Watch — Trading tab (verified, `market_watch_trading.png`)
A **grid of one-click trading panels, 2 per row**. Each panel:
- Header: symbol name (bold, left) + last-quote time (right)
- Button row: **`SELL`** | `▾` | volume field (`0.10`) | `▴` | **`BUY`**
- Large price block: two big price readouts with the **last 1–2 digits rendered as superscript** (`1.13 59²`)
- Footer row: `LOW` | `Spread: 0` | `HIGH`, with `Swap: -1.00/-0.70` under the Spread cell and the low/high values under LOW/HIGH.
- **The panel colouring is NOT fixed buy=blue/sell=red** — the whole SELL/BUY block takes **blue when the price ticked up and red when it ticked down**, so both buttons share one colour per panel. Help body verbatim: *"Depending on the quotes, the trade operation execution and price field may have different colors: Blue — the current price is higher than the previous one; Red — the current price is lower than the previous one; Gray — the price has not changed for the last 15 seconds."* Verified: EURUSD panel all-red, GBPJPY panel all-blue.

### 5f. Market Watch — Ticks tab
*"To view the tick chart of an instrument, select a symbol in the 'Symbols' tab of the Market Watch and switch to the 'Ticks' tab. The platform stores up to 2000 last ticks for each symbol."*

### 5g. Depth of Market (verified, `dom.png`)
Window title: **`LKM6, Futures contract LKOH-6.26`** (symbol + description). Layout, left→right:
1. **Tick chart pane** (left ~half): blue Buy line / red Sell line, filled circles for deals, with a **cumulative volume bar at top (`2 073`) and bottom (`2 545`)**, and a volume histogram strip beneath.
2. **Ladder** (right): three columns — **`Volume` | `Price` | `Trade`**
   - **Ask side on top**, rows with a **pink/red tinted Price cell**; volume bars shaded pink, growing leftward from the Price column.
   - **Bid side below**, rows with a **blue tinted Price cell**; volume bars shaded blue.
   - The two halves are separated by a **`• • •` spread divider row**.
   - The `Trade` column carries **two small buttons per row: `˅` (left) and `˄` (right)** — these place the pending orders. Help body: *"To place a Buy Limit order, click in the Bid price area. To place a Buy Stop order, click in the Ask price area. To place a Sell Limit order, click in the Ask price area. To place a Sell Stop order, click in the Bid price area."*
   - Live orders/levels render **inside the `Trade` column** as text badges: `BL 0.1` (Buy Limit 0.1 lots), `TP`, `SL`. Drag a badge to another price row to modify instantly. To delete: *"hover the mouse cursor over the button… and click Shift. The button will change its view… Click the button to delete."*
3. **Bottom control strip:** `▾ sl [5] ▴` | `▾ vol [3] ▴` | `▾ tp [10] ▴`
4. **Button row:** **`Sell`** (red) | **`Close`** (grey, disabled when flat) | **`Buy`** (blue)

**DOM toolbar** (10 buttons, help body, in order): show/hide the tick chart · show/hide Time & Sales · bind the Market Depth to an active chart · switch to the advanced mode · show the spread · show/hide the Bid and Ask price charts · show/hide transactions (circles) · zoom in · zoom out. (The help renders these as icons with no text labels; I verified the icon row exists and its order, but **there are no visible text strings to quote**.)

**Time & Sales colours (help body, verbatim):** *"blue is used for Buy trades, pink for Sell trades, green means undefined direction."* Tick-chart circles: *"Red circles show Sell transactions. Blue circles show Buy transactions. Green circles appear when the direction of the transaction is undefined."* Export via **`Export Ticks to CSV`** in the context menu; CSV header: `Time,Bid,Ask,Last,Volume,Type`.

### 5h. Symbol Specification dialog (verified, `contract_specification.png`)

**The dialog is titled just `Specification`** (with a yellow `$` badge icon), not "Symbol Specification". Layout: a blue header line with symbol + description (`EURUSD, Euro vs US Dollar`), then a two-column list with a **type glyph per row** (`ab` = string, `01` = integer, `½` = fraction, `≡` = enum, `📅` = day), label left, value **right-aligned**. Single **`Close`** button at the bottom. Scrollbar on the right.

Field order **as rendered**:
```
Exchange            XCCY
Sector              Currency
Digits              5
Contract size       100 000 EUR
Spread              floating
Stops level         0
Margin currency     EUR
Profit currency     USD
Calculation         Forex
Hedged margin       100000
Chart mode          By bid price
Trade               Full access
Execution           Market
GTC mode            Good till cancelled
Filling             Fill or Kill
Expiration          All
Orders              All
Minimal volume      0.01
Maximal volume      500
Volume step         0.01
Swap type           In points
Swap long           -0.7
Swap short          -1
── Swap rates ──
Monday 1 · Tuesday 1 · Wednesday 3 · Thursday 1 · Friday 1
── Sessions ──          Quotes          Trade
Sunday                  (blank)         (blank)
Monday … Friday         00:00-24:00     00:00-24:00
```
Note `GTC mode` is the rendered label for what the help prose calls **"Type of orders"** — another prose/UI mismatch.

**Full documented field list** (help body — superset; which fields appear depends on instrument type and broker):
`Symbol name and description, ISIN, Spread, Digits, Stops level, Contract size, Margin currency, Profit currency, Calculation, Chart mode, Tick size, Tick value, Trade, Execution, Type of orders, Filling, Expiration, Orders, Minimal volume, Maximal volume, Volume step, Volume limit, Swap type, Swap long, Swap short, Swap rates, First trade, Last trade, Face value, Accrued interest, Category, Exchange, CFI, Sector, Industry, Country, Option type, Underlying, Strike price`, plus a **Commission** block, a **Sessions** block, a **Spreads** block, and a **Margin** block (`Initial margin`, `Maintenance margin`, `Hedged margin`, with `Initial` / `Maintenance` rate columns and `Notional value` / `Floating: ****` calculation modes).

Enumerated values worth having verbatim:
- `Calculation`: `Forex, Forex No Leverage, Futures, Exchange Futures, Exchange Stocks, FORTS Futures, Collateral`
- `Trade`: `full access, long only, short only, close only` (+ trading can be fully prohibited)
- `Execution`: `Instant, Request, Market, Exchange`
- `Type of orders`: `Good till today including SL/TP`, `Good till canceled`, `Good till today excluding SL/TP`
- `Filling`: `Fill or Kill, Immediate or Cancel, Book or Cancel, Return`
- `Expiration`: `Good till Canceled, Intraday, Specified time, Date`
- `Swap type`: `In points`, `In the base currency`, `In the margin currency`, `In the deposit currency`, `As a percentage of current price`, `As a percentage of the open price`, `In points, re-open at Close price`, `In points, re-open at the Bid price`

---

## 6. Layout and chrome

### Verified from the full-window screenshots (`position_manage.png`, `bulk_positions.png`, `close_position.png`)

Default arrangement, confirmed — **your description is correct**:
```
┌ title: "700000106 - Broker - Hedge - [EURUSD,Daily]" ──────────────┐
│ Menu: File  View  Insert  Charts  Tools  Window  Help     ⚲ ─ ❐ ✕ │
│ Toolbars: Standard / Line Studies / Periodicity (one row)          │
├──────────────┬─────────────────────────────────────────────────────┤
│ Market Watch │                                                     │
│  (top-left)  │                    Chart (centre)                   │
│ tabs: Symbols│                                                     │
│ Details…     │                                                     │
├──────────────┤                                                     │
│ Navigator    │                                                     │
│ (below MW)   │                                                     │
│ tabs: Common │                                                     │
│ Favorites    ├─────────────────────────────────────────────────────┤
│ Chats        │ Chart switch bar: GBPUSD,Daily | USDCHF,Daily | …   │
├──────────────┴─────────────────────────────────────────────────────┤
│ ✕ │ Toolbox (bottom, full width)                                   │
│ T │  …grid…                                                        │
│ b │ Trade | Exposure | History | News | … | Journal   Market Signals│
├────────────────────────────────────────────────────────────────────┤
│ Status bar: For Help, press F1 │ Profile 1 │ … │ 📶 2570 / 7 Kb    │
└────────────────────────────────────────────────────────────────────┘
```

Specifically verified:
- **The Toolbox docks to the bottom edge, spanning the full application width** (it spans under both the left panel column and the chart area — it does **not** start at the chart's left edge).
- **Its tab strip sits along the BOTTOM edge of the panel**, below the grid. Confirmed in every screenshot. Same for Market Watch (`Symbols/Details/Trading/Ticks` at the bottom) and Navigator (`Common/Favorites/Chats` at the bottom). This bottom-tab convention is consistent across all three docked panels.
- When docked, the Toolbox shows a **vertical `Toolbox` label running up the left edge** of the panel, with an **`✕` close button above it** at the panel's top-left. Market Watch and Navigator instead get a **horizontal title bar** (`Market Watch: 11:25:23`, `Navigator`) with the `✕` at the right.
- The Toolbox can also **float**: all the isolated help screenshots show it as a free window with a horizontal `Toolbox` title bar and an `✕` at top-right. So both docked and floating states are real.
- **Splitter:** there is a horizontal divider line on the Toolbox's top edge, and a vertical one between the left panel column and the chart area. The MetaQuotes help **does not document the splitter or drag-to-resize at all.** A third-party guide (myforex.com/en/mt5guide/layout-window.html) describes the general mechanic: drag a panel's title bar toward docking icons that appear to re-dock top/bottom/left/right, and *"The pointer will change to a double-arrow icon"* over a border to resize. **I could not verify splitter behaviour from a MetaQuotes source — treat as third-party.**
- **Auto-hide:** **I could not verify an auto-hide/pin affordance for the Toolbox from any MetaQuotes source.** The pushpin glyph visible at the top-right of the menu bar row (`⚲ ─ ❐ ✕`) belongs to the **maximised MDI chart child window**, not to the Toolbox — I checked this at 5× magnification. Third-party guides (hw.online, myforex) claim panels can be collapsed to a thin tab and that *"you can click the pushpin icon to enable auto-hide, and windows will reappear only when your mouse hovers over their tab"*, but **they describe this for Navigator/Data Window, and I found no MetaQuotes confirmation for the Toolbox.** The vertical `Toolbox` label on the left edge is consistent with a collapsed-tab affordance but I did not see a collapsed state rendered. **Flagging as unverified — do not state auto-hide as fact.**
- Panel toggles: `Ctrl+M` Market Watch, `Ctrl+N` Navigator, `Ctrl+T` Toolbox, `Ctrl+R` Tester (Hot Keys page).
- **Status bar** (help body): *"the status bar contains additional details: server connection indication, the name of an active template and profile, as well as command prompts and price data."* Rendered: `For Help, press F1` at far left, `Profile 1`, empty segments, and a traffic/ping readout at far right (`📶 2570 / 7 Kb`, `65.02 ms`).
- **Column behaviour inside Toolbox tabs:** `A` toggles *"auto sizing of columns"* (`Auto Arrange`, on by default), `G` toggles the grid (`Grid`, on by default), and `Columns ▸` in the context menu selects which columns show.

---

## 7. Colours — the answer is BLUE for profit, RED for loss (you were told correctly)

### Desktop — verified directly from official MetaQuotes screenshots

**`history.png`** is the decisive evidence. In the Deals-mode History grid, in the default light scheme:
- **Negative Profit values render RED:** `-12.53`, `-20.04`, `-18.79`, `-28.81`, `-51.38`, `-19.42`, `-35.08`, `-25.06`, `-160.70`, `-77.54`, `-41.90`, `-80.03`, `-166.68`, `-0.75`, `-0.10`, `-3 074.89`
- **Positive Profit values render BLUE:** `0.07`, `0.14`, `0.75`, `983.00`, `2 182.93`
- The adjacent `Change` column follows identically: `-2.28 %` red, `2.18 %` blue.

**`position_manage.png`** (Trade tab): all four open positions are in profit and all four Profit figures (`183.10`, `91.15`, `183.28`, `183.28`) render **blue**. Same in `exposure_forex.png` (`68.94`, `29.00`, `42.62` blue) and `exposure_exchange.png` (`0.10`, `0.90` blue).

**No green anywhere in the Trade or History P/L columns.** Green in MT5 desktop appears only as the Market Watch row-direction arrow (↗) and as DOM Time&Sales "undefined direction" circles.

### Supporting help-text statements (MetaQuotes, verbatim)

The help never writes the rule for the `Profit` column, but it writes the *same* blue/red rule four separate times for sibling elements, which corroborates it as the platform-wide convention:
1. Trade tab, `Change` column: ***"Positive and negative values are colored in blue and red, respectively."***
2. History, `Change` column: ***"Positive and negative values are colored in blue and red, respectively."***
3. Exposure bars: ***"long positions are displayed with blue bars and short positions are displayed with red ones."***
4. Market Watch: ***"Blue — the current price is higher than the previous one; Red — the current price is lower than the previous one; Gray — the price has not changed for the last 15 seconds."***
5. Calendar: ***"If this value is less than the predicted one, the indicator is highlighted in red. If the current value is larger, the indicator is shown in blue."***

So MT5's semantic pair is **blue = positive/up, red = negative/down** — not the green/red pair common to Western charting platforms. (Note MT5's *candles* in these same screenshots are teal/red, which is a separate, user-configurable chart colour scheme — don't conflate the two.)

### Is it configurable?

**No.** The Platform Settings page documents no P/L colour option (I grepped the full page — the only colour settings are `Color print` for charts and object properties). MQL5 forum moderators confirm: the colours in those tabs *"are hard-coded in the application or follow the color rules set by Windows themes in general and are not user definable"*, and changing them *"would require modification of the MT5 terminal application which is not possible and/or is prohibited."* (https://www.mql5.com/en/forum/485297)

### Mobile — same convention, with one caveat

**Verified from the official MetaQuotes mobile screenshots:**
- Android (`/i/help/android/en/trade.png`): profit `46.91` and `27.59` render **blue**; loss `-39.55` renders **red**. The `buy 1.00` type label is **blue**, `sell 1.00` is **red**. Header total `34.95 EUR` blue.
- iPhone (`/i/help/iphone/en/trade.png`): profit `130.00` **blue**, header `130.00 USD` **blue**, `sell 1` **red**, `buy limit` **blue**, `sell limit` **red**.

So **desktop and mobile agree: blue profit, red loss.**

**Caveat I must flag:** an MQL5 forum thread from a user asks *"How to change the color of the numbers for profit or loss values to blue or red color in the mt5 on the mobile? as it now only black color"*, and the moderator replies *"I don't think there is such an option."* (https://www.mql5.com/en/forum/477144). That suggests **some mobile build or theme renders P/L in plain black**. I could not determine which build/theme/OS, and it contradicts MetaQuotes' own current screenshots. If mobile parity matters, treat "mobile always colours P/L" as medium-confidence.

**Mobile differences in colour semantics that do NOT exist on desktop** (Android history help, verbatim):
- *"S/L — … If a trade position has been closed by Stop Loss, the order is colored in **red**."*
- *"T/P — … If a trade position has been closed by Take Profit, the order is colored in **green**."*
- *"If a deal was executed as a result of triggering of Stop Loss, it is colored in **red**. If Take Profit triggered, the deal is colored in **green**."*
- *"Positions closed by Stop Loss or Take Profit are marked with **red and green vertical lines**."*

So **green does appear on mobile — but it means "closed by Take Profit", not "in profit".** This is very likely the source of any "MT5 uses green for profit" confusion. Do not carry it into a desktop P/L colour decision.

---

## 8. Other desktop↔mobile differences worth capturing

| | Desktop | Mobile (Android / iOS) |
|---|---|---|
| Trade layout | Multi-column grid, one row per position | Two-line cards: line 1 `SYMBOL, buy 1.00`, line 2 `1.26622 → 1.26673`, profit right-aligned |
| Section split | Positions above summary strip, pending orders below it | Explicit grey section headers **`Positions`** and **`Orders`** |
| Account summary | One horizontal strip, right-aligned total | Vertical label/value list with dotted leaders, at top of tab |
| Margin level label | `Margin Level: 1 076.68 %` (% after value) | **`Margin Level (%):`** then `457.14` (% in the **label**) |
| Free margin label | `Free Margin` | Android: `Free margin` · iOS: `Free Margin` |
| History modes | **4**: Positions, Deals, Orders, Orders & Deals | **3**: POSITIONS / ORDERS / DEALS (top segmented tabs) |
| History periods | `All History`, `Last 3 Months`, `Last Month`, `Custom Period` | `Today`, `Last week`, `Last month`, `Last 3 months`, `Custom period` |
| History sort | Click column header | Sort menu: `Symbol`, `Ticket`, `Open time`, `Close time`, `Profit` (tap again to reverse) |
| Navigation | Toolbox tab strip (12 tabs) + Market/Signals/VPS/Tester | Bottom nav bar — Android: `Quotes · Charts · Trade · History · Messages`; iOS: `Quotes · Chart · Trade · History · Settings` |
| Row actions | Right-click context menu | Long-press / tap row → action sheet; `…` overflow on section headers (iOS) |
| Comments | Can be authored | *"A comment can be added only when placing an order from the PC version of the MetaTrader 5 platform"* |

---

## 9. Explicit list of what I could NOT verify

1. **Desktop History `Positions`-mode and `Orders`-mode column headers and order.** Only Deals mode is screenshotted by MetaQuotes.
2. **Experts tab column headers.** Documented as a log like Journal, but never rendered in the help.
3. **Articles tab and Code Base tab** — columns, row rendering, context menus. No screenshot, no prose.
4. **News tab's complete header set.** `Subject` verified; a category column verified to exist (via the `R` hotkey); a fourth narrow column appears in the one available screenshot but is obscured and unidentified.
5. **Calendar period-selector menu strings.** Help says previous/current/next week and corresponding months, but gives no verbatim strings.
6. **Toolbox auto-hide / pin.** No MetaQuotes source. Third-party only, and those describe other panels.
7. **Toolbox splitter / drag-to-resize.** No MetaQuotes source; third-party describes the generic mechanic.
8. **`Report ▸` submenu's exact parenthesised strings.** `Overview` is MetaQuotes-confirmed; `HTML (Internet Explorer)` and `Open XML (MS Office Excel 2007)` are broker/guide sources only.
9. **DOM toolbar button labels.** The buttons are icon-only; the help describes their functions but quotes no strings.
10. **Whether MT5 mobile ever renders P/L in black** (one user report contradicts MetaQuotes' screenshots).

## 10. Corrections to the premises in your brief

| Your premise | Reality |
|---|---|
| Trade columns `Symbol, Ticket, Time, Type, Volume, Price, S/L, T/P, Price, Swap, Profit, Comment` | Default visible set is `Symbol, Ticket, Time, Type, Volume, Price, S / L, T / P, Price, Profit`. `Swap` exists but isn't default-visible; **`Comment` is a pending-order column, not a position column**. Headers use spaced slashes. Full optional set adds `ID, Value, Change, Magic`. |
| History has 2–3 view modes (Positions/Orders/Deals) | **Four**: `Positions`, `Deals`, `Orders`, `Orders & Deals`. Default is `Deals`. |
| Periods `Today / Last 3 days / Last week / Last month / Last 3 months / Custom period` | **Desktop:** `All History`, `Last 3 Months`, `Last Month`, `Custom Period` (4, Title Case). **Mobile:** `Today`, `Last week`, `Last month`, `Last 3 months`, `Custom period` (5). **"Last 3 days" exists on neither** — I could not source it anywhere in MT5. |
| "Create Alert dialog" | Titled **`Alert Editor`**. Your field list (`Action, Symbol, Condition, Value, Source, Timeout, Maximum iterations`) is right, but you're missing **`Enable`** and **`Expiration`**, and the buttons `OK / Test / Cancel`. |
| Toolbox tabs: News, Mailbox, Alerts, Articles, Journal, Experts, Calendar | Also **`Company`** (broker-conditional) and **`Code Base`**; plus right-aligned `Market`, `Signals`, `VPS`, `Tester` buttons. |
| "Profit is blue" | **Correct.** Blue profit / red loss, in both desktop and mobile default schemes, verified on official MetaQuotes screenshots; hard-coded and not user-configurable. Green on mobile means "closed by Take Profit", which is a different axis. |

**MT4 contamination check:** I kept MT4 out. The two places it would have leaked are (a) the History period strings — MT4's menu and MT5's differ, and MT4's report items are `Save as Report` / `Save as Detailed Report`, which I excluded; and (b) the Alerts `Action` option `Mail`, which exists in both but where MT5's current UI string is `Mail` per screenshot. All column lists above come from MT5-only pages under `/en/terminal/help/` and MT5 screenshots under `/i/help/terminal/en/`.

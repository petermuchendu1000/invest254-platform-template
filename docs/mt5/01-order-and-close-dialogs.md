# MetaTrader 5 order-entry & position-management UI — verified specification

**Method.** Nearly everything below is read directly off MetaQuotes' own help screenshots (I downloaded the PNG/GIF assets referenced by the official help pages and read them at native/2× resolution), plus the help body text. Colour hexes were sampled pixel-by-pixel from those same PNGs. Where I say "measured" it means I sampled the official screenshot; where I say "documented" a source states it in words. Where I could not verify, I say so.

**Critical correction up front:** the desktop MT5 order dialog in current builds has **no "Type" dropdown**. The eight strings in your brief ("Buy Limit", "Sell Limit", "Buy Stop", …) are **not** the desktop dialog's type options — that was the *legacy* MT5 dialog (pre-~build 4000). The modern dialog uses a **left-hand sidebar** with four entries and direction is chosen by which of the Sell/Buy buttons you press. The full "Buy Limit / Sell Limit / Buy Stop / Sell Stop" strings do still appear verbatim — in the **mobile** advanced-mode tab strip and in the Toolbox **Type** column. Details below.

---

## 1. New Order dialog (desktop, F9)

### 1.1 Window title
Pattern: `Order: <SYMBOL> - <symbol description>`
- Measured: `Order: EURUSD - Euro vs US Dollar`
- Exchange symbol with no description: `Order: YDEX`
Source: https://www.metatrader5.com/i/help/terminal/en/order_execution.gif (4 frames, one per execution mode), referenced from https://www.metatrader5.com/en/terminal/help/trading/performing_deals

### 1.2 Left sidebar (replaces the old Type dropdown)
Top group — exact strings, exact order:
1. `Market Execution` — *or* `Instant Execution` *or* `Request Execution` *or* `Exchange Execution`, depending on the symbol's server-side execution mode. Only one of the four is ever shown, as the first item.
2. `Limit Order`
3. `Stop Order`
4. `Stop Limit Order`
5. `Modify Position` — **only** when the window was opened on an existing position
6. `Modify Order` — **only** when opened on an existing pending order

Bottom group (always, bottom-aligned), exact order:
- `One Click Trading`
- `Tick Chart`
- `Depth of Market`
- `Minimize`

Each has a small coloured glyph to its left. Sources: order_execution.gif; https://www.metatrader5.com/i/help/terminal/en/close_position.png ; .../modify_position.png ; .../pending_order.png ; .../modify_pending_order.png

### 1.3 Field order and exact labels — market order
All labels are right-aligned and end in a colon.

| # | Label (verbatim) | Control | Notes measured from screenshots |
|---|---|---|---|
| 1 | `Symbol:` | combo box | value shown as `EURUSD, Euro vs US Dollar` (symbol, comma, space, description) |
| 2 | `Volume:` | numeric spinner | right of the field, un-labelled contract-size text: `10 000 EUR` for 0.10, `1 000 EUR` for 0.01, `501 000 EUR` for 5.01, `1 YDEX` for 1.00 |
| 3 | `Stop Loss:` | numeric spinner | hint text to the right, e.g. `99 points, ~10 USD` |
| 4 | `Take Profit:` | numeric spinner | hint text to the right, e.g. `99 points, ~10 USD` |
| 5 | `Fill policy:` | inline radio-link row | **Market/Exchange execution only.** Options rendered as clickable words, selected one underlined |
| 6 | `Comment:` | editable combo box | |
| 7 | `Deviation:` | dropdown + suffix text | **Instant execution only.** Suffix verbatim: `points, allowed difference of the execution price`. Measured default value `5` |

Note the inconsistent casing MetaQuotes itself ships: `Fill policy:` (lower-case p) in the place dialog vs `Stop Limit Price:` (capital P) in the modify dialog vs `Stop Limit price:` (lower-case p) in the place dialog.

### 1.4 Field order — pending order (Limit Order selected)
Verbatim, in order (measured from pending_order.png):
`Symbol:` → `Volume:` → *(gap)* → `Price:` → `Stop Limit price:` (greyed unless Stop Limit Order) → `Stop Loss:` → `Take Profit:` → `Expiration:` + `Expiration date:` (same row) → `Comment:`

- `Expiration:` is a dropdown; measured value `GTC`. Documented option strings (help text): `Good Till Canceled (GTC)`, `Today`, `Specified`, `Specified day`. The dropdown itself renders `GTC` in the screenshot — I could **not** verify whether the other three render as the long forms or short forms in the control.
- `Expiration date:` measured greyed value `01.09.26 08:50` (DD.MM.YY HH:MM), enabled only for `Specified`/`Specified day`.
- `Comment:` measured value `Pending Order`.
Source: https://www.metatrader5.com/i/help/terminal/en/pending_order.png

### 1.5 Fill policy option strings
Measured verbatim from the dialogs:
- Market Execution (EURUSD): `Fill or Kill` (single option, underlined)
- Exchange Execution (YDEX): `Return`  `Fill or Kill`  `Immediate or Cancel`
- Position dialog (EURUSD market exec): `Fill or Kill`  `Immediate or Cancel`

Help text wording differs slightly and is self-contradictory across sections: for market/exchange execution it lists `"Fill or Kill", "Immediate or Cancel" or "Book or Cancel"`; for pending orders it lists `"Fill or Kill", "Immediate or Cancel" or "Return"`. **"Book or Cancel" does not appear in any screenshot** — I could not verify it exists in the current UI. Source: https://www.metatrader5.com/en/terminal/help/trading/performing_deals

### 1.6 Stop Loss / Take Profit — prices or points?
**Both, and it is a platform setting, not a per-dialog toggle.** Help, Platform Settings → Trading tab, verbatim:

> "**Stop levels** — settings for the Stop Loss and Take Profit levels that will be added when placing orders or modifying positions. If the "in points" variant is chosen, stop levels will be specified in the number of points from the price of order placing. If the "in prices" variant is chosen, it will be necessary to specify the certain price level for stop levels."
> — https://www.metatrader5.com/en/terminal/help/startworking/settings

And in the order help, verbatim:
> "**Stop Loss** — the Stop Loss level as a price or distance in points from the price specified in order, depending on the platform settings. … If you leave the null value in this field, this type of order will not be set."

**Defaults / zero meaning:** the field is pre-filled with zero rendered at the symbol's digit count — measured `0.00000` for 5-digit EURUSD, `0.0` for YDEX. Zero means *no SL/TP will be attached*. The Toolbox `S / L` and `T / P` columns likewise show a zero value when no such order exists (help, verbatim: "If this order has not been placed, a zero value is displayed in this field").

Even in price mode the dialog shows the points/money equivalent as grey hint text beside the field (measured: `99 points, ~10 USD`, `1 037 points, ~52 USD`, `3 points, ~0 USD`).

### 1.7 Volume stepper behaviour
- A standard Win32 up/down spinner; step = the symbol's volume step (broker-defined). Measured values: `0.10`, `0.01`, `5.01`, `1.00`, `0.05`.
- Documented keyboard accelerators (help, verbatim): "There is a convenient way to modify prices, volumes or Stop Loss and Take Profit levels by a certain amount: Holding "Shift", — by 5 points; Holding "Ctrl", — by 10 points; Holding "Ctrl"+"Shift", — by 50 points." *(The help says "points" even though it lists volumes; I could not verify what the multiplier means for the volume field specifically.)*
- Volume default is governed by Options → Trading → `Volume` with parameters `Last Used` / `Default`.

### 1.8 Buttons — exact wording and measured colours
| Execution mode | Left button | Right button | Measured fill |
|---|---|---|---|
| Market Execution | `Sell by Market` | `Buy by Market` | red `#E24242`, blue `#3E78FA` |
| Instant Execution | `Sell` | `Buy` | red `#E24242`, blue `#3E78FA` |
| Exchange Execution | `Sell` | `Buy` | red, blue |
| Request Execution | single full-width `Request` | — | grey/neutral |
| Pending order | `Sell` (disabled grey until valid) | `Buy` | blue `#3F79FA` |

In the modern dialog the **button labels do not contain a price**. The price is displayed separately, large, centred above the buttons, as `1.16099 / 1.16099` with the last two digits rendered smaller (bid / ask). Request mode shows the literal text `Please request` in that position until you click Request.

Below the buttons there is a full-width empty status strip (visible in all four GIF frames). The help says: "Once an order is sent, its execution results appear in the window — a successful trade operation or a reason why it has not been executed." **I could not find any screenshot or source showing the exact string rendered in that strip.** Do not invent one.

### 1.9 Other documented behaviours
- Three ways to open it (verbatim): Market Watch context menu `New order`; `F9`; `New order` in the **Tools** menu or on the Standard toolbar.
- "A tick chart can be shown or hidden in any order placing window. To do this, double-click on the window."
- "If Stop Loss or Take Profit are specified incorrectly in the order, upon pressing the button, the **"Invalid stops"** alert appears and the order is not accepted."
- "If One Click Trading is enabled in the platform settings, upon successful order execution the trading window closes without notifying of execution results."
- `Comment` max length 31 characters; may be overwritten by broker/server.

### 1.10 Requote sub-state (Instant Execution)
Measured from https://www.metatrader5.com/i/help/terminal/en/requote.png: all fields grey out, the price area reads `Do you accept these new quotes?` above the new bid/ask, and the two buttons become **`Accept` (blue, left)** and **`Reject` (red, right)** — i.e. colour/position semantics invert vs Sell/Buy. Help: "New prices are valid for a few seconds only. If you do not make a decision during this time, message **"Price changed"** appears in the window. Click **"OK"** to get back to the original order placing window."

---

## 2. Closing a position (desktop)

### 2.1 Trade-tab row context menu — exact strings, exact order
Measured from https://www.metatrader5.com/i/help/terminal/en/close_position.png and .../bulk_positions.png:

```
New Order                F9
Close Position
Modify or Delete
─────────────────────────
Bulk Operations          ▸
─────────────────────────
Depth of Market          B
Open Chart               Space
─────────────────────────
Trailing Stop            ▸
Volumes                  ▸
Profit                   ▸
─────────────────────────
Deposit        (disabled)
Withdrawal     (disabled)
─────────────────────────
Report                   ▸
Show on Charts           ▸
Register as Signal
─────────────────────────
Show Milliseconds
Auto Arrange          ✓  A
Grid                  ✓  G
─────────────────────────
Columns                  ▸
```

**Source conflict:** the help *body text* calls the submenu `"Group operations"` in two places, while the help's own screenshots show `Bulk Operations`. Trust the screenshots. Also, help body text writes the command as `" Close Position"` and `" Modify or delete"` (lower-case d) whereas the screenshot shows `Modify or Delete`.

### 2.2 The close dialog
Double-clicking a position row, or `Close Position`, opens the **same** Order window re-titled:

- Title pattern: `Position: #<ticket> <buy|sell> <volume> <SYMBOL> <open price>`
  - Measured: `Position: #328906 buy 0.01 EURUSD 1.16082`
  - Measured (legacy build, with stops): `Position: #138718054 buy 0.60 EURUSD 1.10978 sl: 1.10678 tp: 1....`
- Sidebar gains `Modify Position` as a 5th entry.
- Fields: `Symbol:`, `Volume:`, `Stop Loss:`, `Take Profit:`, `Fill policy:`, `Comment:`
- Buttons: the normal `Sell by Market` / `Buy by Market` pair, **plus a third full-width button below them**.

### 2.3 The close button — exact text
Measured verbatim: **`Close #328906 buy 0.01 EURUSD 1.16082 by Market`**

Pattern: `Close #<ticket> <direction> <volume> <SYMBOL> <open price> by Market`

Note: this is **not** the format in your brief. There is no "at" and no current price — it ends `by Market` and quotes the **open** price. (In Instant/Exchange execution modes the trailing ` by Market` presumably differs; **I could not verify the Instant-execution variant** — no screenshot exists.)

Colours measured: fill `#FFF9E6` (very pale cream), 2px border `#D9D9BA`, black text. It is **not** the saturated yellow in your brief — that was the legacy skin (see 2.5).

### 2.4 Partial close
Help, verbatim: "If you want to close a part of the position, enter the volume to close in the "Volume" field." and, for hedging accounts: "To partially close a position, click "Close Position" in the context menu of the appropriate position. Next enter the value of the volume to close and click "Close…"."
The button text updates to reflect the reduced volume (inferred from the pattern; not separately screenshotted). In Request Execution mode "the price must be requested before you close a position."

### 2.5 Close by
This is the one place the **legacy** dialog is still documented, because MetaQuotes never re-shot the screenshot. From https://www.metatrader5.com/i/help/terminal/en/close_by.png (a 2016-era Windows-7-skinned build):
- There **is** a `Type:` dropdown, value **`Close By`**.
- Below it, a grid of candidate opposite positions with columns `Ticket | Volume | Price | Market | Profit`.
- Button, verbatim: **`Close position #138718054 by #138718063`**
- Button colour measured: fill `#F0F0AB`, border `#AFAF6D` — the olive/yellow you were thinking of.

Help body text, verbatim: "Click twice on a position or select "Close Position" in its context menu on the Trade tab. In the Type field select "Close By": Select an opposite position and click "Close"."

**In the current build** I could find **no** screenshot of Close By, so I cannot tell you whether the Type dropdown still exists in this specific sub-mode or whether it has been folded into the sidebar. Flagging this as unverified.

Documented semantics: hedging accounts only; places an order of type `close by`; tickets of the closed pair go in the order comment; the pair is closed by two deals of type `out by`; total P/L appears on one deal only; saves one spread.

### 2.6 Bulk Operations submenu — exact strings
Measured from bulk_positions.png (desktop, EURUSD buy position selected):
```
Close All Positions
Close Profitable Positions
Close Losing Positions
Close Buy Positions
Close EURUSD Positions
Close Buy EURUSD Positions
Close by EURUSD
───────────────────────────
Delete All Orders          (disabled)
Delete Limit Orders        (disabled)
Delete Stop Orders         (disabled)
Delete Stop Limit Orders   (disabled)
```
The symbol- and direction-specific entries are generated from the selected row; with no row selected only the first three plus the Delete group appear. Note the real strings are `Close Profitable Positions` / `Close Losing Positions`, **not** "Close Profitable" / "Close Losing".

Documented constraints: "These commands are only available if One Click Trading is enabled in platform settings." FIFO accounts hide the profitable/losing/same-direction/opposite commands. Netting accounts get a `Reverse position` command instead of the hedging ones (help text; the exact menu string for it is given only as "Reverse position" in prose — **not verified against a screenshot**).

### 2.7 One-click close from the Trade tab
Help, verbatim: "The "Profit" column of each open position has the button. If you click the button for a position, it will be immediately closed without additional confirmation." The glyph is a small `✕` at the right edge of the Profit column (visible in close_position.png, bulk_positions.png and terminal-black.png). The same `✕` appears in the `S / L` and `T / P` columns to delete those levels, and in the `State` column to delete a pending order.
Source: https://www.metatrader5.com/en/terminal/help/trading/one_click_trading

---

## 3. Modify position ("Modify or Delete")

### 3.1 The dialog
Measured from https://www.metatrader5.com/i/help/terminal/en/modify_position.png:
- Opened via `Modify or Delete` in the Trade-tab context menu, or by double-clicking, then selecting `Modify Position` in the sidebar.
- Title: `Position: #328896 buy 1 GBPJPY 216.391`
- **Only two field rows**, each with *two* spinners side by side — this is the "level-in-points helper" you asked about:

```
Stop Loss:   [ 214.531 ⇅ ]   [ 1860 ⇅ ] points
Take Profit: [ 219.526 ⇅ ]   [  135 ⇅ ] points
```
The left spinner is the absolute price, the right spinner the distance in points from the position's open price; they are bound bidirectionally. The literal word `points` is the suffix label on both rows.

- Bid/ask displayed large and centred below.
- Single full-width button, **blue `#3F79FA`**, verbatim: **`Modify #328896 buy 1 GBPJPY 216.391 sl: 214.531 tp: 219.526`**
  Pattern: `Modify #<ticket> <direction> <volume> <SYMBOL> <open price> sl: <sl> tp: <tp>`
- Grey hint text under the button, verbatim, two lines:
  > `Stop Loss or Take Profit you set must differ from market price by at least 0 points.`
  > `Stops processing is performed on the broker side.`

  The `0` is the symbol's stops level (`SYMBOL_TRADE_STOPS_LEVEL`); this broker's demo has it set to zero.

Help, verbatim: "The "Modify..." button is inactive until the Stop Loss and Take Profit are set correctly. The terms of stop levels are determined by the broker and are specified in symbol properties (contract specification)." and "A double click on the position modifying window shows/hides a tick chart."

### 3.2 The equivalent for pending orders
Measured from https://www.metatrader5.com/i/help/terminal/en/modify_pending_order.png:
- Title: `Order: #328921 buy limit 0.05 EURUSD at 1.14580`
- Sidebar gains `Modify Order`.
- Rows: `Symbol:` / `Price:` + `Stop Limit Price:` / `Stop Loss:` / `Take Profit:` / `Expiration:` + `Expiration date:`
- Hint text under the field for Take Profit: `1 520 points, ~0 USD`
- **Two buttons**: blue `Modify` (left, `#3F79FA`) and red `Delete` (right).
- Two-line hint, verbatim:
  > `Open price you set must differ from market price by at least 0 points.`
  > `The same conditions apply for Stop Loss and Take Profit levels.`

Help: volume, fill policy and comment cannot be modified on a pending order. The help body text says to "click "Change"" in one sentence and refers to "the "Modify" button" in the next — the screenshot shows **`Modify`**; treat "Change" as a help-text error.

### 3.3 "Copy as" helper
**I could not verify any "Copy as" control.** No such string appears in any MT5 help page, screenshot or asset I examined. If you saw it, it may be from a third-party panel, from MT4, or from the mobile app's "Price / Pips / USD" segmented control (section 7.4). I am explicitly not confirming it exists.

### 3.4 Minimum-distance rules and error strings
- Documented rule: the broker's stops level, exposed as `SYMBOL_TRADE_STOPS_LEVEL` in points; also a freeze level (`SYMBOL_TRADE_FREEZE_LEVEL`).
- Client-side pre-flight alert, verbatim from the help: **`Invalid stops`**.
- Server-side rejection: `TRADE_RETCODE_INVALID_STOPS` = **10016**, described in the MQL5 docs as "Invalid stops in the request". Source: https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes
- Real Journal line format, as pasted by users on the MQL5 forum: `failed instant buy 0.96 EURUSD at 1.12210 sl: 1.12185 tp: 1.12435 [Invalid stops]` (https://www.mql5.com/en/forum/337102) and `failed instant buy 1 BTCUSD at 66354.407 sl: 66454.407 tp: 65854.407 [Invalid stops]` (https://www.mql5.com/en/forum/380532).

> **"Invalid S/L or T/P" is an MT4 string, not MT5.** MT4 raises error 130 `ERR_INVALID_STOPS` and surfaces "Invalid S/L or T/P"; MT5 uses "Invalid stops" / retcode 10016. Do not use the MT4 wording in an MT5 context.

### 3.5 Chart-based modification
- Requires `Show trade levels` enabled; drag the SL/TP line (Drag'n'Drop); on release the modification window opens for fine adjustment; a tooltip during the drag shows "potential profit (or loss) in the deposit currency and pips".
- Disabled by the `Disable dragging of trade levels` option; or require Alt via `Enable dragging of trade levels with "Alt" key`.
- From the chart context menu, the `Trading` submenu offers SL/TP placement at the cursor's price level (see 4.3).
- With One Click Trading on, chart drags/menu commands apply instantly with no dialog.

---

## 4. One-click trading (desktop)

### 4.1 The chart panel — layout and exact rendering
Enabled via chart context menu `One Click Trading` (shortcut `Alt+T`), or the toggle glyph left of the OHLC line.

Layout, left to right, measured from bulk_positions.png and terminal-black.png:
```
┌──────────┬───┬───────────────┬──────────┐
│   SELL   │ ▾ │   0.05    ⇅   │   BUY    │   ← header row
├──────────┴───┴───────────────┴──────────┤
│  1.16 09⁶          │         1.16 09⁷    │   ← price row (two large tiles)
└─────────────────────┴────────────────────┘
```
- `SELL` and `BUY` are upper-case.
- The volume field sits **between** them with a dropdown caret on the left and a spinner on the right — confirming your assumption.
- The two big tiles below are the clickable bid (left, red) and ask (right, blue) rate buttons.

Documented typography rule, verbatim from the help:
> "The decimal point between the numbers of different size is not displayed to save space. The font size is used as a separator instead. In three-digit quotes, the first and second digits are highlighted, while in five-digit quotes — the third and fourth ones. The last two digits are highlighted in other cases."

So `1.16096` renders as small `1.16`, large `09`, superscript-small `6`.

Measured panel colours, **light theme, current build**:
- SELL tile: vertical gradient `#ED3E3E` → `#D72828` → `#BC0D0D`
- BUY tile: vertical gradient `#3E3EED` → `#2828D7` → `#0D0DBC`

Measured, **dark theme** (from the official build-5640 screenshot): both tiles render as the *same* dark-blue gradient `#18265B` → `#2A386D` → `#334176` → `#3C4A7F`, with header buttons `#4E5C91`–`#606EA3`. I find this surprising and flag it — it may be a quirk of that particular chart colour scheme rather than the theme. Source: https://www.metatrader5.com/c/17/1/terminal-black.png (from https://www.metatrader5.com/en/releasenotes/terminal/2430)

The **older** help screenshot (https://www.metatrader5.com/i/help/terminal/en/chart_oneclick_trading.png, a 2013-era build) shows both tiles in plain blue — it is outdated and should not be used as a colour reference.

### 4.2 The disclaimer dialog
Appears on first use. Measured from https://www.metatrader5.com/i/help/terminal/en/one_click_disclaimer.png:
- Title bar: icon + **`One Click Trading`**
- Centred sub-heading: **`Disclaimer`**
- Scrollable body. Verbatim, as far as the screenshot renders:

> You are about to activate One Click Trading mode. By clicking "I Accept these Terms and Conditions" below, you acknowledge that you have read and understood the following terms and conditions, and you agree to be bound hereby. Your current version of the terminal enables you to choose between the following modes for order submission. You agree that you will be bound by the procedures and conditions specified herein with respect to each such mode.
>
> 1. The Default mode for order submission is a two-step process: you first open a new order window, then you select an appropriate order type, its parameters, and confirm your order submission by clicking either Buy, Sell, Place, Modify or Close buttons depending on the particular order type selected and your trading intentions. Your order will not be submitted until you have completed both of the aforementioned steps.
>
> 2. The One Click Trading mode for order submission is a one-step process. Your order will be submitted when you:
> - click either bid (SELL) or ask (BUY) rate buttons either:
> &nbsp;&nbsp;&nbsp;- on the Trading tab in the Market Watch window
> &nbsp;&nbsp;&nbsp;- on the One Click Trading panel of a chart
> - click Sell, Close or Buy buttons in the Depth of Market window
> - drag orders on the chart or in the Depth of Market window
> - select order placing commands from the context menu of a chart or in the Depth of Market window
> - delete orders in the Trade tab of the Toolbox window, in the Depth of Market window or from the chart context menu
>
> THERE WILL BE NO SUBSEQUENT CONFIRMATION PROMPT FOR YOU TO CLICK. YOU WILL NOT BE ABLE TO WITHDRAW OR CHANGE YOUR ORDER ONCE YOU CLICK. UNDER NORMAL MARKET CONDITIONS AND SYSTEM PERFORMANCE, A …  *(text continues below the fold)*

- Buttons, bottom right: **`Cancel`** (left) and **`I Accept these Terms and Conditions`** (right, focused, blue focus ring).

**The remainder of the text is cut off by the screenshot.** The MT4 help publishes the full equivalent text at https://www.metatrader4.com/en/trading-platform/help/setup/setup_trade and the shared paragraphs match MT5's word-for-word except for the MT5-specific Depth-of-Market bullets. The MT4 continuation reads:

> THERE WILL BE NO SUBSEQUENT CONFIRMATION PROMPT FOR YOU TO CLICK. YOU WILL NOT BE ABLE TO WITHDRAW OR CHANGE YOUR ORDER ONCE YOU CLICK. UNDER NORMAL MARKET CONDITIONS AND SYSTEM PERFORMANCE, A MARKET ORDER WILL BE PROMPTLY FILLED AFTER SUBMISSION AND YOU WILL HAVE ENTERED INTO A BINDING TRANSACTION.
>
> You can activate or deactivate One Click Trading mode on the Trade tab of Options window of the terminal.
>
> By selecting the One Click Trading mode, you understand that your orders will be submitted by clicking the bid or ask rate button or in any other way described above, without any further order confirmation. You agree to accept all risks associated with the use of the order submission mode you have chosen, including, without limitation, the risk of errors, omissions or mistakes made in submitting any order.
>
> You agree to fully indemnify and hold harmless #company# from any and all losses, costs and expenses that it may incur as a result of any such errors, omissions or mistakes by you, your trading manager or any other person trading on your behalf.

`#company#` is a template placeholder the broker's server substitutes. **Treat the continuation as MT4-sourced and very likely but not certainly identical in MT5.**

**Source conflict on the control type:** both the MT5 and MT4 help *body text* say "tick "I Accept these Terms and Conditions" option and click "OK"" — i.e. a checkbox plus OK. The current MT5 **screenshot** shows no checkbox; "I Accept these Terms and Conditions" is itself the confirm **button**. Trust the screenshot for current builds.

### 4.3 Chart context menu
Measured from https://www.metatrader5.com/i/help/terminal/en/chart_trading_menu.png, full menu in order:
```
Sell Limit 1                 219.306     ← context-sensitive top item
Trading                            ▸
──────────────────────────────────────
Depth Of Market              Alt+B
One Click Trading            Alt+T
Indicator List               Ctrl+I   (disabled)
Object List                  Ctrl+B   (disabled)
Expert List                  Alt+X    (disabled)
──────────────────────────────────────
Bar Chart                    Alt+1
Candlesticks                 Alt+2
Line Chart                   Alt+3
──────────────────────────────────────
Timeframes                         ▸
Templates                          ▸
Refresh
──────────────────────────────────────
Docked                       Alt+D
Grid                         Ctrl+G
Auto Scroll
Chart Shift
──────────────────────────────────────
Volumes                      Ctrl+K
Tick Volumes                 Ctrl+L
Trade Levels
Trade History
──────────────────────────────────────
Zoom In                      +
Zoom Out                     -
Delete Indicators Window             (disabled)
Step by Step                 F12
──────────────────────────────────────
Save as Picture
──────────────────────────────────────
Properties                   F8
```

The **`Trading` submenu**, measured with the cursor above the current price:
```
Sell Limit 1       219.306
Buy Stop   1       219.306
Take Profit        219.306
Alert              219.306
───────────────────────────
New Order          F9
```
The `1` is the volume taken from the one-click panel; `219.306` is the price under the cursor. Help, verbatim: "If the menu is activated above the current price, a user can place Sell Limit and Buy Stop orders. If the menu is activated below the current price, Buy Limit and Sell Stop orders can be placed." Stop Loss / Take Profit entries appear only when an open position exists on that symbol, and which of the two appears depends on the position's direction and the cursor's side of the open price. Available distance is validated against the symbol's stops level.

Note: the top-level menu repeats the first Trading-submenu command as its own first item.

---

## 5. Error and confirmation states

### 5.1 Where messages appear
Help, verbatim: "Upon order execution, an appropriate massage [sic] about an open position is added to the **Trade** tab of the Toolbox window, as well as the order and the deal (or deals) executed for the order are added to the **History** tab." And: "Once an order is sent, its execution results appear **in the window**." And: "When a requote is received, an appropriate message is added to the platform **journal** and a requote sound is played."

So: three places — the dialog's status strip (suppressed entirely when One Click Trading is on), the Toolbox **Journal** tab, and the Toolbox **Trade**/**History** tabs for the resulting records.

### 5.2 Journal line formats (verified from real user-pasted logs, not from MetaQuotes)
These come from the MQL5 forum, where users paste actual Journal output. They are consistent across threads but are **community sources, not official**:

- Failure: `2020.10.20 19:20:00.632  Trades  '83263': failed instant sell 0.1 EURUSD at 0.00000 sl: 1.26408 tp: 1.10408 [Invalid price]` — https://www.mql5.com/en/forum/353909
- Failure: `failed instant buy 0.96 EURUSD at 1.12210 sl: 1.12185 tp: 1.12435 [Invalid stops]` — https://www.mql5.com/pt/forum/337102
- Success (order): `2016.02.04 00:02:16.750  Trades  '680467': order #47966509 buy 0.01 / 0.01 AUDCAD at 0.98767 done in 246 ms`
- Success (deal): `2016.02.04 00:02:16.747  Trades  '680467': deal #39021669 buy 0.01 AUDCAD at 0.98767 done (based on order #47966509)`
- Pending order sequence: `buy limit 0.01 USDJPY at 100.000` → `accepted buy limit 0.01 USDJPY at 100.000` → `order #3000125018 buy limit 0.01 / 0.01 USDJPY at market done in 67.785 ms` — https://www.mql5.com/en/forum/290323
- Tester/EA phrasing also includes `order performed sell 2 at 1.25731 [#3390 sell 2 GBPUSD at 1.25731]` and `deal performed [#3264 sell 2 GBPUSD at 1.25731]` — https://www.mql5.com/en/forum/310532

General pattern: `<timestamp>  <Trades|Trade>  '<login>': <failed |>{instant|market|exchange|request} {buy|sell} <volume> <SYMBOL> at <price>[ sl: <x>][ tp: <y>] [<Error Text>]`, with the error text in **square brackets**.

**I could not verify your proposed strings `"Order placed"` and `"#12345678 buy 0.10 XAUUSD at ..., done"` as literal UI strings.** "Order placed" is the *MQL5 documentation description* of retcode 10008 (see below), not necessarily a string shown in the GUI. The `…, done` form with a comma does not match any log line I found; the real form is `… at <price> done in <n> ms` with no comma.

### 5.3 Documented rejection reasons (MQL5 trade server return codes)
These are the official texts from https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes. The **bracketed Journal text is usually a shortened form of these** (e.g. retcode 10016 "Invalid stops in the request" → `[Invalid stops]`), so do not assume the GUI shows the full doc wording.

| Code | Constant | Documented description |
|---|---|---|
| 10004 | TRADE_RETCODE_REQUOTE | Requote |
| 10006 | TRADE_RETCODE_REJECT | Request rejected |
| 10007 | TRADE_RETCODE_CANCEL | Request canceled by trader |
| 10008 | TRADE_RETCODE_PLACED | Order placed |
| 10009 | TRADE_RETCODE_DONE | Request completed |
| 10010 | TRADE_RETCODE_DONE_PARTIAL | Only part of the request was completed |
| 10011 | TRADE_RETCODE_ERROR | Request processing error |
| 10012 | TRADE_RETCODE_TIMEOUT | Request canceled by timeout |
| 10013 | TRADE_RETCODE_INVALID | Invalid request |
| 10014 | TRADE_RETCODE_INVALID_VOLUME | Invalid volume in the request |
| 10015 | TRADE_RETCODE_INVALID_PRICE | Invalid price in the request |
| 10016 | TRADE_RETCODE_INVALID_STOPS | Invalid stops in the request |
| 10017 | TRADE_RETCODE_TRADE_DISABLED | Trade is disabled |
| 10018 | TRADE_RETCODE_MARKET_CLOSED | Market is closed |
| 10019 | TRADE_RETCODE_NO_MONEY | There is not enough money to complete the request |
| 10020 | TRADE_RETCODE_PRICE_CHANGED | Prices changed |
| 10021 | TRADE_RETCODE_PRICE_OFF | There are no quotes to process the request |
| 10022 | TRADE_RETCODE_INVALID_EXPIRATION | Invalid order expiration date in the request |
| 10023 | TRADE_RETCODE_ORDER_CHANGED | Order state changed |
| 10024 | TRADE_RETCODE_TOO_MANY_REQUESTS | Too frequent requests |
| 10025 | TRADE_RETCODE_NO_CHANGES | No changes in request |
| 10026 | TRADE_RETCODE_SERVER_DISABLES_AT | Autotrading disabled by server |
| 10027 | TRADE_RETCODE_CLIENT_DISABLES_AT | Autotrading disabled by client terminal |
| 10028 | TRADE_RETCODE_LOCKED | Request locked for processing |
| 10029 | TRADE_RETCODE_FROZEN | Order or position frozen |
| 10030 | TRADE_RETCODE_INVALID_FILL | Invalid order filling type |
| 10031 | TRADE_RETCODE_CONNECTION | No connection with the trade server |
| 10032 | TRADE_RETCODE_ONLY_REAL | Operation is allowed only for live accounts |
| 10033 | TRADE_RETCODE_LIMIT_ORDERS | The number of pending orders has reached the limit |
| 10034 | TRADE_RETCODE_LIMIT_VOLUME | The volume of orders and positions for the symbol has reached the limit |
| 10035 | TRADE_RETCODE_INVALID_ORDER | Incorrect or prohibited order type |
| 10036 | TRADE_RETCODE_POSITION_CLOSED | Position with the specified POSITION_IDENTIFIER has already been closed |
| 10038 | TRADE_RETCODE_INVALID_CLOSE_VOLUME | A close volume exceeds the current position volume |
| 10039 | TRADE_RETCODE_CLOSE_ORDER_EXIST | A close order already exists for a specified position |
| 10040 | TRADE_RETCODE_LIMIT_POSITIONS | Number of open positions limited by server settings |
| 10041 | TRADE_RETCODE_REJECT_CANCEL | The pending order activation request is rejected, the order is canceled |
| 10042 | TRADE_RETCODE_LONG_ONLY | Rejected — "Only long positions are allowed" |
| 10043 | TRADE_RETCODE_SHORT_ONLY | Rejected — "Only short positions are allowed" |
| 10044 | TRADE_RETCODE_CLOSE_ONLY | Rejected — "Only position closing is allowed" |
| 10045 | TRADE_RETCODE_FIFO_CLOSE | Rejected — "Position closing is allowed only by FIFO rule" |
| 10046 | TRADE_RETCODE_HEDGE_PROHIBITED | Rejected — "Opposite positions on a single symbol are disabled" |

Notes on your specific strings: it is **`Market is closed`**, not "Market closed". **`Requote`** is exact. **`Not enough money`** is the *short* form widely used in broker FAQs and seen in Journal brackets; the documented long form is "There is not enough money to complete the request" — I found the short form only in broker help, not in a MetaQuotes source, so treat the exact bracket text as unconfirmed. **`Invalid volume`** likewise appears as the short bracket form (confirmed in the Android help's error list, section 7.6) against the documented "Invalid volume in the request".

The mobile help does independently confirm several short forms verbatim, which is useful corroboration — it names the errors `"No prices"`, `"A close order already exists for a specified position"`, `"Invalid volume"`, `"Request rejected"` and `"Only part of the request was completed"`. Source: https://www.metatrader5.com/en/mobile-trading/android/help/trade/bulk_operations

---

## 6. Colours and typography

### 6.1 Is anything officially documented?
**No hex values are published by MetaQuotes anywhere I could find.** What *is* documented is the *existence* of named theme colours, exposed to MQL5 but not listed with values:

- `TERMINAL_COLORTHEME_NAME` (ENUM_TERMINAL_INFO_STRING) returns `Light` or `Dark`.
- `THEME_COLOR_*` (ENUM_TERMINAL_INFO_INTEGER) returns the live colour of a named UI element. The relevant ones for your purposes: **`THEME_COLOR_POSITIVE`** ("Positive value color"), **`THEME_COLOR_NEGATIVE`** ("Negative value color"), `THEME_COLOR_ERROR` ("Error message text color"), `THEME_COLOR_INVALID` ("Invalid value text color"), plus `THEME_COLOR_WINDOW`, `THEME_COLOR_HIGHLIGHT`, `THEME_COLOR_INFOBK`, `THEME_COLOR_LINE1`/`LINE2`/`GRID`/`SUMMARY`, etc.
Source: https://www.mql5.com/en/docs/constants/environment_state/terminalstatus

Practically: if you need exact values, a three-line MQL5 script calling `TerminalInfoInteger(THEME_COLOR_POSITIVE)` etc. will give you authoritative, build-current numbers. That is the only documented route.

### 6.2 Everything below is **my measurement from MetaQuotes' own PNG screenshots**, not documented
Sampled with PIL at native resolution; exact pixel values, but they are one build, one broker, one Windows theme.

**Light theme (current build, Windows 11 skin)**
| Element | Hex | Source file |
|---|---|---|
| Sell / "Sell by Market" button | `#E24242` – `#E34141` | order_execution.gif, close_position.png |
| Buy / "Buy by Market" button | `#3E78FA` – `#3F79FA` | order_execution.gif, close_position.png |
| "Modify …" button (position & order) | `#3F79FA` | modify_position.png, modify_pending_order.png |
| "Delete" button (pending order) | red, same family as Sell | modify_pending_order.png |
| Close-position button fill | `#FFF9E6` | close_position.png |
| Close-position button border | `#D9D9BA` | close_position.png |
| Dialog body background | `#FFFFFF` | close_position.png |
| Dialog sidebar background | `#F3F5F9` | close_position.png |
| Dialog title bar | `#F3F3F3` | close_position.png |
| Selected row / menu highlight | `#0078D7` (Windows accent) | close_position.png |
| Profit (positive) text, Toolbox | `#0000FF` | close_position.png |
| Loss (negative) text, Toolbox | red — I did not isolate a clean sample | — |
| One-click SELL tile | `#ED3E3E` → `#D72828` → `#BC0D0D` | bulk_positions.png |
| One-click BUY tile | `#3E3EED` → `#2828D7` → `#0D0DBC` | bulk_positions.png |
| Default bull candle | `#26A69A` | close_position.png |
| Default bear candle | `#EF5350` | close_position.png |
| Tooltip background | `#FFFFB6` | close_position.png |

**Dark theme (build 5640 official screenshot)**
| Element | Hex |
|---|---|
| Window / panel background | `#1F1F1F` |
| Title bar | `#202020` |
| Alternate row | `#2A2A2A` |
| Summary / account-state row | `#444444` |
| Positive value (profit, bid-up) | `#1E95FE` |
| Negative value (loss) | `#FE6E6E` |
| One-click tiles | `#18265B` → `#2A386D` → `#334176` → `#3C4A7F` (both sides, see 4.1 caveat) |
| One-click header buttons | `#4E5C91` – `#606EA3` |

Source: https://www.metatrader5.com/c/17/1/terminal-black.png

**Legacy theme (2016-era help screenshot, still published)**
| Element | Hex |
|---|---|
| Close-By confirm button fill | `#F0F0AB` |
| Close-By confirm button border | `#AFAF6D` |
| Selection highlight | `#3399FF` |

Source: https://www.metatrader5.com/i/help/terminal/en/close_by.png

### 6.3 Dark theme availability
Added in **build 5100** — "Added support for a dark color scheme for all components, including the trading terminal, MetaEditor, and the visual tester", switchable from the **View** menu (https://www.metatrader5.com/en/releasenotes/terminal/2393). Refined in **build 5640**: "Improved dark theme across all components… The overall background color, as well as tab and scrollbar colors, have been updated" (https://www.metatrader5.com/en/releasenotes/terminal/2430). A `View \ Color Themes \ System` option follows the Windows setting at launch.

**Important:** before build 5100 MT5 had **no** dark UI theme — only per-chart colour schemes (Yellow on Black / Green on Black / Black on White). If you are modelling "MT5's default dark scheme", be clear whether you mean the chart scheme or the build-5100+ application theme; they are different things.

### 6.4 Typography
- Desktop dialogs use the Windows UI font (Segoe UI on Win10/11) at default size; labels right-aligned, values right-aligned in fields.
- The large bid/ask readout and the one-click tiles use the mixed-size digit convention quoted verbatim in 4.1.
- I found **no** documented font family, size or weight anywhere. Everything typographic above is observational.

---

## 7. MOBILE (Android and iOS) — these differ substantially from desktop and from each other

Sources: https://www.metatrader5.com/en/mobile-trading/android/help/trade and its subpages (`open_positions`, `closeby`, `change_positions`, `pending_place`, `pending_change`, `bulk_operations`); https://www.metatrader5.com/en/mobile-trading/iphone/help/trade and `…/trade/open_positions`; plus the screenshots under `/i/help/android/en/` and `/i/help/iphone/en/`.

### 7.1 Two distinct order UIs exist on mobile
1. **The classic full-screen order form** (reached from Quotes → New order, or the Trade tab's `+` button).
2. **"Advanced Mode"** — a draggable bottom-sheet trading dialog used when opening positions **from the chart**. Help: "This mode is used when opening positions from the chart. It provides additional tools for calculating volume and risk."

### 7.2 Classic form — Android (measured from /i/help/android/en/open_market.png, open_instant.png)
Top to bottom:
1. Back arrow, symbol `EURUSD`, subtitle `Euro vs US Dollar`, right-hand currency/sync icon
2. Full-width selector showing the order type, e.g. `Market Execution` / `Instant Execution`
3. **Volume stepper — seven cells**, the centre one being the value:
   `-0.5 | -0.1 | -0.01 | **0.61** | +0.01 | +0.1 | +0.5`
   The increments adapt to magnitude — at volume `2.00` the row measured `-5 | -1 | -0.1 | 2.00 | +0.1 | +1 | +5`
4. Two large bid/ask prices (red when falling)
5. SL row: `−  SL  +` with an **orange** underline when empty; shows the price (e.g. `185.746`) once set
6. TP row: `−  TP  +` with a **green** underline; e.g. `188.273`
7. Deviation row (Instant only): `−  Deviation  1  +`
8. `Fill policy` … `Fill or Kill` (lower-case p on Android)
9. Tick chart
10. Warning, verbatim: `Attention! The trade will be executed at market conditions, difference with requested price may be significant!`
11. Buttons: `SELL` / `BY MARKET` (red) and `BUY` / `BY MARKET` (blue) — two-line labels, upper case. In Instant Execution mode they are just `SELL` and `BUY`.

### 7.3 Classic form — iOS (measured from /i/help/iphone/en/open_market.png)
Different from Android:
1. Circular back `‹`, symbol `EURGBP ⌄`, subtitle `Euro vs Pound Sterling`
2. Row `Market Execution` with a `⌄` chevron (a real dropdown)
3. **Volume stepper — five cells**: `-5 | -1 | 7.00 | +1 | +5`
4. `Stop Loss`    `−`   `0.87401` (orange)   `+`
5. `Take Profit`  `−`   `0.87486` (green)    `+`   — unset renders as the grey placeholder `not set`
6. `Fill Policy` … `Fill or Kill` (**capital P** on iOS — Android uses lower-case)
7. Two large prices
8. Full-width split buttons: **`Sell by Market`** (left, measured `#CE6555`) | **`Buy by Market`** (right, measured `#5C91ED`) — sentence case, unlike Android's upper case
9. Same `Attention!…` warning text below the buttons

### 7.4 Advanced Mode bottom-sheet (both platforms)
Measured from open_market_extended.png on both platforms. Top to bottom:
- Drag handle; symbol `EURUSD ⇅` with bid/ask on the right; subtitle
- **Horizontal order-type tab strip — this is where your eight strings actually live**, measured verbatim:
  `Market Execution` / `Instant Execution` · `Buy Limit` · `Sell Limit` · `Buy Stop` · `Sell Stop` (scrolls; `Buy Stop Limit` / `Sell Stop Limit` presumably follow but are **off-screen in every official screenshot — unverified**)
  When opened on an existing position the strip reads `Market Execution` · **`Modify`** · `Buy Limit` · `Sell Limit` · `Buy St…`
- `Volume` [value ⇅] | unit selector `Lots ⇅` (alternative: `Margin`)
- Volume slider
- `Margin ≈ 2 320.96 USD` (left, "Margin" hyperlinked) · `Free: 100 000.00 USD` (right)
- Segmented control for stop-level units: **`Price` | `Pips` | `USD`** (the deposit currency; iOS shot shows only `Price | Pips`)
- `SL` chip (red, measured `#DD5B4E`) [value ⇅] · `TP` chip (green, measured `#0EB52E`) [value ⇅] · **lock icon** — the lock pins the TP:SL ratio. Help, verbatim: "you can lock the Take Profit to Stop Loss ratio by tapping . Now, adjusting one level automatically updates the other using the specified ratio"
- Under each: the equivalent in the other unit, e.g. red `185.993  -187.04 USD` and green `+374.09 USD  186.443`
- `Deviation: 1 ⇅`
- `Comment: Add comment`
- Buttons: **`Sell`** (measured `#E5461E`) · **`Buy`** (measured `#1C7CDD`) — sentence case
- Interactive price chart below with draggable `SL`/`TP` level lines

Documented behaviours worth noting: volume and stop values persist between orders ("Only the most recent value is stored; volume values are not saved separately for each symbol"); saved stop values are stored **in pips** and converted to prices on reuse; if you manually invert SL above TP, "only the Sell button remains active… The Buy button becomes disabled"; invalid values highlight the field **in red** and disable the trade buttons.

### 7.5 Close position — mobile
**Android** (measured from /i/help/android/en/close_position.png):
- Title: `Close position #57040054558`, subtitle `buy 0.61 GBPUSD at 1.33629`
- Same volume stepper (for partial close), prices, SL/TP rows, Fill policy, tick chart, the `Attention!…` warning
- Bottom action is **text, not a filled button**: `CLOSE WITH PROFIT 334.89` — "CLOSE WITH PROFIT" in orange (measured `#FF9300`), the amount in blue
- From the chart, a bottom bar shows an outlined orange pill `CLOSE BUY 0.61` (measured `#EF9C20`), an `SL` red circle, a `TP` green circle, and a `→`, with tabs `Close position` | `Modify position`

**iOS** (measured from /i/help/iphone/en/close_position.png):
- Same form as the order screen, with a **third full-width orange button** below Sell by Market / Buy by Market, verbatim:
  **`Close #6778646242 buy 7 by Market with Profit 3 421.63`**
  Measured fill `#E19334`.
  Pattern: `Close #<ticket> <direction> <volume> by Market with Profit <amount>` — note it carries the **profit**, not the open price, unlike desktop.
- In Advanced Mode, the position card shows `#6778646242` · `2026.02.06 15:57` · `buy 7` · `3 485.42`, a `Price | Pips` segmented control, a `T/P` row with placeholder `Take Profit` and an `S/L` row with a checkbox and value `0.86749`, then two buttons: orange **`Close buy 7.00`** and grey disabled **`Modify`**.

### 7.6 Context menus — mobile (and the Android/iOS divergence)
**Android** — long-press a row for one second. Position context menu, verbatim and in order (measured from /i/help/android/en/bulk_positions.png):
```
Close position
Close by
Modify position
New order
Chart
Bulk Operations...
```
Order context menu (help text): `Modify order`, `Delete order`, `Chart`.

**iOS** — a **single tap** opens the context menu; a right-to-left **swipe** on the row exposes quick-action icons (context menu / modify / close-or-delete), and dragging further goes straight to the close screen. Position context menu, verbatim:
```
Close position
Modify position
Trade
Chart
Depth of Market
```
Order context menu: `Delete`, `Modify`.

Note the differences: Android has `Close by`, `New order` and `Bulk Operations...`; iOS has `Trade` and `Depth of Market` instead, and does **not** list Close By in its context menu.

**Android Bulk Operations sheet** (measured), title `Bulk Operations`, subtitle `#50719471419 sell 0.01 EURUSD 1.06631`:
```
Close All Positions
Close Profitable Positions
Close Losing Positions
Close Sell Positions
Close EURUSD Positions
Close EURUSD Sell Positions
Close by EURUSD
```
Compare desktop, which renders the symbol+direction entry as `Close Buy EURUSD Positions` — **the word order differs between desktop and mobile**. Both are generated from the selected row's direction.

The sheet is also reachable from a `⋯` button in the `Positions` section header. Help: "Bulk operations are executed without additional user confirmations; therefore, one-click trading should be allowed in the application settings."

### 7.7 Modify position — mobile
Android (measured from /i/help/android/en/position_modify.png — **this screenshot is an old Android-Holo-era build and the styling is outdated**):
- Header `Modify position` / `buy 1.00 AUDUSD at 0.77662`
- Prices, then `−  0.77617  +` (SL, red underline) and `−  TP  +` (green underline), chart with draggable SL/TP lines
- Hint, verbatim: `Stop Loss or Take Profit you set must differ from market price by at least 30 pips. Stops processing is performed on the broker side.`
- Single bottom button `Modify`
- Help: "The "Modify" button is disabled until you set correct values for "Stop Loss" and "Take Profit". Terms of stop levels are determined by the broker and are specified in symbol properties (specification of contracts)."

Note the mobile hint says **pips** where the desktop hint says **points**.

### 7.8 Mobile SL/TP units
Android help, Opening and Closing Positions, verbatim: "**Stop Loss** – the Stop Loss level **in prices**." — the classic mobile form is price-only, unlike desktop which is settings-dependent. Advanced Mode adds `Price` / `Pips` / `Currency` modes: "**Currency** – an approximate monetary amount in the deposit currency that you will gain or lose when the level is triggered."

### 7.9 Mobile requote / request
Same strings as desktop: tap `Accept` or `Reject`; after timeout the message `Price changed` appears and `OK` returns you to the order screen. Request mode: tap `Request`, then `Buy`/`Sell` appear for a few seconds.

---

## 8. Things I could NOT verify — do not fill these in

1. **The exact string shown in the desktop order dialog's result/status strip** after a successful or failed send. The help only says results "appear in the window". No screenshot exists.
2. **Whether `Close By` still uses a `Type:` dropdown in current builds.** The only Close-By screenshot MetaQuotes publishes is from ~2016 and predates the dialog redesign.
3. **The close-button text in Instant/Exchange execution modes** — only the `… by Market` variant is screenshotted.
4. **`Buy Stop Limit` / `Sell Stop Limit` in the mobile tab strip** — the strip scrolls and these are never visible in an official screenshot. They exist as Toolbox `Type` column values on both platforms (documented verbatim in both the desktop and Android help) but I cannot confirm their rendering in the mobile order-type strip.
5. **A "Copy as" control anywhere in MT5.** No evidence found. See 3.3.
6. **"Book or Cancel" as a live Fill policy option** — it appears once in the help prose and in no screenshot.
7. **The literal GUI short forms `Not enough money` and `Invalid volume`** as rendered in the desktop dialog (as opposed to the Journal brackets and the MQL5 doc long forms). The Android help does confirm `Invalid volume` verbatim.
8. **Any officially published hex value.** All hexes in section 6 are my pixel measurements of official screenshots, as labelled. Use the `THEME_COLOR_*` MQL5 API if you need ground truth.
9. **The `Reverse position` bulk-menu string on netting accounts** — prose only, no screenshot.
10. **Font family/size/weight** for any MT5 dialog.

## 9. Full source list
- https://www.metatrader5.com/en/terminal/help/trading/performing_deals
- https://www.metatrader5.com/en/terminal/help/trading/one_click_trading
- https://www.metatrader5.com/en/terminal/help/trading/general_concept
- https://www.metatrader5.com/en/terminal/help/startworking/settings
- Screenshots (all under https://www.metatrader5.com/i/help/terminal/en/): `order_execution.gif`, `requote.png`, `close_position.png`, `modify_position.png`, `close_by.png`, `bulk_positions.png`, `pending_order.png`, `modify_pending_order.png`, `one_click_disclaimer.png`, `chart_trading_menu.png`, `chart_oneclick_trading.png`
- https://www.metatrader5.com/c/17/1/terminal-black.png
- https://www.metatrader5.com/en/releasenotes/terminal/2393 · https://www.metatrader5.com/en/releasenotes/terminal/2430
- https://www.metatrader5.com/en/mobile-trading/android/help/trade (+ `/open_positions`, `/closeby`, `/change_positions`, `/bulk_operations`, `/pending_place`)
- https://www.metatrader5.com/en/mobile-trading/iphone/help/trade (+ `/open_positions`)
- Mobile screenshots under https://www.metatrader5.com/i/help/android/en/ and https://www.metatrader5.com/i/help/iphone/en/: `open_market.png`, `open_instant.png`, `open_exchange.png`, `open_request.png`, `open_market_extended.png`, `close_position.png`, `requote.png`, `bulk_positions.png`, `position_modify.png`
- https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes
- https://www.mql5.com/en/docs/constants/environment_state/terminalstatus
- MQL5 forum (community, Journal line formats): https://www.mql5.com/en/forum/353909 · https://www.mql5.com/pt/forum/337102 · https://www.mql5.com/en/forum/380532 · https://www.mql5.com/en/forum/290323 · https://www.mql5.com/en/forum/310532
- https://www.metatrader4.com/en/trading-platform/help/setup/setup_trade — **MT4 only**, used solely for the tail of the one-click disclaimer, flagged as such in 4.2

Working files (screenshots, extracted text, colour samples) are in `/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad/` if you want to re-check anything.

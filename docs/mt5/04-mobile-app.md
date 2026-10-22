# MetaTrader 5 MOBILE app — verified UI specification (Android + iOS)

## Method & source base

Primary sources are MetaQuotes' own mobile help trees and **the screenshots served on those pages** (I downloaded the PNGs and read them directly, and sampled pixel colours from flat fills):

- Android help root: https://www.metatrader5.com/en/mobile-trading/android/help
- iPhone/iPad help root: https://www.metatrader5.com/en/mobile-trading/iphone/help
- Screenshot assets: `https://www.metatrader5.com/i/help/android/en/<name>.png` and `.../iphone/en/<name>.png`

**Caveat that affects everything below:** MetaQuotes' mobile help is *internally inconsistent in version*. Some screenshots are current (2025–2026 dates, modern flat UI); others are from ~2017 (Material blue action bar on Android, iOS 7–10 styling). I flag which is which at each point. Where the prose and the screenshot disagree, I say so rather than picking one.

**A warning about scratchpad contamination:** the shared scratchpad contained `x_*.png` files that are *desktop* MT5 screenshots (Market Watch, Navigator, Toolbox, F9 dialog). I verified and discarded those. None of the claims below come from desktop MT5.

---

## 1. Bottom tab bar — your assumed list is WRONG

There is **no six-tab bar**, and **no app has both Messages and Settings as tabs**. Both platforms have exactly **five** tabs, and the fifth differs.

### iOS — 5 tabs
Verified from `https://www.metatrader5.com/i/help/iphone/en/quotes.png` (current build) and `.../settings.png`:

| # | Label | Icon |
|---|---|---|
| 1 | **Quotes** | down-arrow + up-arrow pair (↓↑) |
| 2 | **Chart** (singular) | two vertical candlesticks |
| 3 | **Trade** | zig-zag line inside a rounded square outline |
| 4 | **History** | clock face with a counter-clockwise arrow |
| 5 | **Settings** | gear, with a **red circular unread badge** (screenshots show "11", "2", "3", "4") |

Active tab: icon *and* label turn blue. Inactive: dark grey/near-black.

Help text confirms the list: *"Quotes… Chart… Trade… History… Settings provide access to application settings, MQL5.community chat, mailbox and news, as well as allow opening accounts or switching between available accounts."* — https://www.metatrader5.com/en/mobile-trading/iphone/help/getting_started

### Android — 5 tabs
Verified from `https://www.metatrader5.com/i/help/android/en/interface.png`, `.../quotes.png`, `.../trade.png`, `.../settings.png` (all current build):

| # | Label | Icon |
|---|---|---|
| 1 | **Quotes** | up-arrow + down-arrow pair (↑↓) |
| 2 | **Charts** (plural) | two vertical candlesticks |
| 3 | **Trade** | polyline with round nodes (no enclosing square) |
| 4 | **History** | clock face with counter-clockwise arrow |
| 5 | **Messages** | two overlapping speech bubbles, with a **red unread badge** |

### The differences that matter for you
1. **5th tab differs**: iOS = Settings; Android = Messages.
2. **Label differs**: iOS "Chart"; Android "Charts".
3. **Android additionally has a hamburger ☰ side panel** (navigation drawer) at the top-left of every main screen. iOS has no drawer at all.
4. **Settings is not reachable from the Android tab bar** — only via the drawer. **Messages is not a tab on iOS** — it lives *inside* the Settings tab.
5. Icon style differs: iOS Trade icon is enclosed in a rounded square; Android's is not. Quotes arrow order is mirrored (iOS ↓↑, Android ↑↓).

### Android side panel (drawer) — full documented list, in order
From https://www.metatrader5.com/en/mobile-trading/android/help/getting_started:
Quotes · Charts · Trade · History · Mailbox · News · Economic calendar · Messages · Traders Community · Trading applications · Settings · Journal · About

**Documentation conflict I must flag:** the Android *Quotes*, *Trade* and *History* help pages each say "To switch to this tab, use the application side panel", while the Android *Chart* page says "use the bottom panel". The current screenshots show all five in the bottom bar **and** a drawer. The prose on three pages is stale. (Compare https://www.metatrader5.com/en/mobile-trading/android/help/quotes vs .../help/chart)

---

## 2. Quotes screen

### Android row layout (Advanced / full mode)
Verified from `https://www.metatrader5.com/i/help/android/en/quotes.png` — that single image shows **both modes side by side**, which is the cleanest proof of the Simple/Advanced difference.

Two-column row, three text lines on the left, two on the right:

```
▰(corner triangle)
  +151  0.14%                        1.08 07⁶      1.08 07⁶
  EURUSD                          L: 1.07740   H: 1.08100
  15:09:42  ⌶ 0
```

- **Line 1 left**: daily change in points (`+151`) — rendered **grey** (#969696–#B4B4B4) — followed by percent (`0.14%`) rendered **blue if positive, red if negative**. I measured this; the points figure is *not* colour-coded, only the percent is.
- **Line 2 left**: symbol name, bold, largest text in the row.
- **Line 3 left**: last-quote time `15:09:42`, then a spread glyph (an I-beam: two short vertical bars joined by a horizontal rule) then the spread in points (`0`).
- **Right, line 1**: **Bid** (left) and **Ask** (right), large, with the last two digits enlarged and the final digit as a superscript. Coloured by last tick direction (blue up / red down), independently of the daily change colour.
- **Right, line 2**: `L: <day low>` under Bid, `H: <day high>` under Ask.
- **Open-position marker**: a small filled **triangle in the row's top-LEFT corner** — blue (#1C5FE9 measured) = net floating profit, red = loss. **The help text says the triangle is "on the right"** (https://www.metatrader5.com/en/mobile-trading/android/help/quotes) **but every screenshot shows it top-left.** Trust the screenshot.

Help's documented field list (verbatim): instrument name · ask price · bid price · Spread · time of last quote · Low · High.

### Android Simple (reduced) mode
Symbol name on the left; **only Bid and Ask** as two right-aligned columns. No change, no time, no spread, no High/Low. Matches the help: *"In the simple view mode only the Bid and Ask prices are shown."*

Toggled two ways:
- Settings → **"Advanced mode"** (https://www.metatrader5.com/en/mobile-trading/android/help/settings)
- Quotes row context menu → **"Advanced view mode"**

### iOS — there is no "Simple/Advanced"; it's a different concept
iOS instead toggles between a **mobile-adapted view** (default) and a **desktop-style table view**, via a button on the top-left of the Quotes screen (`quotes_mode` icon). Source: https://www.metatrader5.com/en/mobile-trading/iphone/help/quotes — *"Financial symbol quotes can be displayed in a form adapted for mobile devices (default mode) or as a table used in the desktop platform version."*

iOS default-mode row is laid out the same way as Android's advanced row (verified from `.../iphone/en/quotes.png`): change+percent above the symbol; time and spread below it; Bid/Ask large on the right with L:/H: beneath.

**iOS table mode** (verified from `.../iphone/en/quotes_columns.png`): true column headers — `Symbol | Bid | Ask | Spread | Day %`. Tap a column header to sort (1st tap ascending, 2nd descending, 3rd resets). A **Columns** editor lets you add/remove/reorder columns; enabled ones carry a red ⊖ and a drag handle, available ones a green ⊕. Documented/visible available columns: **Bid High, Bid Low, Ask High, Ask Low, Last, Last High, Last Low, Time** (list continues below the fold — I could not verify the full set). Android has **no** table mode and no columns editor.

### Adding symbols
- **Android**: there is **no search box on the Quotes list**. Top bar is `☰ | Quotes | ＋ | ✎`. Tap **＋** → "Add symbol" screen: a search field with placeholder **"Find symbols"**, then a flat list of folder rows. In the official screenshot the groups are **Forex, Metals, Indexes, Securities, Collateral** (these are broker/server-defined, not fixed). Tap a symbol's line to add it.
- **iOS**: a **permanent search box** sits at the top of Quotes with placeholder **"enter symbol for search"**. Top bar is `[view-mode icon] | Quotes | ✎`. Tapping the search box opens the group browser with a **Cancel** button; each group row shows the group name **plus its full path as a subtitle** (e.g. "Energies Futures" / "Commodities\Energies\Energies Futures") and a chevron. Official screenshot groups: Forex, Metals, Indexes, Commodities, Energies Futures, Energies Spot, Softs. Add via a **＋ icon on the symbol's row**, then tap **"Done"**.

### Editing / reordering / hiding
- Both: tap the **✎ (Modify)** button to enter edit mode.
- Android: in edit mode tap the delete button, check symbols, tap delete again; a **"Select all"** toggle exists. Reorder by pressing and dragging the move handle.
- iOS: checkmark-select, then tap the red delete icon; "Select all" icon available. Same drag handle for reorder.
- Both: a symbol cannot be hidden while it has an open position or pending order (iOS adds: or while its chart is open).

### Swipe actions on a Quotes row
- **iOS — documented**: *"Swipe left on the symbol line to open the quick commands menu"* → two icons: **new trade operation** and **open chart**. Dragging further left jumps straight to the chart. (https://www.metatrader5.com/en/mobile-trading/iphone/help/quotes)
- **Android — I could not verify any swipe action on a Quotes row.** The Android Quotes help documents only tap→context menu. Swipe-to-reveal *is* documented on Android for Trade rows, but not Quotes rows.

### Tapping a row — the context menu (exact labels, and they differ)
**Android** (https://www.metatrader5.com/en/mobile-trading/android/help/quotes), in this order:
1. **New order**  (hidden when not connected to the server)
2. **Chart**
3. **Properties**
4. **Depth of Market**
5. **Market statistics**
6. **Advanced view mode**

**iOS** (https://www.metatrader5.com/en/mobile-trading/iphone/help/quotes), in this order:
1. **Trade**  (hidden when not connected)
2. **Chart**
3. **Properties**
4. **Statistics**
5. **Depth of Market**
6. **Cancel**

So: iOS says "Trade" where Android says "New order"; iOS says "Statistics" where Android says "Market statistics"; the **order of Depth of Market vs Statistics is swapped**; Android has "Advanced view mode" and no "Cancel", iOS has "Cancel" and no view-mode item.

---

## 3. Chart screen

### Top bar — exact contents, left to right
I identified each glyph by downloading the individual icon assets and matching them against the screenshot.

**iOS** (from `.../iphone/en/chart.png`):
`H1`  |  ✛ crosshair  |  **ƒ** (italic script f = Indicators)  |  objects icon (square+circle+triangle)  |  ◐ pending-order button (red/blue circle with a white clock hand)  |  ▭ one-click-trading panel toggle (red/blue rounded rect with a white pill)

**Android** (from `.../android/en/chart.png`):
`☰` hamburger  |  ✛ crosshair  |  ∿ Indicators (a zig-zag crossed by a sine curve — this is `chart_indicators_button.png`)  |  `M30` timeframe  |  ◐ pending-order button  |  ▭ one-click-trading toggle

Differences:
- **The timeframe button is at the far LEFT on iOS and in the MIDDLE-RIGHT on Android** (because Android's far left is occupied by the drawer hamburger).
- **iOS has a dedicated Objects button in the top bar; Android does not** — on Android, graphical objects are reached through the **radial menu** only.
- The "f" indicator button exists on **both**, but is drawn as a script **ƒ** on iOS and as a **zig-zag/sine glyph** on Android.
- Android also documents a **Tile windows** button (`layout_button.png`) for multi-chart layouts — up to **4 charts on Android phones, 6 on tablets**. iOS has no equivalent on iPhone.

### Timeframes — 21, and exactly how they're chosen
Both platforms: *"21 chart timeframes"*. Verified picker contents from `.../android/en/chart_period.png`:

- **Minutes**: M1, M2, M3, M4, M5, M6, M10, M12, M15, M20, M30  (11)
- **Hours**: H1, H2, H3, H4, H6, H8, H12  (7)
- **Days**: D1, W1, MN  (3)
= 21 ✓

Interaction: tapping the timeframe button opens a **horizontal quick strip** across the top — e.g. `M1 M5 M15 M30 H1 H4 D1 W1 [⚙]` — with the current one highlighted in solid blue and a **gear at the right end = "Set up timeframes"**. The gear opens the full grouped bottom sheet above. In that sheet, **long-press adds/hides** a timeframe from the quick strip (outlined = on the strip, solid blue = currently active); **short press switches** the chart. **Maximum 9 timeframes on the quick strip.**

**Source conflict to flag:** the iOS help says *"21 chart timeframes, from 1 minute (M1) to 1 day (D1)"* (https://www.metatrader5.com/en/mobile-trading/iphone/help/chart) while Android says *"from 1 minute (M1) to a monthly one (MN)"*. 21 timeframes only reconciles with M1→MN1; the iOS "to 1 day" text is almost certainly an error. Separately, the **App Store listing claims "9 timeframes"** (https://apps.apple.com/us/app/metatrader-5/id413251709) — that matches the quick-strip limit, not the real total. Three MetaQuotes sources, three different numbers.

### One-click trading panel (shown on the chart)
Appears directly under the top bar (or at the bottom if "One Click panel at the bottom" / "Trading Panel at the Bottom" is enabled). Layout is identical on both platforms:

`[ SELL \n <bid price> ]  [ ⌄  <volume>  ⌃ ]  [ BUY \n <ask price> ]`

The word SELL / BUY is small and in the block's top-left corner; the price is large beneath it with enlarged last digits. The middle is a white volume stepper with chevron-down (decrease) and chevron-up (increase) around the lot value.

**Colour — important and counter-intuitive:** in **every** official screenshot of this panel, on **both** platforms, the SELL block and the BUY block are **the same red**, not red-vs-blue:
- Android `.../android/en/chart.png` and `.../one_click_trading.png`: both blocks **#D85852** (flat fill, ~1000+ px sampled)
- iOS `.../iphone/en/one_click_trading.png`: both blocks **#D54A36**

This is consistent with the blocks being tinted by **last tick direction** rather than by side. A third-party guide states *"A red panel means that the current currency quotation is lower than the previous one"* (https://myforex.com/en/mt5guide/oneclick-trading-sp.html, surfaced via search). **I could not find an official MetaQuotes screenshot or sentence confirming a blue state**, so treat the tick-direction explanation as a well-supported inference, not documentation.

If "One Click Trading" is **off** in settings, tapping BUY/SELL opens the trading dialog instead of firing immediately.

### Chart context menu (exact labels)
- **iOS** — a real context menu (https://www.metatrader5.com/en/mobile-trading/iphone/help/chart): **Trade · Indicators · Objects · Settings · Cancel**  ("Trade" hidden when disconnected.)
- **Android** — a **radial menu**, opened by tapping the chart. Documented capabilities: change the timeframe · attach indicators · apply objects · enable crosshairs · open chart settings. **The Android help does not give textual labels for the radial items** (they are icons), and `circle_menu.png` is low-resolution; I could not verify per-item labels on Android.

### Gestures — exactly as documented
Both platforms:
- **Horizontal drag** = scroll through time.
- **Pinch** = zoom. Documented verbatim as: *"to zoom in, place two fingers together on the area of the chart you want to zoom in and then drag your fingers apart. To zoom out, place two fingers on different parts of the screen and drag them towards each other."*
- **Free 2-D movement is the default** — the chart can be dragged **vertically as well as horizontally**. There is an **"Auto-scale"** mode that restricts movement to horizontal only and auto-fits the price range; **"Free chart movement"** returns to 2-D. **"Reset vertical scale"** restores the original scale. (Both platforms.)
- **Rotate to landscape** = full-screen mode, automatically. On iOS you can then toggle full-screen/normal by tapping the chart.
- **Crosshair**: *tap the crosshair button in the top bar* (it is **not** a long-press to activate). Then drag the crosshair. Tap a second point to measure: a rectangle highlights the span and a caption shows **vertical distance in points, percentage change and price difference; horizontal distance in bars and the time difference** (Android wording). iOS wording: *"number of points, change in percentage, number of bars."*
- **Long-press (~1 s)** differs by platform:
  - **Android**: enters **subwindow-resize mode** — drag a subwindow's upper border.
  - **iOS**: opens the **Data Window** temporarily — move the cursor, release to return to normal.

### Chart types (both platforms)
Bar chart · Candlestick · Line chart · **Heikin Ashi** (Heikin Ashi is in the help prose on both; note the prose oddly says "three chart types available" then lists four).

### Chart indent differs
- **Android**: scroll left; wherever you leave the last bar becomes the fixed indent, persisted across timeframe/symbol changes and chart reopen.
- **iOS**: scroll to the last price until a vertical separator appears, then **drag a triangle on the bottom scale** to set the indent.

### On-chart trading
- Both: tap the pending-order button, then **drag the new order level**; direction (Buy/Sell) is decided by whether the level sits above or below the current price. Tap **"SL"** / **"TP"** then drag those levels; as you drag, potential P/L shows **in points and in money**.
- **Confirmation gesture differs**: **Android uses tap buttons** ("Continue", "Modify", "Delete", "Close"). **iOS uses slide-to-confirm sliders** (`send_pending_order_slider`, `delete_pending_order_slider`, `modify_pending_order_slider`, `close_position_slider`, `modify_position_slider`).
- **iOS only**: a documented 3-state auto-scale button for level dragging — **"Show trading levels" / "Free move" / "Auto-scaling"**.
- **Android only, documented**: a **"Go to…"** button briefly shown at the lower-left when a timeframe switch moves your scroll date off-screen. (iOS documents the same behaviour and button.)

---

## 4. Trade screen

### Top bar
- **Android**: `☰` | title "**Trade**" (small) with the **total floating profit beneath it in blue** ("34.95 EUR") | sort button (↑↓) | new-order button (document-with-＋ icon).
- **iOS**: account-card icon (left) | **total floating profit centred in blue** ("130.00 USD") | **＋** (new order). iOS also documents a **deposit/withdraw** button and a **bulk-operations "•••"** in each section header.

### Account summary block — exact labels and order
Both use `Label:` on the left and a right-aligned value. **Android draws a dotted leader between them; iOS does not.** Thousands are separated by a space (`9 862.16`, `100 065.70`).

Verified from `.../android/en/trade.png`:
```
Balance:            9 862.16
Equity:             9 897.11
Margin:             2 165.03
Free margin:        7 732.08
Margin Level (%):     457.14
```
Verified from `.../iphone/en/trade.png`:
```
Balance:           99 943.90
Commission:            -8.20
Equity:           100 065.70
Margin:               432.77
Free Margin:       99 632.93
Margin Level (%):  23 122.14
```

Note the casing difference: Android **"Free margin:"**, iOS **"Free Margin:"**. Both use **"Margin Level (%):"**.

The visible rows are conditional on the account — the full documented set, in help order, is: **Profit (+ currency) · Balance · Credit · Assets · Liabilities · Commission · Blocked · Equity · Margin · Free Margin · Margin Level · Total of deals**. Android help adds: ***"If the account gets 'Margin Call', the margin fields are highlighted in red."***

### Position rows — exactly what each line shows
Section header band **"Positions"**, then rows. Two lines on the left, profit right-aligned:

**Android**: `GBPUSD, buy 1.00` / `1.26622 → 1.26673` · right: `46.91`
**iOS**: `AUDUSD sell 1` / `0.76386 → 0.76256` · right: `130.00`

- Line 1: **symbol in bold black**, then the side+volume. **Android inserts a comma after the symbol; iOS does not.** Android formats volume to 2 dp ("1.00"); the iOS screenshot shows "1".
- Side word is coloured: **buy = blue, sell = red**.
- Line 2: **open price → current price**, grey, with a literal arrow glyph.
- Right: **profit/loss**, same size as the symbol, **blue when positive, red when negative** (not green/red — MT5 mobile uses blue for gains).

Section header **"Orders"**, then order rows:
**Android**: `GBPUSD, buy limit` / `1.00 / 0.00 at 1.26235` · right: `placed` (grey)
**iOS**: `EURCAD buy limit` / `1 / 0 at 1.54633` · right: `placed` (**blue** on iOS)

The `x / y at price` is *requested volume / filled volume at trigger price*. Help: *"When approaching the market, the order background is colored in green"* — visible in the iOS screenshot as a **green vertical bar on the row's left edge**.

### Tapping a position
**They behave differently — this is the biggest Trade-screen divergence.**

- **Android**: a **single tap expands the row inline**; a **long press (~1 s) opens the context menu**.
- **iOS**: *"To open the context menu, tap on the trading operation line in the list."* The current iOS screenshot shows a tap producing an **expanded detail card with action buttons at its foot** ("Chart", "Trade" stacked as blue text buttons). The iOS help is self-contradictory here — it says both that a tap expands details and that a tap opens the context menu. **I could not fully resolve iOS tap behaviour**; the expanded-card-with-buttons pattern is what the newest screenshot shows.

**Expanded position card — Android** (verified from `.../android/en/position_details.png`, which is an annotated diagram):
```
EURUSD  buy 1.00                            13.00
1.12762 → 1.12775
2015.01.23 11:12:04, My comment
S / L:   1.12562        Swap:        0.00
T / P:   1.12962                #52763705
```

**Expanded position card — iOS** (`.../iphone/en/position_details.png`):
```
EURUSD, buy 1.00                      #165777142
Euro vs US Dollar
1.18583 → 1.18888                         305.00
Δ = 305 (0.26%) ⌃
S/L:  1.19011                  Swap:  -9.80
T/P:  1.19262        2017.08.31 17:10:03
Opened from desktop
```
iOS extras Android lacks: the **symbol description line**, the **Δ row** (points + percent with a direction caret), and the **ticket at top-right** (Android puts the ticket bottom-right).

### Position context menu — exact items
**Android** (https://www.metatrader5.com/en/mobile-trading/android/help/trade):
- **Close position**
- **New order**  (symbol and volume pre-filled from the position)
- **Modify position**  (edits SL and TP)
- **Chart**

Order context menu (Android): **Modify order · Delete order · Chart**

**iOS**: the help does not enumerate the context-menu items as text; it says *"The same commands are available in the context menu"* as the swipe menu. **I could not verify the exact iOS position context-menu labels.**

### Swipe-left on a Trade row (quick commands)
**Android** — a **blue bar** slides over the row's right side with 6 white icons, in this documented order (confirmed visually in `.../android/en/position_menu.png`):
1. **Close By** (hedging accounts only, and only if an opposite position on the same symbol exists)
2. **Close position / delete order**
3. **Edit position / order**
4. **Increase position / place order**
5. **Open Chart**
6. **Depth of Market**

**iOS** — only **3** icons: **context menu (•••) · modify · close**. Plus: *"By dragging the menu further to the left, you can immediately switch to order closing or canceling screen."*

### The "Close position" screen — exact layout
**Android** (verified from `.../android/en/close_position.png`), top to bottom:
1. `←` back | title **"Close position #57040054558"** bold | subtitle **"buy 0.61 GBPUSD at 1.33629"**
2. **Volume stepper** — a row of adaptive tap-steps: `-0.5  -0.1  -0.01  **0.61**  +0.01  +0.1  +0.5`. The current volume is bold black in the centre; the steps are blue. **The ＋ steps are greyed out/disabled** because you cannot close more than the open volume.
3. Bid and Ask, large, side by side (blue here = up tick).
4. **SL and TP controls** side by side: `−  <value>  +` with an **orange underline** for SL and a **green underline** for TP. When unset the control reads just "SL" / "TP".
5. `Fill policy` ............ `Fill or Kill`
6. **Tick chart** filling the middle, with the live price in a red tag on the right axis.
7. Warning: *"Attention! The trade will be executed at market conditions, difference with requested price may be significant!"*
8. **The close button**: centred, all-caps, **text-only (no fill)**, reading **"CLOSE WITH PROFIT 334.89"** in **orange — measured #FF9300**.

**iOS** (verified from `.../iphone/en/close_position.png`): the close action is **not a separate screen layout** — it is the standard order screen with an extra **full-width amber bar** beneath the Sell/Buy buttons reading:
**"Close #6778646242 buy 7 by Market with Profit 3 421.63"** — fill measured **#E19334**.

**From the chart**, closing looks different again:
- **Android**: bottom panel with an **orange outlined pill "CLOSE BUY 0.61"** (outline ≈ #EF9C20), a round red **SL** chip (#DD5B4E), a round green **TP** chip, and a blue **→** button; below are two tabs **"Close position"** (orange, active) / **"Modify position"** (grey).
- **iOS**: bottom sheet with an **orange filled button "Close buy 7.00"** (#E19334) beside a greyed-out **"Modify"**.

So the close button's wording is **"CLOSE WITH PROFIT <amount>"** (Android, orange text) / **"Close #<ticket> <side> <volume> by Market with Profit <amount>"** (iOS, amber bar) / **"CLOSE BUY <volume>"** / **"Close buy <volume>"** on-chart. There is no single string.

---

## 5. New Order screen

There are **two distinct new-order UIs** on each platform. Getting this right matters a lot for a phone-first product.

### 5a. The classic full-screen order ticket

**Android** (`.../android/en/open_market.png`), field order top → bottom:
1. Header: `←` | **symbol** bold + description subtitle | top-right icon (switches to the extended/advanced dialog)
2. **Order type selector** — full-width row, centred text, e.g. **"Market Execution"**, with a small triangle at the right edge
3. **Volume stepper**: `-0.5  -0.1  -0.01  **0.61**  +0.01  +0.1  +0.5` — steps are adaptive to the current value; tap the centre value to type on the keyboard
4. **Bid / Ask**, large, side by side
5. **SL and TP**: `−  SL  +` with **orange** underline, `−  TP  +` with **green** underline
6. `Fill policy` ............ `Fill or Kill`
7. **Tick chart**
8. Warning line
9. **Buttons at the very bottom — text-only, two lines each**: **"SELL" / "BY MARKET"** in red (≈#D00000) and **"BUY" / "BY MARKET"** in blue (≈#0064F2), separated by a thin divider

**iOS** (`.../iphone/en/open_market.png` and `market_execution.png`), field order:
1. Header: `‹` circular back | **"EURGBP ⌄"** + description subtitle
2. **"Market Execution"** row with a ⌄ chevron at the right
3. **Volume stepper**: `-5  -1  **7.00**  +1  +5`
4. **"Stop Loss"**  `−`  value (**red**)  `+`
5. **"Take Profit"**  `−`  value (**green**)  `+`  — shows **"not set"** in grey when empty
6. `Fill Policy` ............ `Fill or Kill`
7. **Bid / Ask**, large
8. **Buttons — full-width filled rectangles side by side**: **"Sell by Market"** on red **#CE6555**, **"Buy by Market"** on blue **#5C91ED**
9. Warning line

Key ordering difference: **iOS puts SL/TP above the prices and the buttons; Android puts SL/TP below the prices and the buttons at the very bottom under a tick chart.** iOS labels them in full ("Stop Loss"/"Take Profit") and always shows their value inline; Android abbreviates to "SL"/"TP".

### 5b. The modern "Advanced mode" trading dialog (used from the chart)
This is the newer design and is near-identical on both platforms. Verified from `.../android/en/open_market_extended.png` and `.../iphone/en/market_execution.png`.

Field order, top → bottom:
1. Drag grabber (the sheet can be minimised, expanded, or dragged to full screen; tapping outside minimises, tapping again hides)
2. **Symbol ⇅** (tap to switch instrument) + description, with **Bid and Ask on the right**
3. **Order-type tab strip**, horizontally scrollable: **Market Execution · Buy Limit · Sell Limit · Buy Stop · Sell Stop …** (active one bold/dark)
4. **Volume** row: label, value with a ⇅ stepper, and a **unit selector "Lots ⇅"** — the second unit mode is **Margin** (volume expressed as the approximate margin to be reserved)
5. **Volume slider** (min/max computed automatically)
6. `Margin = 707.57 USD` (the word *Margin* is a blue link that switches mode) · right: `Free: 96 703.57 USD`
7. **Segmented control: "Price" | "Pips"** — and the help documents a **third mode, "Currency"** (an approximate money amount), so the real set is **Price / Pips / Currency**
8. **SL and TP row**: Android shows a **red "SL" chip (#DD5B4E)** and a **green "TP" chip (#0EB52E)** each with a value + ⇅ stepper; iOS shows a **green ✓ "T/P"** and a **red ✓ "S/L"** with values
9. Beneath them, the **money value of each level** — loss in red on the SL side, profit in green on the TP side
10. `Fill policy: Fill or Kill ⇅`
11. `Comment: Add comment` (blue link; **max 31 characters**)
12. **Buttons: "Sell" and "Buy"**, full-width filled, side by side:
    - Android: Sell **#E5461E**, Buy **#1C7CDD**
    - iOS: Sell **#CF5F4E**, Buy **#3478F6**
13. The live chart below, with draggable TP (green dashed + green tag), SL (orange/red dashed + tag), and bid/ask price tags

Documented behaviours worth copying:
- A **lock button** fixes the **TP:SL ratio** — adjust one and the other follows, including while dragging on the chart; the setting persists across orders.
- Levels default as for a **buy** (TP above price, SL below). **If you then tap Sell, the app swaps them automatically.** If you manually invert them, **only the Sell button stays enabled and Buy is disabled**, on the assumption you meant it.
- Invalid fields are **highlighted in red** and the trade buttons go inactive.
- Last-used volume and SL/TP (**stored in pips** and converted to price) are restored on the next order. Only the most recent values are kept — **not per symbol**.
- Volume is **synchronised between this dialog and the one-click chart panel**, both directions.

### Buy/Sell button wording by execution mode
The button text is **not constant** — it changes with the symbol's execution mode (https://www.metatrader5.com/en/mobile-trading/android/help/trade/open_positions):
- **Instant Execution** → **"Buy"** / **"Sell"**, plus an extra **"Deviation"** field (max acceptable slippage)
- **Request Execution** → first a **"Request"** button; *then* "Buy"/"Sell" appear for a few seconds
- **Market Execution** → **"Buy by market"** / **"Sell by market"**
- **Exchange Execution** → **"Buy"** / **"Sell"**

### Confirmation / result
Documented, both platforms: *"Once an order is sent, its execution results will appear in the window: either confirmation of a successful trade or a rejection with the reason specified."* The filled position then appears on Trade, and the order + deal(s) on History.

**Requote flow (Instant Execution only)**: if price moves beyond Deviation, the dealer returns new prices in the order window with **"Accept"** and **"Reject"** buttons. They are valid a few seconds; on timeout a **"Price changed"** message appears and **"OK"** returns you to the order screen. (`.../android/en/requote.png`)

Android chart extra: trade results can appear as **pop-up notifications on the chart** — enabled by the **"Trade notifications"** chart setting.

---

## 6. History screen

### The Positions/Orders/Deals toggle
Three modes on both platforms, switched **at the top of the tab**.
- **iOS (current)**: an iOS **segmented control** reading **"Positions | Orders | Deals"** (title case), with a **clock icon on the right** for the period filter and a **sort icon on the left**. Verified from `.../iphone/en/history_positions.png` (2025 dates).
- **Android**: the available screenshots are the **2017 build** — Material uppercase tab strip **"POSITIONS | ORDERS | DEALS"** under a blue action bar. **I could not verify the current Android History chrome**; the current Android build is certainly flat-white like its Quotes/Trade screens, but MetaQuotes has not refreshed these particular screenshots. Treat Android History styling as unverified.

Note the ordering: the help prose on both platforms says *"Orders, Deals and Positions"*, but **every screenshot shows Positions first**. Trust the screenshots.

### Period filter — exact option strings (and they differ)
**iOS** (`.../iphone/en/history_period.png`) — a modal with nav bar `‹ History | History | Done`:
- A **`Symbol:` row** with value `All symbols` (iOS can filter history by symbol)
- Then: **Last week · Last month · Last 3 months · Last 6 months · Last year · Custom**
- Selected row carries a blue ✓. "Custom" adds **"From"** and **"To"** fields. Confirm with **"Done"**.

**Android** (`.../android/en/history_period.png`, 2017 build) — a dropdown from a calendar icon; each row has an icon, a title and the resolved date range as a subtitle:
- **Today** · **Last week** · **Last month** · **Last 3 months** · **Custom period**
- Selected row carries a blue ✓. "Custom period" prompts for start and end.

So: **Android has "Today" and "Custom period"; iOS has "Last 6 months", "Last year" and "Custom", and a Symbol filter.** Android lacks a documented symbol filter. **The Android list may have grown since 2017 — I could not verify it against a current build.**

### Sorting
- **Android**: sort button in the top bar → **Symbol · Ticket · Open time · Close time · Profit** (verified in the 2017 screenshot); tap again to reverse. (The Trade tab's sort offers **symbol, ticket, time, profit**, applied separately to positions and orders.)
- **iOS**: a sort control sits at the top-left of History. **I could not verify the iOS sort option strings.**

### Row layouts
**Positions (iOS, current)** — two lines left, two right:
```
EURUSD sell 0.52                           2.86
1.09234 → 1.09234          2025.03.11 18:04:07
```
Symbol bold black; side+volume coloured (buy blue / sell red); open→close price grey; **profit top-right (blue/red)**; **close date-time bottom-right**.
A **red or green vertical bar on the row's left edge** marks positions closed by **Stop Loss (red) / Take Profit (green)**.

Tapping a row expands a detail card: ticket top-right, symbol description, `open → close` price, profit, **`Δ = 6 (0.00%)`**, the open→close timestamp pair, `S/L:` and `T/P:`, `Swap:` and `Charges:`, `Profit`, and **"Chart" / "Trade"** action buttons.

**Orders (Android, 2017 build)**:
```
EURUSD, buy              2017.06.07 11:51:19
0.50 / 0.50 at 1.1265                 FILLED
```
State shown in grey uppercase at bottom-right (`FILLED`, `CANCELED`).

**Deals (iOS)**:
```
EURUSD, buy, in          2017.06.26 16:54:03
0.57 at 1.12104
```
with profit in blue/red at the right on exit deals. Direction is **"in" / "out" / "in/out"**.

Colour rules documented for both: deals executed by **Stop Loss are coloured red**, by **Take Profit green**; same for the S/L and T/P values on order rows.

### Summary figures — top vs bottom, and this differs by platform
- **Orders mode**: Android — *"The following summary information is displayed in the **upper part**: the number of filled and canceled orders and the total number of orders."* Screenshot shows `Filled: 22 / Canceled: 5 / Total: 27` with dotted leaders and blue values **at the top**. iOS — *"displayed at the **bottom** of the screen: the total number of orders, and the number of filled and canceled orders."*
- **Deals mode**: both put it at the bottom. Exact labels, in order: **Deposit · Profit · Swap · Commission · Balance**. (Android help says "appear at the bottom part"; iOS says "In the bottom line".) The iOS screenshot confirms this five-row block at the foot.
- **Positions mode**: no summary block is documented.

### iOS-only: swipe on a history row
*"Swipe left on the operation line to open the quick commands menu"* → **new trade operation** and **open chart** icons; drag further left to jump straight to the chart. Not documented for Android.

---

## 7. Messages and Settings

### Messages
Same feature on both, reached differently: **Android — bottom tab (5th) or side panel**; **iOS — inside the Settings tab**.

Everything appears as **chats**, distinguished by avatar. Documented categories, in help order (identical on both platforms):
1. **Chat** — MQL5.community users (avatar from their profile, or auto-generated from initials)
2. **Broker** — messages from your broker
3. **Terminal** — push notifications sent from the desktop platform
4. **Community** — MQL5.community services: Freelance comments, Code Base / Market / Signals status changes, new publications
5. **Virtual hosting** — VPS rental, cancellation, platform updates
6. **Other**

Other documented behaviour:
- **MetaQuotes ID** is the per-install identifier used like a phone number to address pushes.
- Unread count shown next to the category title; **a blue circle to the right of a chat means it has new messages** (Android).
- Search: **Android** — a search button in the top bar. **iOS** — *"Drag the list of chats downwards and type the text"* (pull-to-reveal search).
- Delete: **Android** — long-press a chat → "Delete"; swipe right-to-left on a category then "Delete" removes all its messages. **iOS** — not documented in equivalent detail.
- MQL5 chat requires **"Sign In"** with MQL5.community credentials. The (older) Android screenshot shows an amber **"REGISTER"** button and a blue text **"SIGN IN"** button pinned at the bottom.
- Badges: Android shows the unread count on the **Messages tab**; iOS shows it on the **Settings tab icon**, the **app icon**, and in the settings menu, plus a "jump to last unread message" button.

**The Android Messages screenshot is the old blue-action-bar build** — I could not verify the current Android Messages chrome.

### Settings — these are two completely different screens

**iOS Settings is a navigation hub, not a preferences list.** Verified from `.../iphone/en/settings.png` — a grouped iOS table with coloured rounded-square icons and chevrons:

*Account card (top):* `John Smith` / `40739870 - MetaQuotes-Demo` / `Access Point EU 3`, with a green **"Demo"** corner ribbon and a chevron → opens saved-accounts management.

*Group 1:*
- **New Account** (green person+)
- **Mailbox** (blue envelope) — subtitle shows the latest mail
- **News** (orange) — subtitle shows the latest headline
- **Tradays** (red) — subtitle "Economic calendar"

*Group 2:*
- **Chat and Messages** (blue thumbs-up) — subtitle "Sign in to MQL5.community!"
- **Traders Community** (MQL5 logo)

*Group 3:*
- **OTP** (green key) — subtitle "One-time password generator"
- **Interface** (blue A/文) — subtitle shows the current language, e.g. "English"
- **Charts** (blue candles)
- **Journal** (grey lines)
- **Settings** (gear)

**Flag:** the iOS help's prose lists this row as **"Messages"** (*"Messages – the history of received push notifications"*) while the screenshot on that same page reads **"Chat and Messages"**. The screenshot is newer. Source: https://www.metatrader5.com/en/mobile-trading/iphone/help/settings

The *inner* **Settings → Settings** screen holds the actual preferences: **Sounds · Disable Auto-Lock · Enable News · News Languages · Certificates · Storage**, plus **Screen Lock** (4-digit PIN / Face ID / Touch ID; the same PIN guards the OTP generator) and a **"Rate"** button. Source: https://www.metatrader5.com/en/mobile-trading/iphone/help/settings/settings_about

**There is no interface theme row anywhere in the documented iOS settings.**

**Android Settings is a flat preferences list.** Documented items in help order (https://www.metatrader5.com/en/mobile-trading/android/help/settings):
1. **Advanced mode** — full vs short Quotes representation
2. **Order sounds**
3. **One Click Trading** — requires accepting special terms; documented as available in the Depth of Market (and, per the chart page, the on-chart panel)
4. **MetaQuotes ID**
5. **Vibration** — never / silent mode only / always
6. **Notification ringtone**
7. **Download content automatically** — Never / Use Wi-Fi only / Always
8. **OTP**
9. **Screen Lock**
10. **Language** — "25 languages"
11. **Enable News**
12. **Tablet Interface**
13. **Choose theme** — *"color scheme for the application interface: light or dark. The color scheme selected in the system settings of the mobile device is applied by default."*

The screenshot (`.../android/en/settings.png`) is **scrolled past the top**, so I can only verify from "MetaQuotes ID" down. What it does confirm is that the list is **grouped under uppercase section headers** with secondary subtitle text under each label, and that some rows use **checkboxes** on the right:
- `MetaQuotes ID` / "Use this ID to send messages to this device via notify service." → value `1537CB61` in blue
- `Vibration` / "Always"
- `Notification ringtone` / "Default (Eureka)"
- `Content auto-download` / "Always"   ← note: the screen says **"Content auto-download"**, the help prose says **"Download content automatically"**
- **SECURITY**: `OTP` / "One-time Password Generator"; `Lock Screen` / "Lock screen when the app is hidden and request pin or biometrics on start" + checkbox
- **NEWS**: `Enable News` / "Receive news updates" + checked blue checkbox
- **INTERFACE**: `Language` / "System language"; `Tablet Interface` / "Enable tablet interface" + checkbox; `Choose theme` / "Light"

**I could not verify the section headers above SECURITY** (the ones that would cover Advanced mode, Order sounds, One Click Trading, MetaQuotes ID and the notification rows) — no screenshot shows the top of that list.

Against your assumed Settings list: **"New order by default" does not exist on either platform.** "One-click trading" exists on both (Android Settings; iOS Charts settings). "Charts settings" exists as a separate screen on iOS (Settings → Charts) but on Android chart settings live **in the chart's radial menu**, not in app Settings. "Journal" exists on both. "Interface language" is **"Language"** on Android and **"Interface"** on iOS. "Theme/Colour scheme" is **"Choose theme"** on Android and **absent** on iOS. "Security" is a **section header** on Android, not a row. "About" is a **side-panel item** on Android and the **Settings → Settings** screen on iOS.

---

## 8. Colours and theme

### What is documented vs what I measured
**Nothing about the app-chrome colours is documented in hex by MetaQuotes.** The only documented colour facts are:
- Android Settings → **"Choose theme"**: *light or dark*, defaulting to the device setting. (https://www.metatrader5.com/en/mobile-trading/android/help/settings)
- The Android release announcement: *"The entire interface has been redesigned with special attention to color selection… The app now supports a dark theme that activates automatically when you enable the dark theme on your device"* — https://www.metatrader5.com/en/news/2327 (6 November 2023). Search results also indicate the Android dark theme requires **Android 10+**.
- **Chart colour schemes, by name** — these *are* documented:
  - **Android**: "Green on Black", "Black on White", "Color on White", **"custom"** (custom unlocks a **Background** colour, plus Foreground, Grid, Volumes, Bar up, Bar down, Bull candle, Bear candle, Line chart, Bid price line, Ask price line, Last price line, Stop Loss line, Stop Loss line text, Take Profit line, Take Profit line text, Sell line, Sell line text, Buy line, Buy line text, Stop Limit Price line) — https://www.metatrader5.com/en/mobile-trading/android/help/chart
  - **iOS**: only **"Green on Black"** and **"Black on White"**, with a shorter element list (Foreground, Grid, Bar up, Bar down, Bull candle, Bear candle, Line chart, Volumes, Bid price line, Ask price line, Trade levels, Stop levels) — https://www.metatrader5.com/en/mobile-trading/iphone/help/settings/settings_charts

  Note this is the **chart** scheme, which is independent of the app's light/dark interface theme.

### Measured values — ESTIMATED FROM OFFICIAL SCREENSHOTS, not documented
All of the following I sampled myself from the PNGs on metatrader5.com. Values marked **[flat fill]** come from solid button/chip fills of 150–3,300 pixels and are reliable to within a shade. Values marked **[text]** come from antialiased glyphs and are approximate — the true ink is likely slightly more saturated than the sample.

**Light theme (the only theme MetaQuotes ships screenshots of).**

| Element | Platform | Hex | Confidence |
|---|---|---|---|
| New-order **Buy** button (modern dialog) | Android | **#1C7CDD** | [flat fill] |
| New-order **Sell** button (modern dialog) | Android | **#E5461E** | [flat fill] |
| New-order **Buy** button (modern dialog) | iOS | **#3478F6** | [flat fill] |
| New-order **Sell** button (modern dialog) | iOS | **#CF5F4E** | [flat fill] |
| "Buy by Market" button (classic ticket) | iOS | **#5C91ED** | [flat fill] |
| "Sell by Market" button (classic ticket) | iOS | **#CE6555** | [flat fill] |
| **SL** chip | Android | **#DD5B4E** | [flat fill] |
| **TP** chip | Android | **#0EB52E** | [flat fill] |
| SL underline (classic ticket) | Android | **#EF853A** | [flat fill] |
| TP underline (classic ticket) | Android | **#54BE66** | [flat fill] |
| One-click panel block (down-tick state) | Android | **#D85852** | [flat fill] |
| One-click panel block (down-tick state) | iOS | **#D54A36** | [flat fill] |
| Close-position amber bar / button | iOS | **#E19334** | [flat fill] |
| "CLOSE WITH PROFIT" text | Android | **#FF9300** | [text, dense] |
| On-chart "CLOSE BUY" outline | Android | ≈ **#EF9C20** | [text/stroke] |
| Volume slider / accent blue | Android | **#4B93FF** | [flat fill] |

**Profit / loss and Buy / Sell text on the Trade screen** — note MT5 mobile uses **blue for gains, not green**:

| Element | Platform | Hex | Confidence |
|---|---|---|---|
| Profit figure, "buy" side word, header total | Android | ≈ **#1A5EE7 – #2163E8** | [text] |
| Loss figure | Android | ≈ **#BA0000** | [text] |
| "sell" side word | Android | ≈ **#C42315** | [text] |
| Profit figure, "buy limit", header total, active tab | iOS | ≈ **#0053F3 / #0053F4** | [text, repeated across 3 samples] |
| "sell" side word, loss figure | iOS | ≈ **#CB220A – #D3412C** | [text] |
| Quotes open-position triangle (profit) | Android | ≈ **#1C5FE9** | [text/shape] |
| Unread badge | iOS | ≈ **#E83523 – #EB4D3D** | [text, small] |
| Unread badge | Android | ≈ **#D6524C** | [text, small] |

**Rules, not just values:**
- **Buy = blue, Sell = red/orange-red**, consistently, in buttons and in the side word on rows.
- **Profit = blue, Loss = red.** Green is reserved for **Take Profit** levels and for **history rows closed by TP**; red doubles as both "loss" and "Stop Loss".
- **Orange/amber is the dedicated "close position" colour** on both platforms — it is used nowhere else.
- Bid/Ask prices in Quotes and on order screens are coloured by **last tick direction** (blue up / red down), *not* by which side they are.
- In the Quotes row, the **points change is grey and only the percentage is colour-coded**.

### Dark theme — what I could NOT verify
**Every screenshot in the MetaQuotes mobile help tree, for both platforms, is light theme.** I scanned all 60+ downloaded assets by mean luminance; the darkest is a 2017 Android screenshot with a blue action bar, not a dark theme. I also attempted to pull the Google Play listing screenshots — the page renders its gallery client-side and I could not extract the app's own screenshot URLs from the served HTML.

Therefore:
- **I cannot give you any dark-theme hex values.** Any dark-mode palette I produced would be invention.
- **Android dark theme is confirmed to exist** (Settings → "Choose theme" → light/dark, system default; Android 10+).
- **iOS dark theme is confirmed to exist but is NOT a setting** — it follows the system appearance automatically. Supporting evidence is release-note level rather than help-page level (MetaQuotes release notes reference a fix for "display of time in the Chart section when using the dark interface theme in the iPhone/iPad version"; the Android announcement at https://www.metatrader5.com/en/news/2327 states the auto-activation behaviour). **The iOS help's Settings pages list no theme row at all**, which is consistent with "system-driven, no in-app control" but is not positive confirmation.

---

## Things I explicitly could not verify

1. **Dark-theme colours** for either platform — no official screenshot exists (see §8).
2. **The current Android History and Messages screens** — MetaQuotes still serves 2017-era screenshots for these; only the prose is current.
3. **The top of the Android Settings list** (items above "MetaQuotes ID") and its section headers — the one screenshot is scrolled past them.
4. **The iOS position/order context-menu item labels** — the help says they mirror the swipe menu but never enumerates them.
5. **The iOS History sort options.**
6. **Swipe actions on Android *Quotes* rows** — documented for iOS Quotes and for Android *Trade* rows, but not for Android Quotes.
7. **Android radial-menu item labels** — they are icon-only and the reference image is too low-resolution.
8. **A blue state of the one-click trading panel** — all official screenshots show both blocks red; the tick-direction explanation is a well-supported inference, not documentation.
9. **Whether the Android History period list has gained "Last 6 months"/"Last year"** since the 2017 screenshot.

## Source conflicts you should know about

- Three different timeframe counts across MetaQuotes' own properties: 21 (both help pages), "M1 to D1" (iOS help, incompatible with 21), and "9 timeframes" (App Store listing, which actually describes the quick-strip cap).
- Android help says the Quotes open-position triangle is "on the right"; every screenshot puts it top-left.
- Three Android help pages say navigation is via the side panel; the Chart page and all current screenshots say bottom panel. Both exist on Android — the prose is just stale.
- iOS help prose says "Messages"; the screenshot on the same page says "Chat and Messages".
- Android Settings prose says "Download content automatically"; the screen says "Content auto-download".
- Help prose on both platforms orders the History modes "Orders, Deals, Positions"; every screenshot shows "Positions, Orders, Deals".

## Primary source URLs

Android: [help root](https://www.metatrader5.com/en/mobile-trading/android/help) · [getting_started](https://www.metatrader5.com/en/mobile-trading/android/help/getting_started) · [quotes](https://www.metatrader5.com/en/mobile-trading/android/help/quotes) · [chart](https://www.metatrader5.com/en/mobile-trading/android/help/chart) · [trade](https://www.metatrader5.com/en/mobile-trading/android/help/trade) · [trade/open_positions](https://www.metatrader5.com/en/mobile-trading/android/help/trade/open_positions) · [history](https://www.metatrader5.com/en/mobile-trading/android/help/history) · [messages](https://www.metatrader5.com/en/mobile-trading/android/help/messages) · [settings](https://www.metatrader5.com/en/mobile-trading/android/help/settings)

iOS: [help root](https://www.metatrader5.com/en/mobile-trading/iphone/help) · [getting_started](https://www.metatrader5.com/en/mobile-trading/iphone/help/getting_started) · [quotes](https://www.metatrader5.com/en/mobile-trading/iphone/help/quotes) · [chart](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart) · [trade](https://www.metatrader5.com/en/mobile-trading/iphone/help/trade) · [trade/open_positions](https://www.metatrader5.com/en/mobile-trading/iphone/help/trade/open_positions) · [history](https://www.metatrader5.com/en/mobile-trading/iphone/help/history) · [settings](https://www.metatrader5.com/en/mobile-trading/iphone/help/settings) · [settings/settings_charts](https://www.metatrader5.com/en/mobile-trading/iphone/help/settings/settings_charts) · [settings/settings_about](https://www.metatrader5.com/en/mobile-trading/iphone/help/settings/settings_about) · [settings_messages](https://www.metatrader5.com/en/mobile-trading/iphone/help/settings_messages)

Other: [App Store listing](https://apps.apple.com/us/app/metatrader-5/id413251709) · [Google Play listing](https://play.google.com/store/apps/details?id=net.metaquotes.metatrader5) · [Android redesign + dark theme announcement](https://www.metatrader5.com/en/news/2327)

All screenshots cited are at `https://www.metatrader5.com/i/help/android/en/<name>.png` and `https://www.metatrader5.com/i/help/iphone/en/<name>.png` — the filenames are given inline throughout.
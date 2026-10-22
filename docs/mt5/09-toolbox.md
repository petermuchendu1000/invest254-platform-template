# MT5 Toolbox window and all twelve tabs — verified specification

Researched 2026-10-05 from MetaQuotes' own MT5 help, the MT5 release notes, the mobile help
and MetaQuotes' own help screenshots read pixel by pixel after 2.5–12× upscaling. Every claim
carries a source. Where a fact could not be established this document says so rather than
filling the gap, and the gaps are listed in "Could not verify" at the end. MT4 material is not
mixed in anywhere.

**There is no "Toolbox" help page.** `startworking/toolbox`, `start_advanced/toolbox` and
`terminal/help/toolbox` are all 404. The window is described in four paragraphs on
[`startworking/interface`](https://www.metatrader5.com/en/terminal/help/startworking/interface)
and nowhere else; each tab's content is documented on the page for the *subject* of that tab
(positions, logs, mail, news…), never as "the Toolbox tabs". There is also a **different**
Toolbox in MetaEditor, with different tabs and the same `Ctrl+T` — do not mix the two.

## The headline answers

1. **Window name: `Toolbox`.** Confirmed from the title bar of the floating window and from
   the vertical caption of the docked one, in the current build.
2. **`Ctrl+T` confirmed**, verbatim: *"Ctrl+T — Open/close the "Toolbox" window."* There is
   exactly one other Toolbox shortcut: **`Ctrl+F9`** — *"Open the "Trade" tab in the "Toolbox"
   window and switch the control focus to it."* **There is no per-tab shortcut for any other
   tab.**
3. **Twelve tabs confirmed**, in this order:
   `Trade | Exposure | History | News | Mailbox | Calendar | Company | Alerts | Articles |
   Code Base | Experts | Journal`
   — plus a **thirteenth conditional `Search` tab**, and four right-aligned **buttons** that
   are not tabs: `Market · Signals · VPS · Tester`.
4. **The account summary line is five fields, not the set we assumed**, and two of our labels
   were wrong — it is `Free Margin` (capital M) and `Margin Level` (capital L):
   ```
   ⊕ Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %                 633.32
   ```

## Corrections to assumptions we held

1. **`Free margin` and `Margin level` are wrong.** The strip reads **`Free Margin:`** and
   **`Margin Level:`**, both with a capital second word. Measured off
   `position_manage.png` at 4×, and corroborated on four other screenshots and on the Russian
   build.
2. **The currency code appears only once, after the Balance value** (`3 370.75 USD`). Every
   other figure on the strip is bare. Confirmed on five independent screenshots.
3. **The field set is not fixed.** Retail Forex / Futures accounts show
   `Balance · Equity · Margin · Free Margin · Margin Level`; an Exchange-model account shows
   `Balance · Liabilities · Equity · Free Margin` — no Margin, no Margin Level. Design for a
   variable field list, not a fixed five.
4. **There is a sixth, unlabelled value**: the account's total floating P/L, right-aligned on
   the same strip under the `Profit` column. MetaQuotes calls it **`Total of deals`** in the
   field list but the strip prints **no label for it**.
5. **The `Market` button's icon is a yellow shopping bag, not a padlock.**
   `02-toolbox-and-panels.md` described it as `🔒 Market`; at 5× it is unambiguously a bag.
6. **There is a `Search` tab.** It is not in our list at all. It appears at the far right of
   the tab strip and carries its own seven sub-tabs.
7. **The News tab has three columns, not four.** The apparent fourth column in
   `en/fundamental_news.png` is a painting artefact — see §4.4 for the proof.
8. **The Articles tab is fully documented by one screenshot** (`articles.png`), which
   `02-toolbox-and-panels.md` recorded as unverifiable. Columns, context menu and the
   category submenu are all legible.
9. **`Calendar`'s second and fourth headers are `Currency` and `Priority`**, truncated to
   `Curr…` / `Pri…` only at narrow widths. `fundamental_calendar_event.png` renders
   `Currency` in full.
10. **MetaQuotes calls the Exposure tab the "Assets tab" twice in English prose**, and the
    Russian build labels it **`Активы`** (= Assets). The English tab label is `Exposure`.
11. **MetaQuotes calls the Trade tab the "Trading tab"** in the sentence that introduces it.
12. **The window used to be called `Terminal`** (MT4's name). The screenshot the current help
    serves for the Search feature still has `Terminal` in its title bar.

---

## 1. The window

### 1.1 Its name — four of them

| Where | String |
|---|---|
| Floating window title bar (current build) | **`Toolbox`** |
| Docked window, vertical left-edge caption | **`Toolbox`** |
| Hot keys page, verbatim | *"Open/close the "Toolbox" window."* |
| User Interface page, verbatim | *"Toolbox is a multifunctional window that provides functions for working with trade positions, news, account history, alerts, internal mailbox, program logs, and expert journals."* |
| `toolbox_search.png` (older build, still served by the current help) | **`Terminal`** |
| Russian build, floating title / docked caption | **`Инструменты`** ( = "Tools"), not a transliteration of Toolbox |

Read from `en/position_manage.png` (floating **and** docked in the same image),
`en/exposure_forex.png`, `en/exposure_exchange.png`, `en/exposure.png`, `en/alerts.png`,
`en/fundamental_calendar.png` (all `Toolbox`); `en/toolbox_search.png` (`Terminal`);
`ru/history.png` (`Инструменты`).

**MetaQuotes never transcribes the title bar in prose.** All of the above is read off images.

### 1.2 Opening it

```
Ctrl+T    Open/close the "Toolbox" window.
Ctrl+F9   Open the "Trade" tab in the "Toolbox" window and switch the control focus to it.
          After that trade activities can be managed using the keyboard.
```
Both verbatim from the
[Hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) page, in the
"Common Actions in the Platform" block (not in the "Hotkeys in the "Toolbox" Window" block).

**There is no documented menu route.** The User Interface page says only *"The trading
platform interface is highly customizable. You can choose to display only the tools that you
currently need. For example, you can hide Market Watch and Navigator, and show the Depth of
Market and Data Window."* It never names the View menu item for the Toolbox. The main menu is
documented as *"File, View, Inset, Charts, Tools, Window, Help"* — **"Inset" is MetaQuotes'
own typo for Insert**, live on the page today.

### 1.3 Docking and undocking — observed, not documented

**MetaQuotes documents a `Docked` command for chart windows only**
([Chart Management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage):
*"Docked — dock/undock the chart window from the main platform window."*). It documents no
such command for the Toolbox.

But the Toolbox is demonstrably undockable, from two independent sources:

- **`en/position_manage.png` shows both states in one image.** The upper Toolbox is
  **floating**: its own horizontal title bar reading `Toolbox` with an `✕` at the far right,
  drawn over the chart. The lower Toolbox is **docked** at the bottom of the main window: no
  title bar, instead a narrow left gutter carrying an `✕` at the top and the word `Toolbox`
  **rotated 90° and reading bottom-to-top**.
- **Release notes, build 3081, verbatim:** *"Fixed buttons opening MQL5 services in the lower
  panel of the Toolbox window. The buttons were inactive when the window was undocked."*
  ([releasenotes/terminal/2212](https://www.metatrader5.com/en/releasenotes/terminal/2212)) —
  which also confirms MetaQuotes' own name for the `Market/Signals/VPS/Tester` row: **"buttons
  opening MQL5 services in the lower panel of the Toolbox window"**.

**How you undock it is not documented anywhere.** No MetaQuotes page describes the gesture,
and there is no screenshot of a Toolbox context menu with a `Docked` item.

### 1.4 Can tabs be reordered or hidden?

**No MetaQuotes source says either way.** Every published tab strip, across four build
generations and two languages, shows the tabs in a fixed order; none shows a reorder affordance,
a tab close button, or a "show/hide tabs" control. The only tab MetaQuotes documents as
hideable is `Company`, and that is hidden **by the broker**, not by the user. Treat reordering
and hiding as **UNVERIFIED** (see "Could not verify" #1).

### 1.5 Chrome, as rendered

- Tabs are flat labels separated by thin vertical rules; the active tab is drawn as a raised
  white tab with the rule beside it suppressed.
- **Tabs carry an unread-count subscript** in small red digits, directly after the label and
  below the baseline: `Mailbox₁₁`, `News₁₅`, `Articles₇`, `Signals₈`, `Почта₇`.
  Read off `exposure_exchange.png`, `fundamental_news.png`, `articles.png`,
  `toolbox_search.png`, `ru/history.png`.
- The four right-aligned buttons are icon+label, in this order:
  **`🛍 Market`  `((•)) Signals`  `☁ VPS`  `▣ Tester`**.
  Market's icon is a yellow shopping bag; Signals' is a blue broadcast glyph; VPS' is a blue
  cloud-on-a-stand; Tester's is a blue microchip.
- **Buttons grey out independently and inconsistently across screenshots.** In
  `position_manage.png` and `interface_overview.png`, `VPS` is grey and `Signals` is active;
  in `alerts.png`, `Signals` is grey and `VPS` is active. MetaQuotes states no rule for either.

---

## 2. The tab list

### 2.1 Current build — twelve tabs, verbatim

Read off `en/position_manage.png` at 5×:

```
Trade | Exposure | History | News | Mailbox | Calendar | Company | Alerts | Articles | Code Base | Experts | Journal
```

Corroborated in the same order and spelling on `en/exposure_forex.png`,
`en/exposure_exchange.png`, `en/exposure.png`, `en/alerts.png`, `en/close_position.png`,
`en/bulk_positions.png`, `en/history.png`, `en/interface_overview.png`.
`Code Base` is **two words with a space**.

### 2.2 The thirteenth tab: `Search`

`en/toolbox_search.png` — the image the current User Interface page serves for its Search
section — shows a **`Search`** tab appended at the right-hand end of the tab strip, selected,
holding a result list with its own horizontal sub-tab strip:

```
All | Articles | Products | CodeBase | Signals | Forum | Documentation
```

with `Products` active (red label + red underline). **Note `CodeBase` here is one word**,
against the Toolbox tab's `Code Base`. Both are MetaQuotes'.

That asset is from the older `Terminal`-titled build, so the Search tab is confirmed to
*exist* but not confirmed to look this way today.

### 2.3 Which tabs are conditional

| Tab | Always present? | Evidence |
|---|---|---|
| Trade, Exposure, History, News, Mailbox, Calendar, Alerts, Articles, Code Base, Experts, Journal | **Always**, in every published tab strip | 8 current-build screenshots |
| **Company** | **Conditional — broker-controlled.** Verbatim: *"A broker may choose to show a useful web resource here, for example a support website. Any link added here opens in a separate web browser window. **This tab is hidden if the web page is disabled by the broker.**"* | User Interface page |
| **Search** | **Conditional — appears when a search is run** | `toolbox_search.png` |

**No tab is conditional on an MQL5 account, on a hedging account, or on an Expert Advisor
being attached.** We looked for each:

- *MQL5 account*: `Market`, `Signals`, `Articles` and `Code Base` all consume MQL5.community
  services, but MetaQuotes nowhere says any of them is hidden without an MQL5 login. The
  `Signals` **button** is observed greyed in one screenshot and active in another, with no
  stated rule — that is the only MQL5-account-shaped behaviour we found, and it is on a
  button, not a tab.
- *Hedging*: `position_manage.png`, `close_position.png`, `bulk_positions.png` and
  `interface_overview.png` are all hedging accounts (title bars read `… - Hedge - …`) and
  show the same twelve tabs as the exchange-model account in `exposure_exchange.png`. The
  hedging/netting distinction changes the **Bulk Operations submenu** and the availability of
  **Close By**, not the tab list.
- *Expert Advisor attached*: the `Experts` tab is a **log**, present whether or not an EA runs
  — *"Experts Journal is displayed on the Experts tab of the Toolbox window."* No conditional
  language.

### 2.4 Older builds had a different list — do not model from them

| Build | Tab strip |
|---|---|
| Current (EN) | Trade · Exposure · History · News · Mailbox · Calendar · Company · Alerts · Articles · Code Base · Experts · Journal **(12)** |
| ~2018 (EN, `articles.png`) | Trade · Exposure · History · News · Mailbox · … · Market · Alerts · Signals · Articles · Code Base **(Articles sits between Signals and Code Base)** |
| ~2015 (EN, `fundamental_news.png`, `journal.png`) | Trade · Exposure · History · News · Mailbox · Calendar · Company · Market · Alerts · Signals · Code Base · Experts · Journal **(13, no Articles)** |
| ~2014 (EN, `mail.png`) | … Mailbox · Calendar · Company · Market · Alerts · Signals · Code Base · Ex… |
| ~2015 (RU, `ru/history.png`) | Торговля · Активы · История · Новости · Почта · Календарь · Компания · Маркет · Алерты · Сигналы · Библиотека · Эксперты · Журнал **(13)** |

The move of `Market` and `Signals` out of the tab strip and into the right-aligned button row
is the single biggest change. `Активы` ( = Assets) for Exposure and `Библиотека` ( = Library)
for Code Base are the two Russian labels that are not literal translations of the English.

### 2.5 Toolbox-wide hot keys (Hot Keys page, verbatim)

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

`R key` is MetaQuotes' own spelling, in a column where every other row is a bare key name.
In the UI the same two toggles appear in the context menus as `Auto Arrange  A` and
`Grid  G`, both checked by default.

---

## 3. Trade tab

> **One line:** the live account — open positions above the account summary strip, pending
> orders below it, in a single shared column grid.

### 3.1 Columns, default visible set

Read off `en/position_manage.png` at 5×:

```
Symbol ▲ | Ticket | Time | Type | Volume | Price | S / L | T / P | Price | Profit
```

- `S / L` and `T / P` are written **with a space on each side of the slash**. The help body
  text writes `S/L` and `T/P` with no spaces — the dialog wins. Confirmed in English and in
  the Russian build, which also renders `S / L` / `T / P` untranslated.
- **Two columns are both headed `Price`**: the 6th is the position open price, the 9th is the
  current market price.
- `Symbol` is left-aligned and carries the sort triangle (`▲` ascending in
  `position_manage.png`, `▼` descending in `exposure_forex.png`); every column from `Ticket`
  rightwards is right-aligned, including its header.
- `Profit` is the rightmost column.

### 3.2 Full documented column set (help body, `performing_deals`)

For **positions**, in the order the help lists them — note the help puts `Ticket` first and the
UI puts `Symbol` first:

```
Ticket, Symbol, ID, Time, Type, Volume, Price, S/L, T/P, Price, Value, Swap, Profit, Change, Magic
```

For **pending orders**:

```
Symbol, Order, ID, Time, Type, Volume, Price, S/L, T/P, Price, Comment, State
```

Semantics worth carrying (verbatim):
- `ID` — *"the position ID in an external trading system (for example, on the exchange). The
  display of this parameter can be disabled depending on your broker's settings."*
- `Time` — *"Specified according to the time zone of the broker's trading server. The record is
  represented as YYYY.MM.DD HH:MM (year.month.day hour:minute)."* **The rendered values carry
  seconds** (`2026.06.22 14:49:50`), which the format string does not. A `Show Milliseconds`
  context-menu item adds a third place.
- `Type` — *"position type: "Buy" — long, "Sell" — short"* in prose; **the UI renders it
  lowercase**: `buy`, `sell`, `buy limit`, `sell limit`.
- `Value` — *"the market value of the position."*
- `Change` — *"the change in the asset price as a percentage since the operation execution
  time. **Positive and negative values are colored in blue and red, respectively.**"*
- `Magic` — the Expert Advisor ID.
- Pending `Volume` — *"volume requested in the pending order, and volume covered by the
  deal"*, rendered as **`requested / filled`**, e.g. `0.01 / 0`.
- Pending `State` — *"in the last column, the current state of a pending order is displayed:
  "Started", "Placed", etc."* The UI renders it lowercase (`placed`) and in grey.
- **`Comment` is a pending-order column only.** It is not in the position list.
- `Swap` is a real position column but is **not** in the default visible set.

### 3.3 How pending orders are separated from positions

**They are not two tables.** There is **one header row** and **one column grid**. The account
summary strip is the separator:

```
Symbol   Ticket   Time                  Type       Volume     Price      S / L        T / P        Price      Profit
eurusd   328674   2026.06.22 14:49:50   buy        0.1        1.14590    1.16043 ×    1.16944 ×    1.16421    183.10 ×
eurusd   328681   2026.06.22 14:52:43   buy        0.05       1.14598    1.15441 ×    1.17442 ×    1.16421     91.15 ×
usdtry   328844   2026.07.29 21:30:41   buy        0.1       47.36027   46.24420 ×   49.24420 ×   48.24450    183.28 ×
usdtry   328845   2026.07.29 21:30:41   buy        0.1       47.36027   45.24420 ×   49.24420 ×   48.24450    183.28 ×
⊕ Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %      633.32
eurusd   328863   2026.08.28 07:05:35   buy limit  0.01 / 0   1.16000    1.15010 ×    1.17090 ×    1.16422    placed ×
```

- **Positions sit above the strip; pending orders sit below it.**
- Pending rows reuse the position headers. The pending ticket lands under `Ticket` (the help
  calls that field `Order`); the state string lands under `Profit`. **No second header row
  appears**, and `Comment` / `State` are not rendered as their own columns at default width.
- **Row gutter icons.** Each row carries a small outlined document glyph before the Symbol
  text. Position rows: a plain rounded rectangle with a bar motif, **blue outline for buy, red
  outline for sell**. Pending-order rows: the same glyph with a **folded bottom-right corner**.
- Symbol text renders lowercase (`eurusd`) in MetaQuotes' demo screenshots. **That is the
  broker's symbol naming, not a UI rule.**

### 3.4 The `×` buttons on a row

- A small `×` at the **right edge of the `Profit` cell** closes the position; on a pending row
  the `×` at the right edge of the state cell deletes the order. Help body: *"The 'Profit'
  column of each open position has the button Close position/Delete order."*
- A small `×` appears **immediately after the S/L value and after the T/P value** when those
  levels are set; it removes that stop level. When S/L or T/P is unset the cell is blank and no
  `×` is drawn (`exposure_forex.png` has three positions with no stops and no `×`).

### 3.5 Right-click context menu (verbatim, `close_position.png` + `bulk_positions.png` at 1.6–2×)

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

The menu string is **`Modify or Delete`**; the help prose writes *"Modify or delete"*.
`Auto Arrange` and `Grid` carry checkmarks by default; `Show Milliseconds` does not.

**`Bulk Operations ▸` (verbatim):**
```
Close All Positions
Close Profitable Positions
Close Losing Positions
Close Buy Positions
Close EURUSD Positions
Close Buy EURUSD Positions
Close by EURUSD
─────────────────────────
Delete All Orders          (greyed — no pending orders)
Delete Limit Orders        (greyed)
Delete Stop Orders         (greyed)
Delete Stop Limit Orders   (greyed)
```
The symbol- and direction-specific entries are generated from the selected row. Help body:
*"The list of available commands is formed automatically, depending on the selected operation
and on your account type"* and *"These commands are only available if One Click Trading is
enabled in platform settings."*

### 3.6 Per-tab buttons and filters

**None.** The Trade tab has no toolbar, no filter row and no date control. Every control lives
in the context menu. (This is unlike the mobile Trade screen, which has a sort button on its
top panel.)

---

## 4. The account summary line — exact format

### 4.1 The string

Read off `en/position_manage.png`, cropped at `y = 674…698` of the 2× asset and upscaled 4–8×:

```
⊕ Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %                 633.32
```

Pattern:

```
<glyph> Balance: <amount> <CCY>␣␣Equity: <amount>␣␣Margin: <amount>␣␣Free Margin: <amount>␣␣Margin Level: <amount> %        <total>
```

### 4.2 Every formatting rule, measured

| Rule | Value | How established |
|---|---|---|
| Weight | **Bold** throughout | visual, 8× |
| Strip background | solid mid-grey, full window width, one row high | visual |
| Field order (Retail Forex / Futures) | `Balance · Equity · Margin · Free Margin · Margin Level` | 5 screenshots |
| Label casing | `Balance:` `Equity:` `Margin:` **`Free Margin:`** **`Margin Level:`** — second word capitalised | 8× crop |
| Separator after a label | one space, after the colon | measured: 6–7 px at 2× |
| Separator **between fields** | **two spaces** | measured: 11–12 px at 2×, i.e. ~2× the single space |
| Thousands separator | **a space**, not a comma: `3 370.75`, `1 076.68` | 8× crop |
| Decimal separator | **a point** | 8× crop |
| Currency code | **only after the Balance value**, space-separated: `3 370.75 USD`. All other figures bare | 5 screenshots |
| Percent | **value, space, `%`**: `1 076.68 %` | measured: 6 px gap at 2× = one space |
| Leading glyph | `⊕` or `⊖` in a circle, at the far left | see 4.4 |
| Trailing value | the total floating P/L, **right-aligned under the `Profit` column, with no label** | 5 screenshots |

### 4.3 Four more instances, all consistent

```
en/position_manage.png (floating)  ⊕ Balance: 3 370.75 USD  Equity: 4 004.07  Margin: 371.89  Free Margin: 3 632.18  Margin Level: 1 076.68 %   633.32
en/position_manage.png (docked)    ⊕ Balance: 3 370.75 USD  Equity: 4 005.69  Margin: 371.89  Free Margin: 3 633.80  Margin Level: 1 077.12 %   634.94
en/interface_overview.png          ⊕ Balance: 7 796.40 USD  Equity: 8 508.03  Margin: 2 016.60  Free Margin: 6 491.43  Margin Level: 421.90 %   711.63
en/close_position.png              ⊕ Balance: 3 263.84 USD  Equity: 3 973.78  Margin: 3 723.59  Free Margin: 250.19  Margin Level: 106.72 %     709.94
en/exposure_forex.png              ⊕ Balance: 3 791.48 USD  Equity: 3 931.41  Margin: 3 716.25  Free Margin: 215.16  Margin Level: 105.79 %     139.93
ru/position_manage.png             ⬆ Баланс: 9 400.30 USD  Средства: 9 500.54  Маржа: 3 655.91  Свободная маржа: 5 844.63  Уровень маржи: 259.87 %  100.24
```

The two instances inside `position_manage.png` differ by a few cents because the image is a
composite of two renders taken a tick apart — not a formatting difference.
The Russian build keeps the **space thousands separator, the space before `%`, and `USD` only
after Баланс**, so those three rules are build-wide, not locale-specific.

### 4.4 The leading glyph

`⊕` (plus in a circle) on the five Retail-Forex screenshots; **`⊖` (minus in a circle)** on the
exchange-model Trade tab in `exposure_exchange.png`, verified at 12×. On the **Exposure** tab's
own strip the glyph is instead the **yellow `$` badge** used in that tab's `Assets` column.

The obvious reading is expand/collapse. It does not survive contact with the evidence: the `⊖`
("expanded") strip carries **four** fields and the `⊕` ("collapsed") strips carry **five**.
MetaQuotes documents no control here at all. **Recorded as a contradiction, not resolved.**
No published screenshot shows an expanded strip, so the extra fields it would reveal are
unknown.

### 4.5 The full documented field set

`performing_deals`, verbatim definitions, in the order the help lists them:

```
Balance, Credit, Assets, Liabilities, Commission, Blocked, Equity, Margin, Free Margin, Margin Level, Total of deals
```

- `Balance` — *"money on the account, results of currently open positions not included (deposit)."*
- `Credit` — *"amount of credit money that the broker has given to a trader."*
- `Assets` — *"the current value of purchased financial instruments (of long positions) defined in a trader's deposit currency… the amount of assets is equivalent to the amount of money that the trader would receive in case of immediate closure of long positions. This rate is used on the exchange markets."*
- `Liabilities` — *"obligations on current short positions calculated as the value of these positions at the current market price… equivalent to the amount of money that the trader would pay in case of immediate closure of short positions."*
- `Commission` — commission accumulated during a day/month and blocked on the account.
- `Blocked` — intraday profit that cannot yet be used for trading.
- `Equity` — *"Balance + Credit - Commission +/- Floating profit/loss - Blocked."*
- `Margin` — *"money required to cover open positions and pending orders."*
- `Free Margin` — *"Equity - Margin."*
- `Margin Level` — *"percentage of the account equity to the margin volume (Equity / Margin * 100)."*
- `Total of deals` — *"total financial result of all open positions."*

The help lists eleven; no published strip shows more than five. **Which subset renders, and in
what order, depends on the risk-management model**: *"The platform adapts the display of assets
depending on the risk management system applied to a trading account: Retail Forex, Futures or
Exchange model."*

**Exchange-model counter-example** (`exposure_exchange.png`, Trade tab):
```
⊖ Balance: 99 995.00 USD  Liabilities: -25 181.40  Equity: 74 814.60  Free Margin: 74 814.60      1.00
```
No `Margin`, no `Margin Level`, a `Liabilities` field, and **`Liabilities` sits before
`Equity`** — whereas on the same account's **Exposure** strip, two rows below in the same
image, the order is `Balance · Equity · Liabilities · Liquidation value`. **MetaQuotes'
own two strips disagree on field order within one screenshot.**

### 4.6 Margin Call and Stop Out

**Desktop, verbatim and complete:**

> *"The account state line is highlighted with the red color, if the account is in the Margin
> Call or Stop Out state."*

That is the **entire** desktop statement. It says the *line*, not the fields; it names no
colour value; it gives **no Margin Call message text at all**. There is no screenshot of a
Margin Call state anywhere in the help.

**Mobile says something different** (Android Trade page, verbatim):

> *"If the account gets "Margin Call", the margin fields are highlighted in red."*

**Desktop highlights the line; mobile highlights the margin fields. Mobile does not mention
Stop Out.** Both are MetaQuotes'. Unreconciled.

There is **no "Margin Call" wording** — no banner, no dialog, no toast — anywhere in the MT5
desktop help. The only Stop Out prose is about server-side closing order:

> *"Closing upon Stop Out triggering — such operations are also processed on the server side.
> In a normal mode, in which FIFO-based closing is disabled, Stop Out causes the position
> having the largest loss to be closed first…"*

**Do not invent a Margin Call string.** See "Could not verify" #4.

---

## 5. Exposure tab

> **One line:** net exposure per currency/instrument in the deposit currency, as a table plus a
> bar chart plus a long/short pie.

### 5.1 Columns, in order

Read off `en/exposure.png` (2× asset) and `en/exposure_forex.png`:

```
Assets ▲ | Volume | Rate | ⟨deposit-currency code⟩ | Graph | ⟨unnamed swatch column⟩
```
…then, to the right of the table and outside it, a panel titled **`Long Positions`**.

- **The fourth header is the deposit currency code itself** — literally `USD` in all three
  screenshots. It is **not** a generic word like "Value". An EUR-denominated account would
  head that column `EUR`.
- `Assets` carries the sort triangle and a **yellow `$` badge icon** per row, before the
  currency/instrument code (`EUR`, `TRY`, `USD`, `JPY`, `EURUSD`, `GBPUSD`).
- `Volume` uses **SI suffixes**: `15K`, `-947.2054K`, `365.8981K`, `-5.7007M`, `99.995K`.
- `Graph` holds a **horizontal bar chart drawn from a central zero baseline**: long positions
  to the right, short to the left.
- The swatch column has **no header** and holds one small filled square per row (red, green,
  blue in the published examples), keying the row to the pie chart.

### 5.2 What the bar chart shows

Help body, verbatim: ***"The graphical display of the position in the deposit currency (long
positions are displayed with blue bars and short positions are displayed with red ones)."***

Verified: in `exposure_forex.png`, JPY at `-357.44` draws a **red** bar left of centre and USD
at `+602.88` draws a **blue/indigo gradient** bar right of centre.

### 5.3 The `Long Positions` panel

A filled circle / pie with wedge labels (`USD`, `EUR`, `EURUSD`) and the title
**`Long Positions`**. Help body: ***"To switch between the information on short and long
positions click on the diagram title."*** So the title is the control. **The short-side title
string is not published** — presumably `Short Positions`, but no screenshot shows it.

### 5.4 What `Assets` and `Liabilities` mean here

Two different things share the word `Assets` on this tab, and the help never flags it:

1. **`Assets` is the first column header** — holding, per the numbered callout, *"The name of
   the currency or financial instrument."* It is a **row label**, nothing to do with money.
2. **`Assets` is also a summary-strip money field**, defined in §4.5 as the value of long
   positions.

`Liabilities`, by contrast, appears only as a money field: *"obligations on current short
positions calculated as the value of these positions at the current market price."*
Both are exchange-model concepts — *"This rate is used on the exchange markets."*

The remaining column callouts, verbatim:
- Volume — *"The volume (in units) of a trader's position for the currency or financial instrument including leverage."*
- Rate — *"Instrument or currency exchange rates in the deposit currency."*
- ⟨CCY⟩ — *"The amount of deposit currency (excluding leverage) actually spent to buy/sell the currency or trading instrument."*
- and *"The displayed account assets for the deposit currency take into account the free margin."*

### 5.5 Exposure's own summary strip

Distinct from the Trade tab's, and prefixed with the **yellow `$` badge** instead of `⊕`:

```
Retail Forex / Futures   $ Balance: 3 370.75 USD  Equity: 4 002.76  Margin: 371.89  Free Margin: 3 630.87  Margin Level: 1 076.33 %
Retail Forex / Futures   $ Balance: 3 791.48 USD  Equity: 3 960.32  Margin: 3 716.25  Free Margin: 244.07  Margin Level: 106.57 %
Exchange model           $ Balance: 99 995.00 USD  Equity: 74 814.80  Liabilities: -25 181.40  Liquidation value: 99 996.20
```

`Liquidation value` appears only here: *"you can see the liquidation value here — amount of
funds on the account and the price (result) of closing all current positions at the market
price."* **There is no right-aligned trailing total on the Exposure strip.**

### 5.6 Context menu and filters

**Not published.** No MetaQuotes screenshot shows an Exposure context menu, and the prose
describes none. See "Could not verify" #6.

---

## 6. History tab

> **One line:** closed trading history, in one of four representations, over one of four
> periods, with everything driven from the context menu.

### 6.1 Columns — Deals mode, default visible set

Read off `en/history.png` (2× asset) at 5×:

```
Time ▲ | Symbol | Deal | Type | Direction | Volume | Price | S / L | T / P | Commission | Profit | Change
```

`Time` is leftmost and carries the sort triangle. `S / L` and `T / P` again with spaced slashes.

**The Russian build's default set is different**: `Время | Сделка | Ордер | Символ | Тип |
Направление | Объем | Цена | S / L | T / P | Прибыль` — it includes `Order` and omits
`Commission` and `Change`. So the default visible set is not stable across builds; model it as
a default, not a constant.

### 6.2 Full documented Deals field list (help body, in order)

```
Time, Deal, ID, Order, Symbol, Type, Direction, Volume, Price, Value, Cost, S/L, T/P, Commission, Fee, Profit, Change, Magic
```

- `Direction` — *"direction of the deal relative to the current position of a particular symbol: "in", "out" or "in/out"."*
- `Type` — *"Buy" / "Sell"*, and *"In some situations a previously performed deal is canceled. In this case, the type of the previously performed deal is changed to **Canceled buy** or **Canceled sell**, and its profit/loss is reset to zero."*
- `Cost` — *"the cost of a deal execution relative to the current mid-point price of the symbol (mid-point spread cost)… The availability of the parameter depends on the server."*
- `Fee` — *"separate type of fees charged by the broker per deals."*
- `Profit` — *"the financial result of the position exiting. For entry trades the zero profit is shown."*
- `Change` — *"a percentage change in the asset price at the time when profit/loss is locked in. **Positive and negative values are colored in blue and red, respectively.**"*

### 6.3 Row rendering

- **Gutter icon**: a dog-eared document outline containing an arrow. **Outline colour = Type**
  (blue for `buy`, red for `sell`); **arrow direction = Direction** (`→` for `in`, `←` for
  `out`). Verified row by row at 10× against the Type and Direction cells.
- Balance-type operations (`daily commission`, `interest rate`) render with the Symbol cell
  **blank** and the operation name in the `Type` cell (`ru/history.png`).
- `Change` values print with a space before the sign: `-0.01 %`, `2.18 %`.
- Profit is **blue for positive, red for negative** — no green.

### 6.4 The view switch — four modes, in the context menu only

```
   Positions
✔  Deals
   Orders
   Orders & Deals
```

**There is no toolbar, no segmented control and no dropdown.** The switch lives as a
radio-style group in the right-click context menu, second block. Default selected is **`Deals`**
(checkmark). Same four in Russian: `Позиции / Сделки / Ордера / Ордера и сделки`.

Help body on what each shows:
- *Positions* — *"The platform collects data on deals related to a position (position opening, additional volume, partial and full closure), and then combines the data into one record."*
- *Orders* — *"A list of orders containing all trade requests sent to a broker."*
- *Deals* — *"A list of deals — the actual purchase and sale transactions executed based on the orders."*
- *Orders & Deals* — *"A tree view of all trading operations showing how the trade requests were processed."*

### 6.5 Date-range presets — four, in the context menu only

```
   All History
   Last 3 Months
   Last Month
⚙  Custom Period
```

Title Case; `Custom Period` carries a gear icon and opens a date picker. **There is no
"Today", no "Last 3 days", no "Last week"** on desktop.

**Russian is not a translation of this.** `ru/history.png` reads `Вся история /
Последние 3 месяца / Последний месяц / **Выбрать период…**` — the last item means "Select
period…" and carries an **ellipsis** the English does not.

The **mobile** list is different again (five entries, sentence case, each with a resolved date
range and a tick on the active one): `Today / Last week / Last month / Last 3 months /
Custom period`.

### 6.6 Full context menu (verbatim, `history.png`)

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

Help body maps the blocks: *"Switching between history representation modes. / Filtering
history by financial instruments and volume switching between lots and units. / If the account
trading history is too large, or you need to access data for a certain time interval, select
the desired period here."* So `Symbols ▸` is a **symbol filter** and `Volumes ▸` is a
**lots-vs-units toggle**, not a volume filter.

### 6.7 Summary strip

```
⊕ Profit: 591.31  Credit: 0.00  Deposit: 3 000.00  Withdrawal: -250.00  Balance: 3 341.31          0.00        626.68
```

Same typography as the Trade strip: bold, two-space field separator, space thousands separator.
**But there is no currency code anywhere on this line** — not even after `Balance`. That is a
real difference from the Trade tab, verified at 5×.

Two right-aligned column totals sit on the same strip: `0.00` under `Commission` and `626.68`
under `Profit`. Nothing under `Change`.

Field definitions, verbatim: *"Profit — profit or loss relative to the initial deposit /
Credit — amount credited by the brokerage company / Deposit — deposit of the account (the sum
of balance type operations with a positive value) / Withdrawal — amount withdrawn from the
account (the sum of balance type operations with a negative value)"* and ***"The current
account balance is displayed at the end of the line."***

⚠ **`Profit: 591.31` on the strip and `626.68` in the Profit column total do not agree**, in
MetaQuotes' own screenshot. The two are different quantities (result vs. column sum); nothing
in the help explains the gap.

### 6.8 `Report ▸`

MetaQuotes confirms only the first item: *"click 'Report \ Overview' in the context menu of the
trading history section"*, and *"To get a report, select 'Report' in the context menu of the
History tab. HTML reports are generated from a template ReportHistory.htm, located in the
/Templates folder of the platform."* The parenthesised long forms
`HTML (Internet Explorer)` and `Open XML (MS Office Excel 2007)` come from broker guides, not
from MetaQuotes — treat as medium confidence. The separate **Trading Report** window reached
via `Report ▸ Overview` has its own *"Save report as HTML or PDF"* control; that is the only
place PDF appears.

---

## 7. The other nine tabs

### 7.1 News

> **One line:** financial newsletters from the broker's providers; double-click a title to read it.

**Columns — three, not four:**
```
Subject | ⟨category / provider⟩ | Time
```

`Subject` is verified from the English screenshot and from the Russian (`Тема`). The second
column holds the provider/category (`MQL5 News` in English; `DowJones`, `Prime` in Russian).
The third holds `YYYY.MM.DD HH:MM`.

⚠ **The apparent fourth column is an artefact.** `en/fundamental_news.png` appears to show a
fourth narrow column with values `3.27 13:59`, `3.27 13:56`, `3.27 13:50`, `3.27 13:46`,
`3.27 13:46`. The Russian asset `ru/fundamental_news.png` is the **same screenshot** with
Russian text, and its single Time column reads `2015.03.27 13:59`, `13:56`, `13:50`, `13:46`,
`13:46` — the identical minutes. The English image was painted over the Russian one and the
tail of the old `2015.03.27 13:5x` column was left behind. **There is no fourth column.** (This
supersedes `02-toolbox-and-panels.md` §9 item 4.)

**The header of the middle column is not legible in any published asset** (the chart window
overlaps the header row in both language variants). The Hot Keys page proves the column exists
and is toggleable: ***"R key — Show/hide the column of news categories."*** The Articles tab's
context menu labels its equivalent toggle **`Category  R`**, so `Category` is the likely
string — but it is inference, not a reading.

Rows: a small parcel/globe icon in the gutter; **unread items render bold**, read items normal.

**Filtering:** *"Open the context menu in the news tab. Click 'Customize' in the submenu of news
categories to open their setup window."* That window is titled **`News categories`**, with the
body text *"News can be filtered by categories. Please, select categories you need from the
available list."*, a checkbox tree (`Financial news` with an expander, `World news`) and
**`OK` / `Cancel`** buttons.

Language is configured at `Tools → Options`: field **`News Language`** with an **`Edit`**
button, plus an **`Enable news`** checkbox.

### 7.2 Mailbox

> **One line:** the platform's internal mail system.

**Columns:**
```
Subject | From | To | Time
```
Callouts, verbatim: *"Email subject / Email sender's name / Email recipient's name / Email
sending or receiving time."*

Row icons in the gutter: **unread envelope (closed), read envelope (open), outgoing marker**,
and a **thread marker** — *"When the function of response to an email is used, messages are
joint into threads… Email threads are marked with icon. To expand a thread, click on this
icon."* Unread rows render **bold**.

**Context menu (verbatim, `mail.png`):**
```
➕  Create...        Insert
🔍  View...          Enter
❌  Delete           Delete
⊞   Expand           Space
    ─────────────────────
✔   Auto Arrange     A
✔   Grid             G
```
Note the **ellipses** on `Create...` and `View...` — the Alerts menu has none on its
equivalents.

Reader toolbar: `Reply`, `Save`, `Print`, `Print Preview`, `Attachment`.
Compose window: `To`, `Subject`, `Attachments`, and a three-tab body editor
**`Edit | View | Source`**. Attachment limits: 8 MB per file, 16 MB total, 5 files max.

### 7.3 Calendar

> **One line:** the Economic Calendar — macroeconomic releases with actual/forecast/previous values.

**Columns, in order:**
```
Time | Currency | Event | Priority | Period | Actual | Forecast | Previous
```

Read in full from `en/fundamental_calendar_event.png`. In `en/fundamental_calendar.png` the
same headers are truncated at default width to **`Curr…`** and **`Pri…`** — truncation, not
different strings.

**Importance markers.** `Priority` renders as a **blue Wi-Fi-style fan glyph**, three levels,
verified at 10×:

| Glyph | Reading |
|---|---|
| a dot alone | lowest |
| dot + one arc | middle |
| dot + two arcs | highest |

**MetaQuotes never names the three levels.** The help says only *"Every indicator is provided
with the release time, priority…"* and *"filter events in the list… by priority"*. The
words "low / medium / high" are ours, not MetaQuotes'. See "Could not verify" #8.

**Row rendering:**
- A **country flag** in the gutter, left of the Time value.
- **Date group separator rows** in **red bold**, spanning the table: `Wednesday, 11 November`.
- Values carry units inline: `3.4%`, `101.7`, `798.2B`, `1,050.0B`, `0.740B`.
  ⚠ **The Calendar uses a comma thousands separator (`1,050.0B`) and no space before `%`
  (`3.4%`)** — the opposite of the account summary line, which uses a space thousands separator
  and a space before `%`. Both in MetaQuotes' own screenshots.
- **Colour rule, verbatim:** *"If this value is less than the predicted one, the indicator is
  highlighted in red. If the current value is larger, the indicator is shown in blue."*
  ⚠ The screenshot shows the **whole row tinted** pink or pale blue, not just the value cell.
  The prose says "the indicator"; the pixels say the row.

**Period:** *"By default, the calendar displays current week events, including past and
upcoming events. Use the context menu to switch to another period. You can access events for
the previous, current and next week, as well as appropriate months."* **No verbatim period
strings are published.**

**Filters:** *"For easier search, filter events in the list using the context menu: by
priority / by the currency of the country for which the indicator is published / by country for
which the indicator is published."* **No verbatim filter strings are published.**

**Context menu, partially verified** (`fundamental_calendar_event.png`; a magnifier lens covers
the middle of the menu):
```
🔄 Refresh          F5
🖼 Export...
   ──────────────
   Show on Charts   ▸ ── ➕ Add All Events
   ──────────────        ❌ Delete All Events
✔  Auto Arrange     A    ──────────────
✔  Grid             G    Auto Update
```
The priority/currency/country filter items are described in prose but fall under the lens in
the only published image.

Double-clicking an event name opens *"a detailed event description or the history of its values
as a graph or table."*

### 7.4 Alerts

> **One line:** price/volume/time triggers that fire a sound, a file, an email or a push notification.

**Columns, in order** (`en/alerts.png`, 2× asset):
```
Symbol | Condition | Counter | Limit | Timeout | Expiration | Event
```

Example rows:
```
🔔 EURUSD   Bid < 1.15604    0   10   10 sec        alert
🔔 GBPUSD   Bid < 0.36450    0   10   10 sec        BOE
⛔ USDCHF   Ask > 13.25560   0   10   10 sec        Email Notification
```
Gutter icon: a **yellow bell** for an enabled alert, a **red crossed circle** for a disabled one.

**Context menu (verbatim):**
```
➕  Create        Insert
⚙   Modify        Enter
❌  Delete        Delete
✓   Enable        Space
    ──────────────────
✔   Auto Arrange  A
✔   Grid          G
```
**No ellipses**, unlike Mailbox's `Create...` / `View...`.

**The dialog is titled `Alert Editor`**, not "Create Alert". Field labels verified verbatim:
`Enable` (checkbox), `Action:`, `Expiration:`, `Symbol:`, `Condition:`, `Value:`, `Source:`
(with a `...` browse button), `Timeout:`, `Maximum iterations:`. Buttons **`OK` `Test`
`Cancel`**, in that order, OK focused.

⚠ **Action strings contradict.** The help prose names the four actions `Sound`, `File`,
`Email`, `Notification`; the Action dropdown in the screenshot reads **`Mail`**. Trust the
screenshot for the current build.

`Condition` options, verbatim and in order:
```
Bid <   Bid >   Ask <   Ask >   Last <   Last >   Volume <   Volume >   Time =
```
*"Time = — an alert triggers at the specified time. Specify the local computer time in the
format "HH:MM", for example 15:00."*

### 7.5 Articles

> **One line:** MQL5.community articles, downloadable and readable in the platform.

**Columns** (`en/articles.png`, read at 2.6×):
```
Name | ⟨Category⟩ | Date ▽
```
`Name` is leftmost; the middle column holds comma-joined categories
(`Tester, Trading, Trading Syste…`, `Examples, Indicators, Indicators`); `Date` is rightmost,
right-aligned, with the sort triangle, and renders `YYYY.MM.DD`.
**The middle column's header is covered by the open context menu** in the only published image,
but the menu itself carries a `Category  R` toggle, so the header is `Category` with high
confidence (inference, not a reading).

Rows carry a small **page icon** in the gutter. Unread count shows as `Articles₇`.

**Context menu (verbatim):**
```
🖼  View          Enter
🔄  Refresh
    ───────────────
    Categories    ▸
    ───────────────
✔   Category      R
✔   Auto Arrange  A
✔   Grid          G
```

**`Categories ▸` submenu (verbatim):**
```
   Select All
   Unselect All
   ─────────────────────
✔  Examples
✔  Tester
✔  Trading
✔  Trading Systems
✔  Integration
✔  Indicators
✔  Expert Advisors
✔  Indicators
✔  Experts
✔  Statistics and analysis
✔  Interviews
   ─────────────────────
   Customize...
```
⚠ **`Indicators` appears twice**, at positions 6 and 8, in MetaQuotes' own menu. Not a reading
error — both entries are separately checked and separately rendered.

### 7.6 Code Base

> **One line:** the free MQL5 source-code library; download compiles the code into a runnable program.

**Columns: UNVERIFIED.** MetaQuotes publishes no screenshot of this tab and describes no
columns. The only concrete datum is a hot key: ***"D — Download the selected application at the
Code Base tab."*** Help body: *"Straight from the platform you can access a huge code base of
free applications for automated trading… When you download the code, it is automatically
compiled, after which a ready-to-use application is created and saved in the appropriate
directory depending on whether it is an Expert Advisor, an Indicator or a Script. The software
name is added to the Navigator."*

The Articles tab is the nearest published analogue (same kind of MQL5.community list), so
`Name | Category | Date` is a plausible shape — **but it is a guess and is not recorded as
fact.**

Note the spelling split: the tab is `Code Base`, the Search sub-tab is `CodeBase`, the Russian
build labels it `Библиотека` ( = Library).

### 7.7 Experts

> **One line:** the Expert Advisors / indicators log.

**Columns: UNVERIFIED from a screenshot.** Help body: *"Experts Journal is displayed on the
Experts tab of the Toolbox window. It contains information about the running indicators and
Expert Advisor, including opening/closing of positions, modification of orders, Expert Advisor
alerts and comments, etc."*

MetaQuotes documents the two logs as one subsystem and gives a field list **only for Journal**
(`Time`, `Source`, `Message`). The Experts tab is never rendered in the help. The context menu
is documented as the same list as Journal **plus one Experts-only item**:
*"Alerts (in the Experts journal only) — open the window of Expert Advisor alerts."*

The EA alert popup shows *"Date and time; Name of the MQL5 application, chart symbol and
timeframe; Alert message."*

### 7.8 Journal

> **One line:** the platform's own log for the current session.

**Columns, in order** (`en/journal.png`), and the only tab whose columns the help states
explicitly:
```
Time | Source | Message
```
Verbatim: *"Time — the date and time of the event. Specified according to the time zone on the
user's computer. / Source — event type: Network, Alert, HistoryBase, Experts, the name of a
separate Expert Advisor or indicator, etc.; / Message — description of the event."*

**`Time` renders with milliseconds**: `2015.06.04 15:34:19.706`.
Gutter icons, three: *"— informational message; — warning; — error message."*

**Context menu (help body, verbatim list):**
`Open`, `Copy`, `Send`, `Alerts` *(Experts journal only)*, `Viewer`, `Clear`, `Auto Scroll`,
`Auto Arrange`, `Grid`.

Log files: `Logs\` (platform) and `MQL5\Logs\` (experts), named `YYYYMMDD.LOG`.
`Viewer` opens a **Log Viewer**: a search bar (*"search is performed by exact words, case
sensitive"*), an entry filter **`Full`, `No connection`, `Errors only`**, a time range and a
**`Request`** button. Its own context menu: `Open`, `Copy`, `Send`, `Search`, `Find next`,
`Find Previous`, `Auto Scroll`, `Auto Arrange`, `Grid` — note MetaQuotes writes
**`Find next`** and **`Find Previous`** with inconsistent casing, side by side.

### 7.9 Company

> **One line:** an embedded broker web page.

**Not a table.** Verbatim: *"A broker may choose to show a useful web resource here, for
example a support website. Any link added here opens in a separate web browser window. This tab
is hidden if the web page is disabled by the broker."* No screenshot exists.

---

## 8. The four buttons (Market, Signals, VPS, Tester)

These are **not tabs** and have no column headers; MetaQuotes calls them *"buttons opening MQL5
services in the lower panel of the Toolbox window"*. Clicking one replaces the Toolbox content
with that service's view.

**Market** (`en/market.png`) — a **card grid**, four across, each card: cover image, truncated
name, a five-star rating, and a price in deposit currency (`999 USD`, `5 000 USD` — space
thousands separator again). Above the grid: pagination `1 2 3 4 5 … 848` and a sort row
**`Most rated | New | Free | Price Up | Price Down`** (the active one in black, the rest as
blue links).

**Market → My Purchases** (`en/toolbox_market_purchases.png`) — a different layout: title
`My Purchases`, a `Search purchases` field with a magnifier, three right-aligned column
headers **`Version | Updated | Category`**, and section headings **`Updates`**,
**`Applications`**, **`Demo`**. Row actions are buttons: **`Buy`** (green fill), **`Test`**,
**`Open`**, **`Install`** (blue outline). An update row prints
`Available version 1.274` inline.

**Signals** (`en/toolbox_signals.png`) — a **card grid**, three across, each card: provider
avatar + country flag, provider name, signal name, growth `%` in green, `since <year>`, an
equity sparkline, a `Reliability` bar meter, an `Algo trading` percentage ring, a subscriber
count, and a `Copy for NN USD per month` footer with `1 usd per day` beneath. Sort buttons
across the top:
**`Rating ▲ | Signal/Equity | Growth/Weeks | Subscribers/Funds | Trades/Win | Max DD/PF | Price`**.

**VPS** and **Tester** — **no Toolbox-pane screenshot is published for either.**

---

## 9. Mobile

**There is no Toolbox on MT5 mobile.** Neither the Android nor the iPhone help uses the word.
The twelve desktop tabs are split across the bottom bar, the Android side panel, and the iOS
Settings screen.

**Android** — *"The interface of the MetaTrader 5 mobile platform consists of the main working
area, the bottom panel and the side panel, which allow switching between the main functions of
the program."* The side panel (opened from the ☰ button) lists, verbatim:

```
Quotes · Charts · Trade · History · Mailbox · News · Economic calendar · Messages ·
Traders Community · Trading applications · Settings · Journal · About
```

**iPhone / iPad** — *"The whole interface of the MetaTrader 5 mobile platform consists of the
main working area and the bottom panel, designed to switch between the main functions of the
program:"*

```
Quotes · Chart · Trade · History · Settings
```

with *"Settings provide access to application settings, MQL5.community chat, mailbox and news,
as well as allow opening accounts or switching between available accounts."*

Mapping to the desktop Toolbox:

| Desktop tab | Android | iOS |
|---|---|---|
| Trade | `Trade` bottom tab | `Trade` bottom tab |
| History | `History` bottom tab | `History` bottom tab |
| Mailbox | `Mailbox` side-panel item | inside `Settings` |
| News | `News` side-panel item | inside `Settings` |
| Journal | `Journal` side-panel item | **absent** |
| Calendar | **`Economic calendar` — opens the separate Tradays app, not an in-app screen** | **absent** |
| Market | `Trading applications` side-panel item | **absent** |
| Signals | within `Traders Community` | **absent** |
| **Exposure** | **absent** | **absent** |
| **Alerts, Articles, Code Base, Experts, Company** | **absent** | **absent** |
| — | `Messages` (push notifications) — **no desktop equivalent** | inside `Settings` |

The mobile Trade screen shows the same account-state field set the desktop strip draws from
(`Profit, currency`, `Balance`, `Credit`, `Assets`, `Liabilities`, `Commission`, `Blocked`,
`Equity`, `Margin`, `Free Margin`, `Margin Level`, `Total of deals`) — but as a **stacked block
at the top of the screen**, not a one-line strip. Its first field, **`Profit, currency`**, has
no desktop counterpart.

Row actions are a **swipe-left command strip** (close by, close/delete, modify, increase/place,
chart, Depth of Market) rather than a right-click menu, and sorting is a top-panel button
offering **symbol, ticket, time, profit**, *"applied separately"* to positions and orders.

---

## 10. Cross-checks against `02-toolbox-and-panels.md`

| `02` said | Now |
|---|---|
| 12 tabs in that order | **Confirmed**, re-read at 5× |
| `Ctrl+T`, `Ctrl+F9` | **Confirmed verbatim** |
| Trade default columns | **Confirmed**, including the two `Price` columns and spaced slashes |
| `🔒 Market` icon | **Wrong** — a yellow shopping bag |
| Summary line uses `Free Margin` / `Margin Level` | **Confirmed**, and now measured (two-space field separator, one-space before `%`) |
| News has a possible unidentified 4th column | **Resolved: there is no 4th column.** It is paint-over residue from the Russian base image |
| Articles columns unverifiable | **Resolved**: `Name | Category | Date`, plus the full context menu and category submenu |
| Calendar headers `Curr…` / `Pri…` | **Resolved**: full strings are `Currency` and `Priority`; the short forms are width truncation |
| Experts columns unverified | **Still unverified** |
| Code Base columns unverified | **Still unverified** |
| Toolbox auto-hide / pin / splitter unverified | **Still unverified**, but undocking is now *confirmed to exist* from the build-3081 release note |
| History desktop periods (4, Title Case) | **Confirmed**, and the Russian equivalent differs (`Выбрать период…`) |
| Four history view modes, default Deals | **Confirmed** |

New facts not in `02`: the **`Search` tab** and its seven sub-tabs; the window's former name
**`Terminal`**; the Russian window name **`Инструменты`**; the `⊕`/`⊖` strip glyph; the
Exposure-vs-Trade field-order disagreement inside one screenshot; the Articles `Indicators`
duplicate; the Calendar's comma thousands separator; the history gutter icon encoding; the
"Trading tab" and "Assets tab" prose slips.

---

## 11. MetaQuotes' self-contradictions, collected

1. **The window has four names**: `Toolbox` (title bar, hot keys page, interface page),
   `Terminal` (the title bar of the asset the interface page serves for Search),
   `Инструменты` (Russian build), and *"the lower panel of the Toolbox window"* (release notes,
   for the button row).
2. **"Trading tab" vs "Trade tab"**: *"The list of currently open positions is displayed in the
   **Trading** tab of the Toolbox window"*, while the tab reads `Trade` and the same page later
   writes *"its context menu on the **"Trade"** tab"*.
3. **"Assets tab" vs `Exposure`**: *"the total account status can be easily seen in the
   **Assets** tab"* and *"The **Assets** section is helpful for those trading Forex or
   futures"*. The tab reads `Exposure`; the Russian build reads `Активы` ( = Assets).
4. **`S/L` / `T/P` in prose vs `S / L` / `T / P` in the grid.** Both languages render the
   spaced form.
5. **`Code Base` (tab) vs `CodeBase` (Search sub-tab) vs `Библиотека` / Library (Russian).**
6. **Alert action `Email` (prose) vs `Mail` (dropdown).**
7. **Margin Call highlights the *line* (desktop) vs the *margin fields* (mobile)**; mobile omits
   Stop Out entirely.
8. **Calendar colour rule says "the indicator is highlighted"; the screenshot tints the whole row.**
9. **Number formatting is not consistent across tabs**: `3 370.75` / `1 076.68 %` (summary
   strip, space separator, space before `%`) vs `1,050.0B` / `3.4%` (Calendar, comma separator,
   no space before `%`).
10. **`Articles → Categories` lists `Indicators` twice.**
11. **History: `Profit: 591.31` on the strip vs `626.68` as the Profit column total**, in one
    screenshot, unexplained.
12. **Exchange-model field order differs between the Trade strip (`Balance · Liabilities ·
    Equity · Free Margin`) and the Exposure strip (`Balance · Equity · Liabilities ·
    Liquidation value`)** in the same image.
13. **`Find next` vs `Find Previous`** — adjacent items in one documented menu, different casing.
14. **The main menu is documented as "File, View, Inset, Charts, Tools, Window, Help"** —
    `Inset` is a live typo.
15. **Russian history period `Выбрать период…` carries an ellipsis; English `Custom Period`
    does not.**
16. **The `⊕` strip shows five fields and the `⊖` strip shows four**, which is backwards for an
    expand/collapse control.

---

## Could not verify

1. **Whether Toolbox tabs can be reordered or hidden by the user.** No MetaQuotes source either
   way. Only `Company` is documented as hideable, and by the broker.
2. **How the Toolbox is undocked and re-docked.** Undocking is *confirmed to exist* (build 3081
   release note) but the gesture, the menu item, if any, and the re-dock affordance are
   undocumented and unscreenshotted.
3. **Toolbox auto-hide, pinning, splitter drag and minimum height.** No MetaQuotes source.
4. **The exact Margin Call wording, and the exact red used.** The help gives one sentence and no
   screenshot. There is no Margin Call banner, dialog or toast string in the MT5 desktop help at
   all. Whether `Stop Out` renders differently from `Margin Call` is also unstated.
5. **What the expanded account summary strip contains.** The `⊕`/`⊖` control is never documented
   and no published screenshot shows an expanded state.
6. **Exposure's context menu, if it has one.** Never published, never described.
7. **The Experts tab's column headers.** Documented as a log like Journal but never rendered.
8. **The Calendar's priority level names, its period-menu strings, and its filter-menu strings.**
   All three are described in prose ("by priority", "previous, current and next week") with no
   verbatim strings and no unobstructed screenshot.
9. **The Code Base tab's columns, row rendering and context menu.** No screenshot, no prose.
10. **The News tab's middle column header.** The column is proven to exist (hot key `R`); its
    header row is overlapped in both the English and the Russian asset.
11. **The Articles tab's middle column header.** Same situation — covered by the open context
    menu in the one published image. `Category` is inferred from the menu item, not read.
12. **History `Positions`-mode, `Orders`-mode and `Orders & Deals`-mode column headers.**
    MetaQuotes screenshots only Deals mode. Positions mode is described in prose
    (*"Position opening and closing time determined by the first and last trade respectively /
    Position volume… / The weighted average position opening price and its closing price / The
    total financial result of deals related to the position / Position Stop Loss and Take
    Profit…"*) but never as a header list.
13. **The `Columns ▸` submenu** on any tab — its exact contents and whether its entries are the
    help's field names or different strings.
14. **The `Report ▸` submenu's exact parenthesised strings.** `Overview` is MetaQuotes-confirmed;
    the long forms are broker/guide sources only.
15. **The Exposure pie's short-side title string.** The title is a toggle; only `Long Positions`
    is ever shown.
16. **The rule that greys `Market` / `Signals` / `VPS` / `Tester`.** `VPS` grey with `Signals`
    active, and `Signals` grey with `VPS` active, are both observed; no source explains either.
17. **Whether the `Search` tab exists in the current build and what it looks like.** The only
    asset is from the `Terminal`-titled generation, though the current help still serves it.
18. **The Company tab's rendering.** No screenshot.
19. **Whether any tab is conditional on an MQL5.community login.** Nothing states it; the greyed
    `Signals` **button** is the only hint, and it is a button.
20. **The default visible column set's stability.** English and Russian History screenshots show
    different defaults; which is current, and whether the set is per-build or per-user, is
    unstated.
21. **VPS and Tester as Toolbox panes.** No screenshot of either in the Toolbox.

## Sources

MetaQuotes MT5 help:
[User Interface (the only Toolbox description)](https://www.metatrader5.com/en/terminal/help/startworking/interface) ·
[Executing Trades (Trade, Exposure, History, Alerts)](https://www.metatrader5.com/en/terminal/help/trading/performing_deals) ·
[Mailbox](https://www.metatrader5.com/en/terminal/help/start_advanced/mail) ·
[Platform Logs (Journal, Experts, Log Viewer)](https://www.metatrader5.com/en/terminal/help/start_advanced/journal) ·
[Fundamental Analysis (News, Calendar)](https://www.metatrader5.com/en/terminal/help/charts_analysis/fundamental) ·
[Where to Find Trading Robots and Indicators (Market, Code Base)](https://www.metatrader5.com/en/terminal/help/algotrading/algotrading_get_ea_indicator) ·
[How to Purchase an App (Market pane)](https://www.metatrader5.com/en/terminal/help/market/market_buy) ·
[How to Choose a Signal (Signals pane)](https://www.metatrader5.com/en/terminal/help/signals/signal_monitoring) ·
[Hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[Chart Management (the only documented `Docked` command)](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage) ·
[Trading Report](https://www.metatrader5.com/en/terminal/help/trading/report) ·
[Trading Report (history export)](https://www.metatrader5.com/en/terminal/help/trading_advanced/history_report) ·
[Russian: Executing Trades](https://www.metatrader5.com/ru/terminal/help/trading/performing_deals)

MetaQuotes release notes:
[build 3081 — "buttons opening MQL5 services in the lower panel of the Toolbox window… inactive when the window was undocked"](https://www.metatrader5.com/en/releasenotes/terminal/2212)

MetaQuotes mobile help:
[Android — Getting Started (bottom panel + side panel)](https://www.metatrader5.com/en/mobile-trading/android/help/getting_started) ·
[Android — Trade](https://www.metatrader5.com/en/mobile-trading/android/help/trade) ·
[Android — History](https://www.metatrader5.com/en/mobile-trading/android/help/history) ·
[Android — Settings](https://www.metatrader5.com/en/mobile-trading/android/help/settings) ·
[iPhone — Getting Started (five bottom tabs)](https://www.metatrader5.com/en/mobile-trading/iphone/help/getting_started) ·
[iPhone — Trade](https://www.metatrader5.com/en/mobile-trading/iphone/help/trade)

Screenshots read directly (all under `https://www.metatrader5.com/i/help/terminal/`):
`en/position_manage.png` + `en/position_manage_x2.png` (1800×1199 — **the primary source: the
tab strip, the Trade grid, both Toolbox dock states and the summary line, all in one image**) ·
`en/history.png` / `_x2.png` (History columns, context menu, summary strip) ·
`en/exposure.png` / `_x2.png` · `en/exposure_forex.png` / `_x2.png` ·
`en/exposure_exchange.png` / `_x2.png` (**the only exchange-model account**) ·
`en/alerts.png` / `_x2.png` (Alerts columns, context menu, Alert Editor) ·
`en/mail.png` (Mailbox columns and context menu; Win7-era) ·
`en/articles.png` (**the only Articles-tab image**) ·
`en/fundamental_calendar.png` (Calendar, truncated headers) ·
`en/fundamental_calendar_event.png` (**Calendar with full headers and the context menu**) ·
`en/fundamental_news.png` (News; the paint-over artefact) ·
`en/news_categories.png` (the `News categories` dialog) ·
`en/journal.png` (Journal columns) ·
`en/toolbox_search.png` (**the `Search` tab, and the `Terminal` title bar**) ·
`en/market.png`, `en/toolbox_market_purchases.png` (Market pane and My Purchases) ·
`en/toolbox_signals.png` (Signals pane and its sort buttons) ·
`en/close_position.png` / `_x2.png`, `en/bulk_positions.png` / `_x2.png` (Trade context menu,
Bulk Operations submenu) ·
`en/interface_overview.png` / `_x2.png`, `en/interface_overview2_x2.png` ·
`ru/history.png` (**the Russian default column set and period menu, and `Инструменты`**) ·
`ru/position_manage.png` (Russian summary line and tab labels) ·
`ru/fundamental_news.png` (**the proof that the English News image has no 4th column**)

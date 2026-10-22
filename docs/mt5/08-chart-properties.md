# MT5 Chart Properties (F8) and the price scale — verified specification

Researched 2026-10-05 from MetaQuotes' own MT5 help, the MQL5 reference, and MetaQuotes'
own help screenshots read pixel by pixel after 4–20× upscaling. Every claim carries a source.
Where a fact could not be established this document says so rather than filling the gap, and
the gaps are listed in "Could not verify" at the end. MT4 material is not mixed in anywhere.

**The help page is not where we thought it was.** `charts_advanced/charts_properties` is a
404. The real page is
[`charts_advanced/charts_settings`](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings),
titled **"Chart Settings"**. Likewise `start_advanced/settings` is a 404; the Options page is
[`startworking/settings`](https://www.metatrader5.com/en/terminal/help/startworking/settings).

## The headline answer

**MT5 has no logarithmic price scale, and no percentage price scale.** Not in the dialog,
not in the context menu, not in the API. Our TradingView-style `Linear | Log | Percent`
control has no MetaTrader equivalent and should be deleted outright — there is no part of it
to keep. See section 5 for the proof.

## Corrections to assumptions we held

1. **The window title is `Properties of <SYMBOL>,<TIMEFRAME>`** — MetaQuotes' screenshots
   read `Properties of EURUSD,M1` and `Properties of EURUSD,H1`. Confirmed; `03-chart-ui.md`
   already had this right.
2. **The Colors tab's second field is labelled `Foreground:` in the dialog but "Text" in
   MetaQuotes' prose** — in *both* the English and the Russian help ("Текст"). The dialog
   wins. `03-chart-ui.md` was right to say Foreground, but understated this: it is a
   two-language prose error, not a one-off typo.
3. **The scheme list is contradicted three ways.** The Chart Settings page says **four**
   ("Yellow on Black", "Green on Black", "Black on White", "Color on White"); the
   View and Configure Charts page says **"three color schemes of charts are available"**; and
   the only screenshot with the dropdown open shows **three entries** before the magnifier
   lens cuts it off. There is **no "Custom" entry** — custom schemes are saved as templates.
4. **The Show tab's checkbox labels are sentence case in the dialog** (`Show bid price line`)
   and title case in the prose ("Show Bid price line"). Same for Ask and Last.
5. **The Common tab's radio labels are `Bar chart` / `Candlesticks` / `Line chart` in the
   dialog**, but **"Bar chart" / "Candlestick" / "Line"** in the prose and **"Bar Chart" /
   "Candlesticks" / "Line Chart"** in the context menu. Three spellings of the same three
   things, all MetaQuotes'.
6. **`Chart on foreground` (dialog) vs "Chart in foreground" (prose)**, and
   **`Chart auto scroll` (dialog, three words) vs "Chart autoscroll" (prose, one word)**.
   `03-chart-ui.md` had "Chart on foreground" and "Chart auto scroll" — correct.
7. **`Scale fix one to one` sits ABOVE `Scale fix`**, not below it. The order is
   Scale → Scale fix one to one → Scale fix → Fixed maximum → Fixed minimum →
   Scale points per bar → Points per bar.
8. **`Points per bar` is a dropdown (combobox), not a spinner.** `Fixed maximum` and
   `Fixed minimum` are spinners. All three labels sit to the **right** of their control.
9. **"Show tick volumes" and "Show real volumes" are mutually exclusive**, because the API
   models them as one tri-state enum (`ENUM_CHART_VOLUME_MODE`: hide / tick / real), not two
   booleans.
10. **"Show ticker" and "Show OHLC" are coupled, not independent.** Turning OHLC on forces
    the ticker on; turning the ticker off forces OHLC off.
11. **There is no "Show chart symbol watermark" and no "Show period description"** in MT5
    desktop. Neither string appears in the help, in the screenshot, or in the chart property
    enums. (Both are TradingView vocabulary.)
12. **Options → Charts has no logarithmic-scale control either**, and its trade-level
    dragging is **one dropdown with three values**, not three checkboxes as the prose implies.

## 1. The dialog itself

### Exact window title

```
Properties of EURUSD,M1
Properties of EURUSD,H1
```

Pattern: **`Properties of <SYMBOL>,<TIMEFRAME>`**. No space after the comma. Read from
`chart_properties_common.png`, `chart_properties_colors.png` (both `EURUSD,M1`) and
`chart_properties_show.png` (`EURUSD,H1`). MetaQuotes never transcribes the title in prose.

### Opening it — four names for one window

**F8 is confirmed twice**, with two different descriptions:

- Hot keys page: **"F8 — Call the chart setup window."**
- Chart Management page: **"F8 — open the properties window;"**

Every other route, verbatim:

- Chart Settings page: **"Click "⚙ Properties" in the Charts menu or in the chart context
  menu."**
- View and Configure Charts page: **"To open chart properties, click "⚙ Properties" in the
  context menu or the Charts menu."**
- Context menu: the last item, **`Properties`**, with **`F8`** printed beside it (read off
  `chart_trading_menu.png`).

**MetaQuotes gives this one window four different names**: the help page is titled
*"Chart Settings"*, the hot-keys table calls it *"the chart setup window"*, the chart-management
page calls it *"the properties window"*, and the title bar reads *"Properties of EURUSD,M1"*.
All four are MetaQuotes'. Unreconciled.

The menu bar containing the **Charts** menu reads `File · View · Insert · Charts · Tools ·
Window · Help` (read off `char_color.png`). **MetaQuotes writes both "the Charts menu" and
"the "Chart" menu"** — the Chart Management page's heading is *"Chart Managing Using the
Context Menu and the "Chart" Menu"* while its first sentence says *"the "Charts" menu"*.
The menu bar itself reads **Charts**.

### Tabs — three, in this order

```
Common | Show | Colors
```

Confirmed from **two different build generations** of MetaQuotes screenshot: the Windows-7-era
`chart_properties_common.png` / `chart_properties_colors.png` and the modern
`chart_properties_show.png`. Both show exactly these three tabs in this order, so the count
and order are stable across builds.

The page's own in-page table of contents gives them **three more names**: *"General Settings"*,
*"Setup of Displayed Information"*, *"Color Settings"*. These are section headings, not tab
labels; the tab labels are Common / Show / Colors.

### Buttons at the bottom, in order

```
[ OK ]  [ Cancel ]  [ Help ]
```

Bottom-right, left to right, **OK focused** (blue focus ring in both generations).
**There is no Apply button.** Confirmed on all three tab screenshots.

### Layout

The dialog is split vertically. The **left half is a live chart preview** (roughly 60% of the
width); the right half holds the tab strip and the controls. The preview is not decorative —
MetaQuotes states the Scale slider **"also changes the chart scale in the preview window
located in the left part of the properties window."**

Dialog size in the published assets: 713 × 503 px (Win7-era) and 795 × 499 px (modern).

## 2. The Colors tab

### Exactly 13 colour fields, in order, with a trailing colon

Read off `chart_properties_colors.png` at 4×. Every label carries a **trailing colon** and is
**right-aligned** to the left of its control. Each control is a **colour-picker combobox**:
a square swatch, then the colour's Windows name as text, then a dropdown arrow.

| # | Dialog label | MetaQuotes' prose label | MQL5 property | Meaning (verbatim) |
|---|---|---|---|---|
| — | `Scheme:` | "Scheme" / RU "Цветовая схема" | — | "select a predefined chart color scheme" |
| 1 | `Background:` | Background | `CHART_COLOR_BACKGROUND` | "the chart background color" |
| 2 | **`Foreground:`** | **"Text"** ⚠ | `CHART_COLOR_FOREGROUND` | "the color of axes, scale and OHLC line" |
| 3 | `Grid:` | Grid | `CHART_COLOR_GRID` | "grid color" |
| 4 | `Bar up:` | Bar up | `CHART_COLOR_CHART_UP` | "the color of an up bar, tails and edges of a bullish candlestick's body" |
| 5 | `Bar down:` | Bar down | `CHART_COLOR_CHART_DOWN` | "the color of a down bar, tails and edges of a bearish candlestick's body" |
| 6 | `Bull candle:` | Bull candle | `CHART_COLOR_CANDLE_BULL` | "the color of the bullish candlestick body" |
| 7 | `Bear candle:` | Bear candle | `CHART_COLOR_CANDLE_BEAR` | "the color of the bearish candlestick body" |
| 8 | `Line chart:` | Line chart (RU: "Линия") | `CHART_COLOR_CHART_LINE` | "the color of the chart line and Doji candlesticks" |
| 9 | `Volumes:` | Volumes | `CHART_COLOR_VOLUME` | "the color of volumes **and position opening levels**" |
| 10 | `Bid price line:` | Bid price line | `CHART_COLOR_BID` | "the color of the Bid price line" |
| 11 | `Ask price line:` | Ask price line | `CHART_COLOR_ASK` | "the color of the Ask price line" |
| 12 | `Last price line:` | Last price line | `CHART_COLOR_LAST` | "the color of the price line of the latest executed trade" |
| 13 | `Stop levels:` | Stop levels | `CHART_COLOR_STOP_LEVEL` | "the color of stop order (Stop Loss and Take Profit) levels" |

The 13 fields map **1:1 onto the 13 `CHART_COLOR_*` constants** in
`ENUM_CHART_PROPERTY_INTEGER`. There is no 14th colour and no colour the dialog omits.

⚠ **Field 2 is the one real label contradiction on this tab.** The dialog reads
`Foreground:`; the English prose reads *"Text — the color of axes, scale and OHLC line"* and
the Russian prose reads *"Текст"* (= Text). The MQL5 constant is `CHART_COLOR_FOREGROUND`.
Two of three say Foreground. **Use `Foreground:`.**

Two semantics that will bite an implementer:

- **`Volumes:` also colours position opening levels**, not just the volume histogram.
- **`Line chart:` also colours Doji candlesticks**, in candlestick mode, not just line mode.

### The scheme dropdown

Label in the dialog: **`Scheme:`** (read off the screenshot). Label in the Russian prose:
*"Цветовая схема"* (Color scheme). The English prose just calls it "Scheme".

**The names are English in both language builds** — the Russian help prints them untranslated
and glosses them in parentheses:

```
Yellow on Black
Green on Black
Black on White
Color on White
```

Verbatim, English: **"Scheme — select a predefined chart color scheme. Four color schemes are
available: "Yellow on Black", "Green on Black", "Black on White" and "Color on White". Custom
color schemes can be saved using templates."**

Verbatim, Russian: **""Yellow on Black" (желтое на черном), "Green on Black" (зеленое на
черном), "Black on White" (черном на белом) и "Color on White" (цветное на белом)."**

**Three-way contradiction on the count:**

| Source | Count | Names given |
|---|---|---|
| Chart Settings page (EN + RU) | **4** | Yellow on Black, Green on Black, Black on White, Color on White |
| View and Configure Charts page | **3** | "For convenience, three color schemes of charts are available in the platform." — none named |
| `char_color.png`, dropdown open | **3 visible** | Yellow on Black, Green on Black, Black on White (highlighted) — a fourth row, if any, falls outside the magnifier lens |

**Take four, in the Chart Settings page's order**, and note that `Color on White` is the
fourth. **There is no "Custom" entry** — our assumption of `Yellow on Black / Green on Black /
Black on White / Custom` is wrong on the fourth name. Custom schemes are saved as *templates*,
which is a separate mechanism.

### Which colour each scheme sets each field to

**MetaQuotes publishes values for exactly one scheme: Black on White.** Read off
`chart_properties_colors.png` at 4× (and corroborated by the Russian asset, which shows the
same scheme). The values are rendered as **named Windows colours**, which is how the combobox
displays them:

| Field | Black on White |
|---|---|
| Background | `White` |
| Foreground | `Black` |
| Grid | `Silver` |
| Bar up | `Black` |
| Bar down | `Black` |
| Bull candle | `White` |
| Bear candle | `Black` |
| Line chart | `Black` |
| Volumes | `Green` |
| Bid price line | `Silver` |
| Ask price line | `Silver` |
| Last price line | `Silver` |
| Stop levels | `OrangeRed` |

**The other three schemes' values are nowhere in MetaQuotes' help or the MQL5 reference.**
No screenshot shows Yellow on Black, Green on Black or Color on White with the Colors tab
open. UNVERIFIED — do not invent them.

## 3. The Common tab

Read off `chart_properties_common.png` at 4× and 8×. **Three bordered group boxes**, in this
order. Labels for the radios and checkboxes sit to the **right** of the control and carry
**no colon**; labels for the three value fields also sit to the **right** of the control and
also carry **no colon**.

### Group 1 — chart type (radio buttons, exactly one selected)

| # | Label | Control | Shortcut | MQL5 |
|---|---|---|---|---|
| 1 | `Bar chart` | Radio | Alt+1 | `CHART_BARS` |
| 2 | `Candlesticks` | Radio (selected in the screenshot) | Alt+2 | `CHART_CANDLES` |
| 3 | `Line chart` | Radio | Alt+3 | `CHART_LINE` |

`ENUM_CHART_MODE` has exactly these three members, so there is no API surface for a fourth
chart type. (Heikin Ashi remains a bundled custom indicator on desktop.)

### Group 2 — three independent checkboxes

| # | Label | Control | MQL5 | Meaning (verbatim) |
|---|---|---|---|---|
| 4 | `Chart on foreground` | Checkbox | `CHART_FOREGROUND` | "place the chart in the foreground. If the function is enabled, all analytical objects appear in the background." |
| 5 | `Chart shift` | Checkbox | `CHART_SHIFT` | "shift the chart from the right edge of the window to the shift mark." |
| 6 | `Chart auto scroll` | Checkbox | `CHART_AUTOSCROLL` | "enable/disable automatic chart shift to the left with the beginning of new bar formation. If the option is enabled, the chart always shows the last bar." |

All three are **unticked** in the screenshot. That is the state of MetaQuotes' demo chart, not
a documented default — see "Could not verify".

### Group 3 — the scale block, in dialog order

| # | Label | Control | Enabled by | MQL5 |
|---|---|---|---|---|
| 7 | `Scale` | **Horizontal slider**, label to the right of the track | always | `CHART_SCALE`, `int from 0 to 5` |
| 8 | `Scale fix one to one` | Checkbox | always | `CHART_SCALEFIX_11` (bool) |
| 9 | `Scale fix` | Checkbox | always | `CHART_SCALEFIX` (bool) |
| 10 | `Fixed maximum` | **Number input + up/down spinner**, label to the right | `Scale fix` | `CHART_FIXED_MAX` (double) |
| 11 | `Fixed minimum` | **Number input + up/down spinner**, label to the right | `Scale fix` | `CHART_FIXED_MIN` (double) |
| 12 | `Scale points per bar` | Checkbox | always | `CHART_SCALE_PT_PER_BAR` (bool) |
| 13 | `Points per bar` | **Dropdown (combobox)**, label to the right | `Scale points per bar` | `CHART_POINTS_PER_BAR` (double) |

Values rendered in the screenshot, all greyed because their enabling checkbox is unticked:
`Fixed maximum` = `1.44500`, `Fixed minimum` = `1.44200`, `Points per bar` = `1.00`.
`Fixed maximum/minimum` are shown at **5 decimal places** (symbol digits);
`Points per bar` at **2**.

**`Scale` has no visible tick marks** on the track and no numeric readout. The slider thumb
sits left of centre. The 0–5 range comes from MQL5 (`CHART_SCALE`, "int from 0 to 5"), i.e.
**six discrete steps**; the screenshot alone cannot confirm the step count.

Verbatim semantics for the scale controls are in section 5, because that is where they matter.

## 4. The Show tab

Read off `chart_properties_show.png` at 4×. **Exactly 13 checkboxes, one flat column, no
group boxes, no sub-indentation.** Labels sit to the right of the box, no colon, sentence case.

| # | Dialog label | Prose label (where it differs) | MQL5 | Shortcut |
|---|---|---|---|---|
| 1 | `Show ticker` | — | `CHART_SHOW_TICKER` | — |
| 2 | `Show OHLC` | — | `CHART_SHOW_OHLC` | Ctrl+H |
| 3 | `Show quick trading buttons` | — | `CHART_SHOW_ONE_CLICK` | Alt+T (context menu: "One Click Trading") |
| 4 | `Show bid price line` | "Show **B**id price line" | `CHART_SHOW_BID_LINE` | — |
| 5 | `Show ask price line` | "Show **A**sk price line" | `CHART_SHOW_ASK_LINE` | — |
| 6 | `Show last price line` | "Show **L**ast price line" | `CHART_SHOW_LAST_LINE` | — |
| 7 | `Show period separators` | — | `CHART_SHOW_PERIOD_SEP` | Ctrl+Y |
| 8 | `Show grid` | — | `CHART_SHOW_GRID` | Ctrl+G |
| 9 | `Show tick volumes` | — | `CHART_SHOW_VOLUMES` = `CHART_VOLUME_TICK` | Ctrl+L |
| 10 | `Show real volumes` | — | `CHART_SHOW_VOLUMES` = `CHART_VOLUME_REAL` | Ctrl+K |
| 11 | `Show object descriptions` | — | `CHART_SHOW_OBJECT_DESCR` | — |
| 12 | `Show trade levels` | — | `CHART_SHOW_TRADE_LEVELS` | — |
| 13 | `Show trade history` | — | `CHART_SHOW_TRADE_HISTORY` | — |

Tick state in MetaQuotes' screenshot: **ticked** — Show ticker, Show quick trading buttons,
Show bid price line, Show grid, Show trade levels, Show trade history. **Unticked** —
everything else. Again, that is the demo chart's state, not a documented default.

### Mutual exclusions and couplings — this is where the flat checkbox list lies

1. **`Show tick volumes` and `Show real volumes` are mutually exclusive.** They look like two
   independent checkboxes but the API exposes a single property `CHART_SHOW_VOLUMES` taking
   one of three values: `CHART_VOLUME_HIDE`, `CHART_VOLUME_TICK`, `CHART_VOLUME_REAL`. There
   is no state in which both are on. Implement as a tri-state, rendered as two checkboxes.
2. **`Show ticker` and `Show OHLC` are coupled, asymmetrically.** Verbatim:
   **"Setting CHART_SHOW_TICKER to 'false' also sets CHART_SHOW_OHLC to 'false' and disables
   OHLC"** and **"Setting CHART_SHOW_OHLC to 'true' also sets CHART_SHOW_TICKER to 'true' and
   enables the ticker"**. So: unticking the ticker unticks OHLC; ticking OHLC ticks the
   ticker. The other two transitions are free.
3. **`Show tick volumes` is disabled while `Scale fix` is on.** Verbatim: **"The option is
   unavailable with scale fix enabled."** (RU: *"При фиксированном масштабе эта опция не
   работает."*) MetaQuotes says this of tick volumes only, **not** of real volumes.
4. **`Show real volumes` is broker/instrument-gated.** **"The option is only available for
   exchange-traded instruments."**
5. **`Show last price line` is server-gated.** **"This line can only be displayed if the
   appropriate symbol price is provided by the server."**
6. **`Show trade levels` is gated by the global Options setting.** **"The option is only valid
   if the same option is enabled in the platform settings."**
7. **`Show trade history` is per-chart with a global default.** **"The option affects the
   specific selected chart. To set a default property value for all charts, use platform
   settings."**

### Options → Charts tab (the global defaults)

Read off `options_charts.png` at 5×. Title bar `Options`; tab strip
`Server · Charts · Trade · Expert Advisors · GPU · Events · Notifications · Email · FTP ·
Community`; buttons `OK · Cancel · Help`.

| # | Dialog label | Control | Prose label (where it differs) |
|---|---|---|---|
| 1 | `Chart color print` | Checkbox | "Color print" |
| 2 | `Show trade history` | Checkbox | — |
| 3 | `Show trade levels` | Checkbox | — |
| 4 | *(unlabelled, indented under 3)* | **Dropdown**, shown as `Enable dragging of trade levels` | the prose writes the three values as if they were three separate options |
| 5 | `Preload chart data for open positions and orders` | Checkbox | — |
| 6 | `Show object properties after creation` | Checkbox | — |
| 7 | `Select object by single mouse click` | Checkbox | "Select **objects** by single mouse click" |
| 8 | `Precise time scale` | Checkbox | — |
| 9 | `Select object after creation` | Checkbox | "Select **objects** after creation" |
| 10 | `Magnet sensitivity:` | Dropdown (editable), `10` | — |
| 11 | `Max bars in chart:` | Dropdown (editable), `100000` | "Max. bars in chart" / elsewhere "Max. bars **on** chart" |

The three values of control 4, verbatim from the prose:
**"Disable dragging of trade levels"**, **"Enable dragging of trade levels"**,
**"Enable dragging of trade levels with "Alt" key"**. In MQL5 this is `CHART_DRAG_TRADE_LEVELS`,
**"The drag mode is enabled by default (true value)"**.

Ticked in the screenshot: Show trade levels, Preload chart data…, Select object after
creation. **No logarithmic, percent or scale-type control anywhere on this tab.**

## 5. The price scale — definitive

### 5.1 Does MT5 have a logarithmic price scale? **No.**

Four independent negatives:

1. **`ENUM_CHART_PROPERTY_INTEGER` has no logarithmic property.** The full enum was extracted
   and read: 60 integer properties, 7 double properties, 3 string properties. The strings
   "logarithm", "log scale" and "percent" (as a scale mode) do not occur anywhere in it. The
   only scale properties are `CHART_SCALE` (int 0–5), `CHART_SCALEFIX` (bool),
   `CHART_SCALEFIX_11` (bool), `CHART_SCALE_PT_PER_BAR` (bool), `CHART_POINTS_PER_BAR`,
   `CHART_FIXED_MAX`, `CHART_FIXED_MIN`. **There is no enum at all named `ENUM_CHART_SCALE`** —
   that name does not exist in the MQL5 reference; `CHART_SCALE` is a plain integer property.
2. **The Chart Settings page lists every Common-tab control and none is a scale type.**
3. **The Options → Charts tab has no such control.** (Screenshot read at 5×.)
4. **An MQL5 forum moderator states it outright.** Oleksandr Medviediev, moderator, thread
   "visual of the logarithmic chart on MT5": **"MT5 does not have a built-in option to switch
   the price chart to a logarithmic scale (it always uses a linear scale for price
   representation)."**

Corroborating, not load-bearing: a **paid third-party MQL5 Market product** exists purely to
supply this — *"Logarithmic chart for MT5"* by Bahador Baradari, 125 USD, which works by
generating a **custom symbol**: "This Expert Advisor create a customize symbol for any symbol
you want and it plot logarithmic chart for that." A commercial workaround built on synthetic
symbols is what you build when the platform has no such mode.

**Verdict: delete the `Linear | Log | Percent` control entirely.** There is no partial
equivalent to keep. MT5's vertical-scale vocabulary is *auto* (the default) versus the three
*fixing* modes below — a different axis of control altogether.

### 5.2 The three scale-fixing controls — exact labels and exact behaviour

All three are **checkboxes on the Common tab of Chart Properties**, in this dialog order.

**`Scale fix one to one`** — `CHART_SCALEFIX_11`

> "Scale fix one to one — fix the chart scale as "one to one" (the size of one pip of the
> vertical axis in pixels is equal to the distance between the bar axes in pixels). In this
> case the "Scale fix" option is enabled automatically, and a scroll bar appears at the right
> side of the window that allows to move the chart vertically. This mode allows drawing
> precise geometrical constructions."

Three consequences to implement: (a) ticking it **auto-ticks `Scale fix`**; (b) a **vertical
scrollbar appears at the right edge of the chart window**; (c) 1 pip vertically = 1 bar
spacing horizontally, in pixels.

The dialog label is `Scale fix one to one` (five words, all lower case after the first).
Russian: *"Фиксировать масштаб 1:1"*. Our assumed label "Scale fix One to One" has wrong
capitalisation.

**`Scale fix`** — `CHART_SCALEFIX`

> "Scale fix — fix the chart scale vertically. When this option is selected, additional
> scaling parameters "Fixed maximum" and "Fixed minimum" for setting the minimum and maximum
> value of the price scale become active."

So `Scale fix` on ⇒ `Fixed maximum` and `Fixed minimum` become editable; off ⇒ both greyed.
It also disables `Show tick volumes` (section 4).

**`Scale points per bar`** — `CHART_SCALE_PT_PER_BAR`

> "Scale points per bar — fix the chart scale by the ratio of points on the vertical axis to
> one bar. Specify the number of bars in the "Points per bar" field."

⚠ **"Specify the number of bars" is a MetaQuotes error.** You specify the number of *points*,
not bars — the field is literally "Points per bar", the property is `CHART_POINTS_PER_BAR`
("Scale in points per bar"), and the Russian original says *"в нем укажите их количество"*
("specify **their** number", antecedent = пунктов = points). The English is a mistranslation.

The dialog label is **`Scale points per bar`** — note it does **not** read "Scale (points per
bar)". The dependent field below it is **`Points per bar`**. Our assumed "Scale (points per
bar)" is wrong.

### 5.3 Where each control lives

| Control | Chart Properties → Common | Price-scale right-click menu | Chart context menu |
|---|---|---|---|
| `Scale` (0–5 slider) | **Yes** | no | only indirectly: `Zoom In` / `Zoom Out` |
| `Scale fix one to one` | **Yes** | no | no |
| `Scale fix` | **Yes** | no | no |
| `Fixed maximum` / `Fixed minimum` | **Yes** | no | no |
| `Scale points per bar` / `Points per bar` | **Yes** | no | no |

**There is no right-click context menu on the price scale, and MetaQuotes documents none.**
The Chart Management page enumerates fourteen distinct mouse behaviours and gives the price
scale exactly two of them, both drag/click, neither a menu:

> "click-and-hold on the vertical scale of the chart and move the cursor vertically to change
> the vertical scale of the chart; double-click on the vertical scale of the chart to restore
> the chart scale"

and, for the menu:

> "right-click **anywhere in the chart window** to open the context menu of the chart"

The chart context menu is the same one everywhere; MetaQuotes draws no distinction between
right-clicking the plot area and right-clicking the scale. Treat the price scale as having
**drag to rescale** and **double-click to reset**, plus the ordinary chart context menu, and
nothing else. (Marked UNVERIFIED rather than proven absent — see the end.)

Related keyboard behaviour, from the hot-keys page:

- **`NumPad 5` — "Restoring of automatic chart vertical scale after its being changed. If the
  scale was defined, this hot key will return the chart into the visible range."**
- **`↑` / `↓` — "Fast chart scroll to the left / right; in case of a fixed scale — chart
  scroll upwards / downwards."** So the arrow keys change meaning when a scale is fixed.
- `+` zoom in, `-` zoom out. `Ctrl` + mouse wheel scales the chart.

And one API note worth building to: `CHART_MOUSE_SCROLL` is **"Scrolling the chart
horizontally using the left mouse button. Vertical scrolling is also available if the value of
any following properties is set to true: CHART_SCALEFIX, CHART_SCALEFIX_11 or
CHART_SCALE_PT_PER_BAR"**. Vertical drag-scroll of the plot area exists **only** while one of
the three fixing modes is on.

### 5.4 What MT5 has that we do not model

`CHART_SHOW_PRICE_SCALE` ("Showing the time scale on a chart" / price scale) and
`CHART_SHOW_DATE_SCALE` exist as API booleans. **Neither has a control in the Chart Properties
dialog or in Options.** They are programmatic only. Do not add UI for them.

## 6. The chart background context menu

Read off `chart_trading_menu.png` at 4× — a modern build, GBPJPY Daily, with a position open.
**The shortcuts below are the ones MetaQuotes prints in the menu itself.** Group separators
are shown as `———`.

| # | Label | Shortcut | Notes |
|---|---|---|---|
| 1 | `Sell Limit 1` ` 219.306` | — | **Dynamic.** The order type depends on where you right-clicked relative to the current price; the trailing number is that price level. |
| 2 | `Trading` ▸ | — | Submenu, see below |
| ——— | | | |
| 3 | `Depth Of Market` | `Alt+B` | |
| 4 | `One Click Trading` | `Alt+T` | |
| 5 | `Indicator List` | `Ctrl+I` | greyed when none |
| 6 | `Object List` | `Ctrl+B` | greyed when none |
| 7 | `Expert List` | `Alt+X` | greyed when none |
| ——— | | | |
| 8 | `Bar Chart` | `Alt+1` | |
| 9 | `Candlesticks` | `Alt+2` | shown active (icon framed) |
| 10 | `Line Chart` | `Alt+3` | |
| ——— | | | |
| 11 | `Timeframes` ▸ | — | |
| 12 | `Templates` ▸ | — | |
| 13 | `Refresh` | — | |
| ——— | | | |
| 14 | `Docked` | `Alt+D` | toggle, shown active |
| 15 | `Grid` | `Ctrl+G` | toggle |
| 16 | `Auto Scroll` | — | toggle |
| 17 | `Chart Shift` | — | toggle, shown active |
| ——— | | | |
| 18 | `Volumes` | `Ctrl+K` | toggle |
| 19 | `Tick Volumes` | `Ctrl+L` | toggle |
| 20 | `Trade Levels` | — | toggle |
| 21 | `Trade History` | — | toggle |
| ——— | | | |
| 22 | `Zoom In` | `+` | |
| 23 | `Zoom Out` | `-` | |
| 24 | `Delete Indicators Window` | — | greyed outside an indicator subwindow |
| 25 | `Step by Step` | `F12` | |
| ——— | | | |
| 26 | `Save as Picture` | — | |
| ——— | | | |
| 27 | `Properties` | `F8` | |

`Trading` submenu, in order: `Sell Limit 1  219.306`, `Buy Stop 1  219.306`,
`Take Profit  219.306`, `Alert  219.306`, ———, `New Order  F9`. Verbatim on why the order
types change: **"Depending on the cursor position, available order types are displayed in the
menu. If the menu is activated above the current price, a user can place Sell Limit and Buy
Stop orders. If the menu is activated below the current price, Buy Limit and Sell Stop orders
can be placed."** The `1` in "Sell Limit 1" is the volume, taken from the quick trading panel.

### The prose list and the screenshot disagree — six ways

The Chart Management page gives its own list. Where it differs, **the screenshot wins**.

1. **The prose wraps seven commands in an `Objects` submenu** — *"Objects — open the objects
   control submenu"* holding `Object List`, `Delete Last`, `Delete All Selected`,
   `Delete All Arrows`, `Delete All`, `Unselect All`, `Unselect`, `Undo Delete`. **The
   screenshot has no `Objects` item at all** — `Object List` sits at top level beside
   `Indicator List` and `Expert List`. Whether the submenu appears only when objects exist on
   the chart is **UNVERIFIED**; the screenshot's chart has none.
2. **The prose omits `Trade Levels` and `Trade History`**, which are in the menu.
3. **The prose omits the dynamic top item** (`Sell Limit 1  219.306`).
4. **`One Click Trading` is in a different place.** The prose puts it after `Chart Shift`; the
   menu puts it second in the Depth Of Market group.
5. **Casing and wording:** prose `Bar chart` / `Candlestick` / `Line` vs menu `Bar Chart` /
   `Candlesticks` / `Line Chart`; prose `Delete Indicator Window` vs menu
   `Delete Indicators Window`; prose `Save As Picture` vs menu `Save as Picture`.
6. **The prose lists `Toolbar`**, which the screenshot does not show — consistent with the
   prose's own caveat: *"The command is only available for the charts, which were detached
   from the main platform window."* Not a contradiction, just conditional.

Verbatim on the relationship between the two menus: **"Commands in these menus are identical
(except for "Save As Picture" and "Delete Indicators Window" that are available only in the
context menu)"** — note MetaQuotes spells the second one *both* ways within one page.

**Four of these shortcuts appear nowhere but this menu.** `Alt+B`, `Alt+T`, `Alt+X` and
`Alt+D` are **absent from the hot-keys page** entirely. The menu is their only source.

## 7. Chart shift

### What it is

> "Chart shift — shift the chart from the right edge of the window to the shift mark. **The
> chart shift mark (a gray triangle at the top of the window) can be dragged horizontally
> using a mouse within 10% to 50% of the window size.**"

Russian, identical: *"Метку сдвига графика (серый треугольник в верхней части окна) можно
перемещать мышкой по горизонтали в пределах 10%-50% размера окна."*

### The marker

Read incidentally off `fixed_chart_position.png` at 20× (MetaQuotes publishes no screenshot
dedicated to the shift mark): a small **grey, downward-pointing triangle flush with the
chart's top border**, with a short vertical grey stub descending a few pixels below it. It is
unlabelled and has no tooltip in that asset. It is drawn **inside the plot area**, on the top
frame line, not in a separate gutter.

### The matching properties

| Property | Type | Meaning |
|---|---|---|
| `CHART_SHIFT` | bool | "Mode of price chart indent from the right border" — the checkbox |
| `CHART_SHIFT_SIZE` | **double, from 10 to 50 percent** | "The size of the zero bar indent from the right border in percents" — the triangle's position |

So the drag range in the help prose (10%–50% of window width) and the API's declared domain
(`double (from 10 to 50 percents)`) agree exactly. **This is a percentage of the chart window
width, not a number of bars.** The default value is not stated by MetaQuotes.

In the context menu the toggle is `Chart Shift` (title case); in the dialog it is
`Chart shift`; the toolbar/menu icon is `chart_shift_icon.png`.

### Do not confuse it with the fixed chart position

**Two different grey triangles.** The second one:

> "Every chart has an icon — a gray triangle located in the **bottom left corner** of the
> window by default. Move the triangle on any bar to lock its position on the chart… The
> selected bar stays in this position when you zoom the chart. **The position stays fixed
> until you change the chart timeframe.**"

Read off `fixed_chart_position.png` at 20×: an **upward-pointing grey triangle sitting on the
bottom time axis**, with a **full-height vertical grey line** rising from it through the plot
area, and a tooltip reading **`Fixed chart position`**. In the published screenshot it has been
dragged well away from the left corner, so "bottom left" is its default, not its only place.

Its property is `CHART_FIXED_POSITION` (double, percent from the left border), and MQL5 adds a
condition the help page omits: **"It is displayed only if the automatic chart scrolling to the
right on tick incoming is disabled (see CHART_AUTOSCROLL property)."** So the fixed-position
triangle is **hidden while `Chart auto scroll` is on**. The shift mark carries no such
condition.

| | Chart shift mark | Fixed chart position |
|---|---|---|
| Where | top border, points **down** | bottom time axis, points **up** |
| Companion line | short stub below | full-height vertical line |
| Tooltip | none observed | `Fixed chart position` |
| Range | 10%–50% of window width | any bar |
| Property | `CHART_SHIFT_SIZE` | `CHART_FIXED_POSITION` |
| Hidden when | — | `CHART_AUTOSCROLL` is true |
| Resets when | — | the timeframe changes |

## 8. Cross-checks against `03-chart-ui.md`

`03-chart-ui.md` section 3 is **mostly right and wrong in four places**:

| `03-chart-ui.md` says | Correct |
|---|---|
| "Title: `Properties of <SYMBOL>,<TF>`. Buttons OK / Cancel / Help." | ✅ |
| "Common — radio: Bar chart / Candlesticks / Line chart" | ✅ |
| "Checkboxes: Chart on foreground, Chart shift, Chart auto scroll" | ✅ |
| "Then Scale (0-5, six steps), Scale fix one to one, Scale fix (enables Fixed maximum / Fixed minimum), Scale points per bar (enables Points per bar)" | ✅ order and dependencies |
| Show tab order: "Show ticker · Show OHLC · Show quick trading buttons · Show bid price line · Show ask price line · Show last price line · Show period separators · Show grid · Show tick volumes · Show real volumes · Show object descriptions · Show trade levels · Show trade history" | ✅ all 13, exact order |
| "four colour schemes … 'Color on White'" | ✅ — but it does not record that another MetaQuotes page says three |
| Colors order: "Background · Foreground · Grid · Bar up · Bar down · Bull candle · Bear candle · Line chart · Volumes · Bid price line · Ask price line · Last price line · Stop levels" | ✅ all 13, exact order |
| "Only 'Black on White' has recoverable values" | ✅ |
| Section 4: "Two different grey triangles… the chart shift mark at the *top* (dragged horizontally, 10%-50% of window width) and the fixed chart position marker in the *bottom left*" | ✅ |

Four things to add to `03-chart-ui.md` rather than correct:

1. The colour labels carry a **trailing colon** in the dialog (`Background:`); the Common and
   Show labels do not.
2. The **Foreground/Text** split is a *prose* error in both EN and RU, not a one-page slip.
3. **Tick and real volumes are mutually exclusive**, and ticker/OHLC are coupled.
4. **The Home/End contradiction is confirmed and still unresolved.** The Chart Management page
   says *"Home — move the chart to the last bar; End — move the chart to the first bar"*; the
   hot-keys page says *"Home — Move chart to the start point. End — Move chart to the end
   point."* These are opposite readings. Unreconciled by MetaQuotes.

## Could not verify

1. **The shipped default state of every checkbox on Common and Show.** MetaQuotes' screenshots
   show one demo chart's state and never say "by default". `CHART_DRAG_TRADE_LEVELS` is the
   only chart property whose default MQL5 states ("enabled by default").
2. **The default value of `CHART_SHIFT_SIZE`.** The range is 10–50%; the shipped value is not
   stated anywhere.
3. **The number of discrete steps on the `Scale` slider as rendered.** MQL5 gives `CHART_SCALE`
   as "int from 0 to 5" (six values); the slider in the screenshot has no visible tick marks,
   so the UI step count is inferred from the API, not observed.
4. **The colours of the Yellow on Black, Green on Black and Color on White schemes.** No
   MetaQuotes screenshot or text gives a single value for any of them. Only Black on White is
   recoverable.
5. **Whether the Scheme dropdown has a fourth entry as rendered.** The one screenshot with it
   open (`char_color.png`, a 2015-era build) shows three, and the magnifier lens cuts the list
   off exactly below the third. The current page's prose says four.
6. **Whether the Scheme dropdown shows a fifth "Custom"-like entry after you change a colour
   by hand.** Not documented, not screenshotted.
7. **Whether a right-click on the price scale opens anything.** MetaQuotes documents no
   price-scale context menu and describes the chart menu as opening on right-click "anywhere in
   the chart window", but it never states that the scale area is excluded or included. Absence
   of documentation, not documented absence.
8. **The exact pixel geometry, colour and size of the chart shift triangle.** Read at 20× from
   an asset that is about something else; MetaQuotes publishes no dedicated image.
9. **Whether the `Objects` submenu appears in the chart context menu when objects exist.** The
   prose describes it in detail; the one published screenshot (of an object-free chart) has no
   such item.
10. **The modern-build appearance of the Common and Colors tabs.** Only the Show tab's asset is
    from a current build; Common and Colors are Windows-7-era (chart data dated 2 Aug 2011).
    The control inventory is corroborated by the current prose and by the Russian build, but
    the rendering may have changed.
11. **Whether the `Scale` slider's label is to the right in the modern build too.** Only
    observed on the Win7-era asset.
12. **Home/End semantics** — directly contradicted between two MetaQuotes pages. Carried over
    from `03-chart-ui.md`, still unresolved.
13. **Whether `Show real volumes` is also disabled by `Scale fix`.** MetaQuotes states the
    restriction for tick volumes only. Given they share one API property, it probably applies
    to both, but MetaQuotes does not say so.
14. **The Options dialog's full tab count.** `options_charts.png` shows ten tabs
    (Server · Charts · Trade · Expert Advisors · GPU · Events · Notifications · Email · FTP ·
    Community); the prose documents a "Signals" section and calls the third tab "Trading".
    `05-options-reports-tradingview.md` claims twelve. Out of scope here, but it is a live
    discrepancy.

## Sources

MetaQuotes MT5 help:
[Chart Settings (the F8 dialog)](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings) ·
[Chart Settings, Russian](https://www.metatrader5.com/ru/terminal/help/charts_advanced/charts_settings) ·
[Chart Management (context menu, mouse, keyboard, fixed position)](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage) ·
[View and Configure Charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts) ·
[Platform settings → Charts tab](https://www.metatrader5.com/en/terminal/help/startworking/settings) ·
[Hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[One Click Trading (source of the context-menu screenshot)](https://www.metatrader5.com/en/terminal/help/trading/one_click_trading)

MQL5 reference:
[ENUM_CHART_PROPERTY_INTEGER / _DOUBLE / _STRING](https://www.mql5.com/en/docs/constants/chartconstants/enum_chart_property) ·
[ENUM_CHART_MODE and ENUM_CHART_VOLUME_MODE](https://www.mql5.com/en/docs/constants/chartconstants/chart_view)

Logarithmic scale, negative evidence:
[MQL5 forum, "visual of the logarithmic chart on MT5"](https://www.mql5.com/en/forum/483571) (moderator Oleksandr Medviediev) ·
[MQL5 Market, "Logarithmic chart for MT5"](https://www.mql5.com/en/market/product/82391) (third-party paid workaround via custom symbols)

Screenshots read directly (all under `https://www.metatrader5.com/i/help/terminal/`):
`en/chart_properties_common.png` (713×503, Win7-era) ·
`en/chart_properties_show.png` (795×499, **modern build**) ·
`en/chart_properties_colors.png` (713×503, Win7-era) ·
`ru/chart_properties_common.png` · `ru/chart_properties_show.png` ·
`ru/chart_properties_colors.png` (same Black on White scheme as the English) ·
`en/char_color.png` (the **only** image with the Scheme dropdown open) ·
`en/options_charts.png` (622×402, modern build) ·
`en/chart_trading_menu.png` (741×581, **the chart background context menu with shortcuts**) ·
`en/fixed_chart_position.png` (471×308, shows **both** grey triangles)

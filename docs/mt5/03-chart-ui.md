# MetaTrader 5 chart UI — verified specification

Researched 2026-10-05 from MetaQuotes' own MT5 help, the MQL5 reference, and MetaQuotes'
own help screenshots read directly. Third-party sources are labelled. MT4 material is
quarantined in the last section and must never be mixed into an MT5 claim.

## Corrections to assumptions we held

1. **MT5 has no "Charts" toolbar.** It has three: Standard, Line Studies, and
   Periodicity/Timeframes. Chart-type and zoom buttons live on the **Standard** toolbar.
   (MT4 does have a fourth "Charts" toolbar. That is a genuine MT4/MT5 difference.)
2. The Chart Properties colour list is **13 entries**, and the labels are **Foreground**
   (not "Text"), **Line chart** (not "Line graph"), **Bid/Ask/Last price line**.
3. There are **four** colour schemes, not three: "Yellow on Black", "Green on Black",
   "Black on White", **"Color on White"**.
4. There are **no "Up/Down price labels"**. The Arrows group has **Left Price Label** and
   **Right Price Label**.
5. **Heikin Ashi is a native chart type on MOBILE but not on desktop.** The single biggest
   desktop/mobile divergence in the chart.

## 1. Toolbars

Three built-in toolbars: **Standard, Line Studies and Periodicity**
(https://www.metatrader5.com/en/terminal/help/startworking/interface). The charts page
calls the third one **"Timeframes"**; MetaQuotes uses both names and we could not verify
which string the live View menu uses.

**MetaQuotes publishes no toolbars page for MT5 at all** (confirmed by crawling the full
138-URL help link graph and by querying the Wayback CDX index). So no authoritative,
ordered, tooltip-exact button list exists. Buttons individually confirmed on the Standard
toolbar: New Order, Indicators, Print, Print Preview, Templates, Profiles, AutoTrading,
New Chart, Bar Chart / Candlesticks / Line Chart, Zoom In / Zoom Out.

Crosshair is on the **Line Studies** toolbar, and Arrows is a dropdown button on it.

## 2. Chart types — exactly three natively

`ENUM_CHART_MODE` (https://www.mql5.com/en/docs/constants/chartconstants/chart_view) has
exactly three members, so there is no API surface for any other mode.

| Constant | Dialog label | Shortcut |
|---|---|---|
| `CHART_BARS` | **Bar chart** | Alt+1 |
| `CHART_CANDLES` | **Candlesticks** | Alt+2 |
| `CHART_LINE` | **Line chart** | Alt+3 |

**Area, Baseline, Renko, Range and Point & Figure do not exist natively.** Heikin Ashi
ships only as a bundled custom indicator on desktop, but **is a native fourth chart type on
mobile** (both Android and iPhone help list Bar chart / Candlestick / Line chart / Heikin
Ashi).

## 3. Chart Properties (F8) — three tabs

Title: `Properties of <SYMBOL>,<TF>` (no space after the comma). Buttons OK / Cancel / Help,
and no Apply. Specified field by field, from the screenshots, in
[08-chart-properties.md](./08-chart-properties.md). Four corrections from that pass:

- The Colors tab's labels carry a **trailing colon**; the Common and Show tabs' do not.
- Field 2 is **`Foreground:`** in the dialog. MetaQuotes' prose calls it "Text" in English and
  "Текст" in Russian; both are wrong, and `CHART_COLOR_FOREGROUND` agrees with the dialog.
- **Show tick volumes and Show real volumes are mutually exclusive**: they are one property,
  `CHART_SHOW_VOLUMES`, taking hide / tick / real. Show ticker and Show OHLC are coupled too,
  asymmetrically.
- **There is no logarithmic and no percentage price scale in MetaTrader**, confirmed four ways.
  The scale is pinned instead, with Scale fix, Scale fix one to one and Scale points per bar.

**Common** — radio: Bar chart / Candlesticks / Line chart. Checkboxes: Chart on foreground,
Chart shift, Chart auto scroll. Then Scale (0-5, six steps), Scale fix one to one, Scale fix
(enables Fixed maximum / Fixed minimum), Scale points per bar (enables Points per bar).

**Show** — in order: Show ticker · Show OHLC · Show quick trading buttons · Show bid price
line · Show ask price line · Show last price line · Show period separators · Show grid ·
Show tick volumes · Show real volumes · Show object descriptions · Show trade levels ·
Show trade history.

**Colors** — Scheme, then 13 colours in order: Background · Foreground · Grid · Bar up ·
Bar down · Bull candle · Bear candle · Line chart · Volumes · Bid price line · Ask price
line · Last price line · Stop levels. These map 1:1 onto the 13 `CHART_COLOR_*` properties.

Semantics worth keeping: **Foreground** is "colour of axes, scales and OHLC line";
**Volumes** is "colour of volumes *and position opening levels*"; **Line chart** is "the
colour of the chart line *and Doji candlesticks*".

Only "Black on White" has recoverable values (read off MetaQuotes' own screenshot, as named
Windows colours): Background White, Foreground Black, Grid Silver, Bar up/down Black, Bull
candle White, Bear candle Black, Line chart Black, Volumes Green, Bid/Ask/Last Silver,
Stop levels OrangeRed. **The other three schemes' values are undocumented.**

## 4. Scales and navigation

Verified mouse behaviour
(https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage):

- **"click-and-hold on the vertical scale of the chart and move the cursor vertically to
  change the vertical scale; double-click on the vertical scale to restore the chart scale"**
- **"click-and-hold on the horizontal chart scale (anywhere outside the fast navigation bar)
  and move the cursor horizontally to change the chart scale"**
- Ctrl + mouse wheel scales the chart; middle-click toggles the crosshair.

Keys: NumPad 5 restores the automatic vertical scale; "+"/"-" zoom; F8 properties; Ctrl+F
crosshair; Ctrl+G grid; Ctrl+H OHLC; Ctrl+B Objects List; Ctrl+I Indicators List; Ctrl+D
Data Window; F12 / Shift+F12 move one bar. **Home/End semantics are contradicted between two
MetaQuotes pages and remain unresolved.**

Two different grey triangles, often conflated: the **chart shift mark** at the *top* (dragged
horizontally, 10%-50% of window width) and the **fixed chart position** marker in the
*bottom left* (locks a bar's position while zooming).

## 5. Objects — 44 in 8 categories

`Insert → Objects →` Lines · Channels · Gann · Fibonacci · Elliott · Shapes · Arrows ·
Graphical (exactly this order). **Text and Text Label live inside Graphical**, not as a
separate branch.

- **Lines (6)** Horizontal Line · Vertical Line · Trendline · Trendline by Angle · Cycle Lines · Arrowed Line
- **Channels (4)** Equidistant Channel · Standard Deviation Channel · Regression Channel · Andrews' Pitchfork
- **Gann (3)** Gann Line · Gann Fan · Gann Grid
- **Fibonacci (6)** Retracement · Time Zones · Fan · Arcs · Channel · Expansion
- **Elliott (2)** Impulse Wave · Corrective Wave
- **Shapes (3)** Rectangle · Triangle · Ellipse
- **Arrows (11)** Thumbs Up · Thumbs Down · Up Arrow · Down Arrow · Stop Sign · Check Sign · Left Price Label · Right Price Label · Buy Sign · Sell Sign · Arrow
- **Graphical (9)** Text · Text Label · Button · Graph · Bitmap · Bitmap Label · Edit · Event · Rectangle Label

**Default Fibonacci Retracement levels: 0, 23.6, 38.2, 50, 61.8, 100, 161.8, 261.8, 423.6 %.**
(Note: 78.6 is NOT an MT5 default. Fan/Arcs use 38.2/50/61.8; Expansion 61.8/100/161.8.)

**Objects List (Ctrl+B)** — columns Object · Name · Description · Window; buttons Show ·
Properties · Delete · List all. Object Properties tabs: **Common · Levels · Parameters ·
Visualization** — Levels is SECOND, and appears only on the Fibonacci tools and Andrews'
Pitchfork, so most objects show three tabs. (This line previously gave the order as Common ·
Parameters · Levels · Visualization, which MetaQuotes' own screenshots contradict.)

The window title is not "Objects List": it is `Objects on <SYMBOL>,<TIMEFRAME> (<count>)`.
Both dialogs are specified field by field, from the screenshots, in
[07-objects-list-and-properties.md](./07-objects-list-and-properties.md).

MetaQuotes' help twice claims "46 analytical objects" while its own category pages and
`ENUM_OBJECT` both enumerate 44. Unreconciled.

## 6. Indicators — 38 built in, four groups

- **Trend Indicators (13)** Adaptive Moving Average · Average Directional Movement Index · Average Directional Movement Index Wilder · Bollinger Bands® · Double Exponential Moving Average · Envelopes · Fractal Adaptive Moving Average · Ichimoku Kinko Hyo · Moving Average · Parabolic SAR · Standard Deviation · Triple Exponential Moving Average · Variable Index Dynamic Average
- **Oscillators (15)** Average True Range · Bears Power · Bulls Power · Chaikin Oscillator · Commodity Channel Index · DeMarker · Force Index · MACD · Momentum · Moving Average of Oscillator · Relative Strength Index · Relative Vigor Index · Stochastic Oscillator · Triple Exponential Average · Williams' Percent Range
- **Volume Indicators (4)** Accumulation/Distribution · Money Flow Index · On Balance Volume · Volumes
- **Bill Williams' Indicators (6)** Accelerator Oscillator · Alligator · Awesome Oscillator · Fractals · Gator Oscillator · Market Facilitation Index

Group names are **"Trend Indicators"**, **"Oscillators"**, **"Volume Indicators"** and
**"Bill Williams' Indicators"** (with the apostrophe). "Custom" is not one of the four.

Indicator Properties tabs: Parameters · Levels · Scale · Visualization (+ Colors for
multi-line indicators). **Apply to** has nine options: Close, Open, High, Low, Median Price
(HL/2), Typical Price (HLC/3), Weighted Close (HLCC/4), First indicator's data, Previous
indicator's data.

## 7. Trade levels on the chart

`CHART_SHOW_TRADE_LEVELS` displays "levels of open positions, Stop Loss, Take Profit and
pending orders". **Open-position levels are drawn in the `Volumes` colour**
(`CHART_COLOR_VOLUME` = "Color of volumes and position opening levels"); **SL and TP use the
`Stop levels` colour** (OrangeRed in Black on White).

Levels are draggable: "left-click on it and drag the level up or down". Dragging the price
line of a pending order moves the whole order including its stops.
`CHART_DRAG_TRADE_LEVELS` is **true by default**. The per-chart "Show trade levels" is only
valid if the same option is enabled in Tools → Options → Charts.

**The exact on-chart label text for positions and SL/TP is not transcribed in any MetaQuotes
text** — only shown in screenshots. Unverified.

## 8. Mobile differences that matter for a phone-first product

1. **Heikin Ashi is a native chart type.**
2. No toolbars: a **radial menu** on chart tap, plus a top panel.
3. All 21 timeframes exist but **only up to 9 are shown** on the visible panel.
4. Colour schemes differ: Android has Green on Black / Black on White / Color on White /
   custom (no Yellow on Black); iPhone has only **two**.
5. Android's colour list is richer than desktop's 13, adding separate **line and caption-text**
   colours for Stop Loss, Take Profit, Sell, Buy and Stop Limit lines.
6. Crosshair ruler shows **vertical distance in points, percentage change and price
   difference**, plus horizontal distance in bars and the time difference.
7. Default scrolling is **free 2-D movement**; "Auto-scale" restricts to horizontal.
8. **Chart Indent** replaces desktop's Chart Shift.
9. Trade levels are **three separate toggles** (Trade positions, Trade orders, SL/TP levels),
   and dragging SL/TP shows the potential profit or loss live in points and money.
10. 4 charts on Android phones, 6 on tablets (desktop: 100).

## 9. Explicitly NOT verified

1. Ordered button list and tooltips for the Standard and Line Studies toolbars (no such page exists).
2. Which timeframe buttons are shown by default.
3. Whether the monthly button reads "MN" or "MN1" on desktop.
4. Whether the third toolbar is "Periodicity" or "Timeframes" in the live View menu.
5. Colour values for Yellow on Black, Green on Black, Color on White.
6. Home/End semantics (MetaQuotes contradicts itself).
7. Desktop crosshair ruler readout (third-party sourced only).
8. Exact on-chart label text for positions and SL/TP.
9. "46 analytical objects" (help prose) vs 44 (help's own pages and `ENUM_OBJECT`).
10. "Three" vs "four" colour schemes (MetaQuotes contradicts itself).

## Sources

MetaQuotes MT5 help: [interface](https://www.metatrader5.com/en/terminal/help/startworking/interface) ·
[charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts) ·
[chart settings](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings) ·
[chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage) ·
[objects list](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) ·
[hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[objects](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) ·
[indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators)

MQL5 reference: [chart_view](https://www.mql5.com/en/docs/constants/chartconstants/chart_view) ·
[chart properties](https://www.mql5.com/en/docs/constants/chartconstants/enum_chart_property) ·
[timeframes](https://www.mql5.com/en/docs/constants/chartconstants/enum_timeframes) ·
[object types](https://www.mql5.com/en/docs/constants/objectconstants/enum_object)

Mobile: [Android chart](https://www.metatrader5.com/en/mobile-trading/android/help/chart) ·
[iPhone chart](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart)

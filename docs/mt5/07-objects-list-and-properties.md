# MT5 Objects List and Object Properties — verified specification

Researched 2026-10-05 from MetaQuotes' own MT5 help, the MQL5 reference, and MetaQuotes'
own help screenshots read pixel by pixel after 4–8× upscaling. Every claim carries a source.
Where a fact could not be established this document says so rather than filling the gap, and
the gaps are listed in "Could not verify" at the end. MT4 material is not mixed in anywhere.

## Corrections to assumptions we held

1. **The window title is not "Objects".** It is **`Objects on <SYMBOL>,<TIMEFRAME> (<count>)`**
   — MetaQuotes' own screenshot reads `Objects on EURUSD,M1 (2)`.
2. **Tab order is Common · Levels · Parameters · Visualization**, not Common · Parameters ·
   Levels · Visualization. Levels sits *second*, between Common and Parameters.
3. **Most objects have only three tabs.** Levels appears only for Fibonacci tools and
   Andrews' Pitchfork. A Trendline, Horizontal Line, Rectangle, Gann Line and Gann Fan all
   show Common · Parameters · Visualization only.
4. **The Object Properties window title is the object's name**, e.g. `M1 Gann Line 40253` —
   it carries no "Properties" word and no symbol.
5. **The Visualization tab is a tree, not a flat list of 21 checkboxes.** One "All timeframes"
   checkbox above a five-node tree: Minutes · Hours · Day · Week · Month, with Minutes and
   Hours expandable. There are **no "Select all" / "Clear all" buttons**.
6. **Gann Fan has no "Date scale" / "Price scale" / "Trend" fields.** MT5 uses
   **Pips per bar** and a **Downtrend** checkbox. (Date scale/Price scale is MT4 vocabulary.)
7. **The Levels grid has two columns only** — Level and Description. Colour, style and width
   are a single shared Style row *below* the grid, not per-row columns.
8. **The Levels buttons are Add · Delete · Edit · Default** — the help text omits "Edit" and
   writes "Defaults" plural; the dialog reads **"Default"**.
9. **"List all" is a button**, not a checkbox.
10. **There is no "Hide object in all timeframes" checkbox** on the Common tab. The Common
    tab has exactly two checkboxes: Draw object as background, Disable selection.

## 1. Objects List dialog (Ctrl+B)

### Opening it

`Ctrl+B`, confirmed twice. The hot-keys table reads **"Ctrl+B — Call the "Objects List"
window."** The charts page says to click **"Object List"** in the chart context menu **"or
press "Ctrl+B""**.

**Three different names for the same thing, unreconciled.** The hot-keys page calls it
*"Objects List"*; the charts page calls the context-menu item *"Object List"* (singular) and
then calls the window *"The "Objects" window"*; the actual title bar reads *"Objects on
EURUSD,M1 (2)"*. All three are MetaQuotes'.

### Exact window title

```
Objects on EURUSD,M1 (2)
```

Read from `objects_list.png`. The pattern is `Objects on <SYMBOL>,<TIMEFRAME> (<count>)`,
where the count is the number of rows listed. Confirmed from the screenshot only — MetaQuotes
never transcribes the title in prose.

### Columns, in order

| # | Header | Contains |
|---|---|---|
| 1 | **Object** | A **checkbox** plus the **object type name** as text. No type icon. |
| 2 | **Name** | The object's unique name. |
| 3 | **Description** | The object's description (`OBJPROP_TEXT`). **Empty by default.** |
| 4 | **Window** | The **window number**. `0` is the main chart window. |

MetaQuotes' prose, verbatim:

- **"Object — object type. Tick the "Object" field to select the object on the chart"**
- **"Name — object name. This name is formed of the period of the chart the object is
  attached to, the object type and the unique ID that is automatically assigned to each
  object. The name can be changed in the object properties"**
- **"Description — object description. It can also be changed from the object properties"**
- **"Window — the number of the window the object is added on. 0 is the main chart window,
  further numbers mean serial numbers of indicator sub-windows from the top down."**

So **Window is an integer, never the words "Main chart" and never an indicator name.** Both
rows in MetaQuotes' screenshot show `0`.

The **Object column checkbox is not a selection checkbox for the dialog** — ticking it
selects the object *on the chart*. Both rows in the screenshot are ticked.

In the screenshot the fourth header is clipped by the column width to a single glyph plus an
ellipsis. The help text names the column **Window**; the clipped glyph is ambiguous and reads
closer to "V" than "W" at that resolution. Treat **Window** as the label on the strength of
the prose.

### The auto-generated name — exact format

```
<TIMEFRAME> <Object type> <ID>
```

Six independently observed real examples, read off MetaQuotes' screenshots:

| Example | Object |
|---|---|
| `M1 Horizontal Line 3661` | Horizontal Line |
| `M1 Fibo 26637` | Fibonacci Retracement |
| `M1 Gann Fan 30637` | Gann Fan |
| `M1 Trendline 31757` | Trendline |
| `M1 Rectangle 34461` | Rectangle |
| `M1 Gann Line 40253` | Gann Line |
| `M1 Andrews Pitchfork 43325` | Andrews' Pitchfork |
| `H1 Gann Line 24833` | Gann Line |

Points that matter for implementation:

- The timeframe prefix is the **chart period the object was created on** (`M1`, `H1`, …), not
  the current chart period. The prefix is a plain timeframe code, no brackets.
- The type token is **not always the menu label**: Fibonacci Retracement becomes **`Fibo`**,
  Standard Deviation Channel becomes **`StdDev Channel`**, Andrews' Pitchfork becomes
  **`Andrews Pitchfork`** (the apostrophe is dropped).
- The ID is a **4–5 digit integer** in all observed cases (3661, 24833, 26637, 30637, 31757,
  34461, 40253, 43325). **What generates it is undocumented** — it is not a sequence counter
  starting at 1, and MetaQuotes never states its range or algorithm. Do not assume it is
  monotonic; do not assume 5 digits.
- Separator is a single space throughout.

MQL5 constrains the name but does not generate it: **"The name must be unique within a chart,
including its subwindows"** and **"An object name should not exceed 63 characters."**
`ObjectCreate` requires the caller to supply a name, so the `<TF> <Type> <ID>` form is a
terminal-UI behaviour, not an API behaviour.

Renaming is supported: the Common tab's Name field is editable, and MQL5 notes that renaming
raises **"an event of deletion of an object with the old name"** and **"an event of creation
of an object with a new name"**.

### Buttons, in order

Read off `objects_list.png`. Four buttons in a right-hand column, plus a Close button pinned
to the bottom-right:

| Label | Does |
|---|---|
| **Show** | "move the chart to the selected object" |
| **Properties** | "edit the properties of the selected object" |
| **Delete** | "delete the selected object" |
| **List all** | Shows hidden objects in the list |
| **Close** | Closes the dialog (screenshot only; not described in prose) |

**"List all" is a button, not a checkbox** — it is rendered identically to Show / Properties /
Delete, is the only one of the four enabled in the screenshot, and is visually separated from
them by a gap.

What it changes, verbatim: **"any object can be marked as hidden (property OBJPROP_HIDDEN)
from a MQL5 application. Such objects are displayed on a chart, but they are not displayed in
the object list by default. Click "List all" to show the hidden objects in the list."**

So it does **not** widen the scope to other charts or other windows. It only un-filters
`OBJPROP_HIDDEN` objects. MQL5 confirms the purpose from the other side: `OBJPROP_HIDDEN` is
**"Disable the display of a graphical object in the client terminal object list called by the
Charts \ Objects \ Object List command. This prevents accidental deletion of MQL5 program
service objects by a user."**

In the screenshot Show, Properties and Delete are **greyed out** while List all is enabled —
consistent with the three row-scoped actions requiring a focused row.

**Unreconciled naming:** the objects-list page says the "Objects" window's commands are
Show / Properties / Delete / List all, but the Analytical Objects page says to **"Select the
required object in the Object List window and click "Edit""**. There is no Edit button in
the screenshot. Treat **Properties** as the real label and "Edit" as a MetaQuotes error.

### Multi-selection, sorting, double-click

- **Multi-select: yes.** The page ends the Objects List section with **"Press Ctrl+A to select
  all objects."** `Delete All Selected` exists as a chart context-menu command, which only
  makes sense with a multi-selection.
- **Ctrl+A is contradicted.** The hot-keys table assigns Ctrl+A to **"Arrange height of all
  indicator windows by default."** The objects-list page assigns it to selecting all objects.
  Most likely these are different focus contexts (chart vs. dialog) but **MetaQuotes never
  reconciles them. Unresolved.**
- **Column sorting: UNVERIFIED.** No MetaQuotes text or screenshot addresses it.
- **Double-click behaviour: UNVERIFIED.** No MetaQuotes text or screenshot addresses it.
- Row striping is visible in the screenshot (alternating white / light grey).

### Sibling dialogs on the same page

The same help page documents two siblings worth knowing, because they share the layout:

- **Indicator List** — `Ctrl+I`, or "Indicator List" in the context menu. "Indicators are
  divided into two groups: those plotted in the main chart window and indicators drawn in
  separate windows." Buttons Properties and Delete.
- **List of Expert Advisors** — context menu only, no shortcut given. "The **Charts** column
  contains the name and timeframe of the chart, on which the Expert Advisor or the script is
  running." Buttons Show, Properties, Delete.

Sources: [lists of objects applied](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) ·
[hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[ObjectCreate](https://www.mql5.com/en/docs/objects/objectcreate) ·
[object properties](https://www.mql5.com/en/docs/constants/objectconstants/enum_object_property) ·
screenshot [objects_list.png](https://www.metatrader5.com/i/help/terminal/en/objects_list.png)

## 2. Object Properties dialog

### Exact window title

**The title is the object's name, alone.** No "Properties" word, no symbol, no type prefix
beyond what the name already contains.

```
M1 Gann Line 40253
M1 Fibo 26637
M1 Trendline 31757
M1 Horizontal Line 3661
M1 Rectangle 34461
M1 Gann Fan 30637
M1 Andrews Pitchfork 43325
H1 Gann Line 24833
```

Read from seven MetaQuotes screenshots. Because the title is the name, **renaming an object
renames its properties window.**

Buttons: **OK** and **Cancel**, bottom-right, OK focused. There is no Apply and no Help
button (a `?` glyph sits in the title bar instead).

### Tabs — order and which objects get which

**Four tabs exist. The order is Common · Levels · Parameters · Visualization.**

| Object | Tabs shown | Count |
|---|---|---|
| Trendline | Common · Parameters · Visualization | 3 |
| Horizontal Line | Common · Parameters · Visualization | 3 |
| Rectangle | Common · Parameters · Visualization | 3 |
| Gann Line | Common · Parameters · Visualization | 3 |
| Gann Fan | Common · Parameters · Visualization | 3 |
| Fibonacci Retracement | Common · **Levels** · Parameters · Visualization | 4 |
| Andrews' Pitchfork | Common · **Levels** · Parameters · Visualization | 4 |

All seven read directly off MetaQuotes' screenshots, so the ordering is not inferred.

**Levels appears only for Fibonacci tools and Andrews' Pitchfork**, stated outright:
**"The "Levels" tab is specifically used only for Fibonacci tools and Andrews' Pitchfork."**

**A Horizontal Line does have a Parameters tab** (holding a single Value field). **A Rectangle
does not have a Levels tab.** Both confirmed from screenshots.

Common, Parameters and Visualization appear on every object observed. Whether any object type
lacks a Parameters tab is **UNVERIFIED** — all seven sampled objects have one.

### Common tab — exact fields in order

| Order | Label | Control |
|---|---|---|
| 1 | `Name:` | Text input, pre-filled with the auto-generated name |
| 2 | `Description:` | Text input, **empty by default** |
| 3 | `Style:` | Three side-by-side dropdowns: **colour picker** (swatch + colour name, e.g. "Red"), **line style** dropdown (line preview), **line width** dropdown (line preview) |
| 4 | `Draw object as background` | Checkbox, unticked by default |
| 5 | `Disable selection` | Checkbox, unticked by default |

The three labels carry a **trailing colon**; the two checkboxes do not. Labels are
right-aligned to the left of their controls.

`Style:` is **one labelled row holding three controls**, not three labelled fields:
**"Line color, width and style are set up in the "Style" field."**

Semantics, verbatim:

- **"Name — the unique name of an object within one chart, it is set automatically. It can be
  changed by entering another name in this field."**
- **"Description — a text description of an object which also helps to identify objects. The
  description can be shown on the chart if the "Show object descriptions" option is enabled in
  the chart settings."**
- **"Draw object as background — draw object in the background, behind the chart. This option
  also sets color filling of objects like shapes or channels (excluding Fibonacci Channel)."**
- **"Disable selection — disable the possibility of object selection. This possibility is
  intended for control objects ("Button", "Entry field", "Graphic label"). This option allows
  to change the state of buttons and graphic labels, as well enter values in the entry
  fields."**

Description maps to **`OBJPROP_TEXT`** — "Description of the object (the text contained in the
object)". Draw object as background maps to `OBJPROP_BACK`; Disable selection is the inverse
of `OBJPROP_SELECTABLE`.

**There is no "Hide object in all timeframes" or "Object visibility" checkbox here.**
Timeframe visibility lives entirely on the Visualization tab.

**MetaQuotes contradicts itself on where drawing parameters live.** The Analytical Objects
page says both *"The object appearance is adjusted on the "Common" tab"* and *"Object drawing
parameters are available on the "Common" tab"*, then illustrates the second with
`object_plot_settings.gif` — whose frames actually show the **Parameters** tab of a Gann Line.
The screenshot is right and the second sentence is wrong: Date/Value/Ray live on Parameters.

### Parameters tab — per object

Anchor points are always paired as **`Date:`** (a dropdown/combo holding
`YYYY.MM.DD HH:MM:SS`) and **`Value:`** (a text input with an up/down spinner). MetaQuotes:
**"Time coordinates are set in the "Date" fields. Values of coordinates along the vertical
axis are entered in the "Value" fields. An object can have from one to three coordinates."**

**Trendline** — `M1 Trendline 31757`

| Order | Label | Control |
|---|---|---|
| 1 | `Date:` / `Value:` | datetime dropdown / spinner input (initial point) |
| 2 | `Date:` / `Value:` | datetime dropdown / spinner input (end point) |
| 3 | `Ray right` | Checkbox |
| 4 | `Ray left` | Checkbox |

**Horizontal Line** — `M1 Horizontal Line 3661`

| Order | Label | Control |
|---|---|---|
| 1 | `Value:` | Spinner input |

Only one field, right-aligned in the upper right of an otherwise empty tab. No Date field.

**Rectangle** — `M1 Rectangle 34461`

| Order | Label | Control |
|---|---|---|
| 1 | `Date:` / `Value:` | datetime dropdown / spinner input (first point) |
| 2 | `Date:` / `Value:` | datetime dropdown / spinner input (second point) |
| 3 | `Fill` | Checkbox |

**"Fill — enable/disable color filling inside the shape."** Note the separate route to the
same effect: **"To fill the object with the color of its lines, you should enable option the
"Draw object as background" at the "Common" tab."**

**Fibonacci Retracement** — `M1 Fibo 26637`

| Order | Label | Control |
|---|---|---|
| 1 | `Date:` / `Value:` | datetime dropdown / spinner input (initial point of the trendline) |
| 2 | `Date:` / `Value:` | datetime dropdown / spinner input (end point of the trendline) |
| 3 | `Ray right` | Checkbox |
| 4 | `Ray left` | Checkbox |

Identical layout to Trendline. The difference is the extra Levels tab.

**Gann Fan** — `M1 Gann Fan 30637`

| Order | Label | Control |
|---|---|---|
| 1 | `Date:` / `Value:` | datetime dropdown / spinner input (initial point) |
| 2 | `Date:` | datetime dropdown (last point, time axis only — **no paired Value**) |
| 3 | `Pips per bar:` | Text input (shown as `4.000000`) |
| 4 | `Downtrend` | Checkbox |

**"Pips Per Bar — scale for plotting the Gann Fan in a chart. Ratio of pips number to one
bar"** and **"Downtrend — if this field is checked, the Gann Fan will be inclined downwards."**

**Gann Line** (for contrast) — `M1 Gann Line 40253`: `Date:`/`Value:`, `Date:`,
`Gann angle:` (text input, `7.76`) and `Pips per bar:` (`1.000000`) side by side, then
`Ray right` and `Ray left`.

**Andrews' Pitchfork** — `M1 Andrews Pitchfork 43325`

| Order | Label | Control |
|---|---|---|
| 1 | `Date:` / `Value:` | beginning of the "handle" |
| 2 | `Date:` / `Value:` | lower "tooth" (lower pivot point) |
| 3 | `Date:` / `Value:` | upper "tooth" (upper pivot point) |
| 4 | `Ray right` | Checkbox |
| 5 | `Ray left` | Checkbox |

Three anchor pairs — the maximum MetaQuotes documents for the dialog.

#### Casing: the dialog and the prose disagree

The help prose writes **"Ray Right"**, **"Ray Left"** and **"Pips Per Bar"** in title case.
**Every screenshot shows sentence case: `Ray right`, `Ray left`, `Pips per bar:`.** Use the
screenshots. The same applies to `Gann angle:` (prose: "Angle in degrees" for a Trendline by
Angle — that is a genuinely different field on a different object, not a casing variant).

#### Other Parameters fields MetaQuotes lists but we did not see rendered

Documented in prose for objects outside this sample, verbatim:

- **"Angle in degrees — angle of the object slope counter-clockwise in degrees"**
  (Trendline by Angle)
- **"Scale — ratio between units of vertical (pips) and horizontal (bars) axes of the object"**
- **"Arrow code — code of the object"**
- **"Anchor — one of the chart corners or sides where its anchor point is located"**
- **"X-distance: — horizontal distance between the anchor corner of the window and the text
  label in pixels"**
- **"Y-distance: — vertical distance between the anchor corner of the window and the text
  label in pixels"**

Note X-distance and Y-distance are written **with** a trailing colon in the prose itself.

### Levels tab — exact layout

Read from `obj_properties_levels.png` (`M1 Fibo 26637`).

**Grid: two columns.**

| Header | Contains |
|---|---|
| `Level` | The level value as a decimal — `0`, `0.236`, `0.382`, `0.5`, `0.618`, … Each cell is prefixed by a small blue line-style glyph showing that level's line. |
| `Description` | The level's text — defaulting to the percentage: `0.0`, `23.6`, `38.2`, `50.0`, `61.8`, … |

**Colour, style and width are not grid columns.** They are a single row of three dropdowns
*below* the grid — the same three-control "Style" field as on the Common tab (swatch +
colour name, e.g. "Black"; line-style dropdown; line-width dropdown), applying to the selected
level. MetaQuotes: **"The color, width and style of the object levels are set up in the
"Style" field."**

The grid has a vertical scrollbar; roughly five rows are visible at the default dialog size.

**Buttons, in order, right-hand column:**

| Label | Does |
|---|---|
| **Add** | "A new level can be added by clicking the "Add" button" |
| **Delete** | "The values of the levels can be changed or deleted (the "Delete" button)" |
| **Edit** | Screenshot only — not described in MetaQuotes' prose |
| **Default** | "The "Defaults" button sets the initial values" |

In the screenshot Add is enabled; Delete and Edit are greyed; Default is enabled — consistent
with Delete/Edit needing a selected row. **Add and Default are visually separated from
Delete/Edit by a gap.**

**Unreconciled:** the prose says the reset button is **"Defaults"**; the dialog reads
**"Default"** (singular). The prose never mentions **Edit** at all. The Russian build
corroborates four buttons — Добавить / Удалить / Правка / По умолч. — matching
Add / Delete / Edit / Default.

#### The `%$` description placeholder

Verbatim, from the Fibonacci Retracement page: **"The Fibonacci Retracement has additional
feature of displaying price value of each level. To do it, specify the (%$) symbols in the
"Description" field."**

The Fibonacci Expansion page repeats it word for word for that object.

Scope, precisely established by grepping every MT5 object help page: **`%$` is documented for
exactly two objects — Fibonacci Retracement and Fibonacci Expansion.** It is not documented
for Fibonacci Fan, Arcs, Channel, Time Zones, or Andrews' Pitchfork, and it appears nowhere in
the MQL5 reference.

MetaQuotes writes it as **`(%$)`** with parentheses in both places. Whether the parentheses are
part of the token or merely quoting punctuation in the sentence is **UNVERIFIED** — no
screenshot shows a level description containing it. **No other placeholder (`%%`, `%\$`, or
any variant) is documented anywhere in the MT5 help or MQL5 reference.**

Level text maps to `OBJPROP_LEVELTEXT` ("Level description", `string`, `modifier=level
number`); level count to `OBJPROP_LEVELS`.

### Visualization tab — exact layout

**This is the single most misunderstood part of the dialog, and MetaQuotes' English screenshot
for it is broken.** `object_visualization.gif` on the English help serves a *Levels* screenshot
in both frames — it is byte-identical to `indicator_visualization.gif` (both 25,351 bytes),
so MetaQuotes uploaded the wrong asset. The Russian asset
(`/i/help/terminal/ru/object_visualization.gif`, 25,812 bytes) is correct and does show the
tab. German, Spanish and French return 404.

From the Russian screenshot, with the layout and the timeframe tree being language-neutral:

| Order | Control | English label |
|---|---|---|
| 1 | Checkbox, above the tree, unticked in the screenshot | **All timeframes** (RU: "Все таймфреймы") |
| 2 | Tree node, expandable (`+`), tri-state checkbox | **Minutes** (RU: "Минуты") |
| 3 | Tree node, expandable (`+`), tri-state checkbox | **Hours** (RU: "Часы") |
| 4 | Tree leaf, checkbox | **Day** (RU: "День") |
| 5 | Tree leaf, checkbox | **Week** (RU: "Неделя") |
| 6 | Tree leaf, checkbox | **Month** (RU: "Месяц") |

**It is a tree with five top-level nodes inside a bordered list box, not a flat grid of 21
checkboxes.** Minutes and Hours carry `+` expanders; Day, Week and Month are leaves.

**Checkbox rendering is tri-state and uses two distinct glyphs:** a **green tick** for
selected and a **red ✕** for not selected (not an empty box). In the screenshot Minutes,
Hours and Week show green ticks; Day and Month show red ✕. The "All timeframes" checkbox above
uses an ordinary empty Windows checkbox, not the tick/✕ pair.

**There are no "Select all" / "Clear all" / "Show object in all timeframes" buttons.** The
only buttons on the tab are the dialog's own **OK** and **Cancel** (RU: ОК / Отмена).

The only label MetaQuotes transcribes in English is the top checkbox: **"If the field "All
timeframes" is selected, the object is visible on all timeframes."** Semantics: **"The object
only appears on the selected timeframes. This can be useful when an object has different
settings on different timeframes."**

**The English strings "Minutes", "Hours", "Day", "Week", "Month" are our translation of the
Russian screenshot, not transcribed from an English build.** They are consistent with MQL5's
own grouping but should be confirmed against a live English terminal before shipping.

#### The 21 timeframes the tree must expand to

`OBJPROP_TIMEFRAMES` takes a flag set with exactly 21 individually addressable periods, which
is what the Minutes and Hours nodes expand into:

- **Minutes (11)** — M1, M2, M3, M4, M5, M6, M10, M12, M15, M20, M30
- **Hours (7)** — H1, H2, H3, H4, H6, H8, H12
- **Leaves (3)** — D1, W1, **MN1**

Constants: `OBJ_PERIOD_M1` (0x1) … `OBJ_PERIOD_MN1` (0x100000), plus `OBJ_NO_PERIODS` (0) and
`OBJ_ALL_PERIODS` (0x001fffff). `0x1fffff` is 21 set bits, confirming the count exactly.

**The monthly constant is `OBJ_PERIOD_MN1`, not `MN`.** Whether the tree leaf is labelled
"Month", "MN" or "MN1" in an English build is **UNVERIFIED** — the Russian screenshot shows a
word ("Месяц"), which argues for "Month", and the leaf is a word not a code.

**The expanded contents of the Minutes and Hours nodes have never been screenshotted by
MetaQuotes.** That all 11 / 7 appear individually is inferred from `OBJPROP_TIMEFRAMES`, not
observed.

Sources: [analytical objects](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) ·
[Trendline](https://www.metatrader5.com/en/terminal/help/objects/lines/trend_line) ·
[Horizontal Line](https://www.metatrader5.com/en/terminal/help/objects/lines/hor_line) ·
[Trendline by Angle](https://www.metatrader5.com/en/terminal/help/objects/lines/trend_line_angle) ·
[Rectangle](https://www.metatrader5.com/en/terminal/help/objects/shapes/rectangle) ·
[Fibonacci Retracement](https://www.metatrader5.com/en/terminal/help/objects/fibo/fibo_retracement) ·
[Fibonacci Expansion](https://www.metatrader5.com/en/terminal/help/objects/fibo/fibo_expansion) ·
[Gann Fan](https://www.metatrader5.com/en/terminal/help/objects/gann/gann_fan) ·
[Andrews' Pitchfork](https://www.metatrader5.com/en/terminal/help/objects/channels/andrews_pitchfork) ·
[visibility constants](https://www.mql5.com/en/docs/constants/objectconstants/visible) ·
[object properties](https://www.mql5.com/en/docs/constants/objectconstants/enum_object_property) ·
screenshots [obj_properties_common.png](https://www.metatrader5.com/i/help/terminal/en/obj_properties_common.png) ·
[obj_properties_levels.png](https://www.metatrader5.com/i/help/terminal/en/obj_properties_levels.png) ·
[trendline_parameters.png](https://www.metatrader5.com/i/help/terminal/en/trendline_parameters.png) ·
[gann_fan_parameters.png](https://www.metatrader5.com/i/help/terminal/en/gann_fan_parameters.png) ·
[andrews_pitchfork_parameters.png](https://www.metatrader5.com/i/help/terminal/en/andrews_pitchfork_parameters.png) ·
[ru object_visualization.gif](https://www.metatrader5.com/i/help/terminal/ru/object_visualization.gif)

## 3. Object interaction on the chart (desktop)

### Selecting

**Double click by default; single click if the option is on.** Verbatim from Options → Charts:

> **"Select objects by single mouse click — graphical objects in the platform can be selected
> by a single or double click. This option allows switching between the object selection
> methods. If it is enabled, all objects are selected by a single click. If this option is
> disabled, all objects are selected by a double click."**

**The exact option string is "Select objects by single mouse click"** — plural "objects". The
Analytical Objects page quotes it as *"Select objects by single mouse click"* too, so the two
pages agree.

MetaQuotes never states the shipped default. **Which way the option ships is UNVERIFIED.**

Related options on the same page, verbatim labels:

- **Show object properties after creation** — "allows to automatically open the window of
  properties of graphical objects and indicators after they are applied to a chart"
- **Select objects after creation** — selects an object automatically right after placing it
- **Precise time scale** — "if this option is disabled, objects are bound to bars along the
  horizontal scale of a chart. If you enable it, then it is possible to position an object at
  any point between bars"
- **Magnet sensitivity** — in pixels; "if the value of 10 is specified, the object will
  automatically be docked to a bar if the object's anchor point is located within a distance
  of 10 pips from the nearest bar price (OHLC)". `0` disables it. Note MetaQuotes writes the
  unit as **pixels** in one clause and **pips** in the next, in the same sentence. Unreconciled.

### Selection handles

**"Click on an object to select it. Square markers or frames appear for a selected object. The
markers are used for moving objects and changing their drawing parameters."**

So: **square markers**, or a frame. Per object family, from each object's "Controls" section:

| Family | Handles |
|---|---|
| **Trendline** | **Three** points. "Extreme points are points for changing size and slope. The central one is used for moving the object." |
| **Rectangle** | **Three** control points. "Points located on faces are used for changing the size of the rectangle. The point located in the center is used for moving the object without changing its shape." |
| **Fibonacci Retracement** | **Three** points on the trendline. "The first and the last points allow changing the trendline length and direction. The central point (moving point) is used for moving the object." |
| **Gann Fan** | **Two** points, both on the 1x1 trendline. "These points are used for positioning Gann Fan in a chart." The slope is changed via Pips per bar, not by dragging. |
| **Andrews' Pitchfork** | **Four**. "Moving of the "handle" beginning point will change the direction of "teeth" only. The second point of the "handle" allows moving Andrews' Pitchfork in the chart without changing its dimensions. Points of "teeth" beginning allow changing the position of teeth separately." |
| **Horizontal Line** | One point (it is a one-point object). Handle count not stated. |

General rule: **"The object moving points is its central point as a rule."**

**Handle colour and exact shape beyond "square" are UNVERIFIED.** MetaQuotes names no colour
and gives no pixel size, and the handles are not legible in any help screenshot at the
published resolution.

### Right-click context menu on an object

MetaQuotes lists the object context menu verbatim, with icons on all but two entries:

| Order | Item | Does |
|---|---|---|
| 1 | **Properties** | "open the properties of a selected object" |
| 2 | **Object List** | "open the Object List to manage objects on the chart" |
| 3 | **Delete** | "delete the selected object" |
| 4 | **Delete All Arrows** | "delete all arrows belonging to the Arrows group" |
| 5 | **Delete All Selected** | "delete all selected objects" |
| 6 | **Unselect All** | "unselect all objects on the chart" |
| 7 | **Unselect** | "unselect the selected object" |
| 8 | **Undo Delete** | "restore the last deleted object" |

Items 1, 2, 4, 5, 6 and 8 carry icons; **Delete** and **Unselect** do not. Whether separators
divide the menu is **UNVERIFIED** — the page renders it as a flat list, not a screenshot.

### Other chart interactions

- **Copy an object:** "Select an object, hold down Ctrl and move the object using its central
  marker."
- **Move a group:** "To move a group of objects, select them and drag the point of one of them
  while holding down Alt."
- **Delete sequentially:** **Backspace** — "Delete the latest objects imposed to a chart."
- **Undo a delete:** **Alt+Backspace or Ctrl+Z** — "Cancel object deletion." The prose route is
  **"Object — Undo Delete" in the Charts menu**.
- **Magnet:** anchor points (but not central moving points) snap to Open / High / Low / Close
  within the Magnet sensitivity distance. On a timeframe above M1 the anchor binds to the
  specific *minute* the extremum occurred, "which allows keeping proper positioning of objects
  when switching between timeframes".

Sources: [analytical objects](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) ·
[platform settings](https://www.metatrader5.com/en/terminal/help/startworking/settings) ·
[hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
the per-object pages linked in section 2

## 4. Mobile (Android / iOS) objects UI

**Yes, both mobile apps have an objects list, and it is materially different from desktop.**

### Android

- **Opened from the radial menu**, by tapping the objects icon. Not a named screen title in
  the prose.
- **"To open a list of all objects, tap [objects icon]. The objects are grouped according to
  the charts on which they are used. The object for which the display on all symbols is
  enabled are shown under the separate "Independent charts" category."**
- **Adding:** radial menu → objects icon → "Select the desired object from the list of
  recently used objects or tap [+] at the top of the window." So the list leads with
  **recently used objects**.
- **Categories on mobile are six, not eight:** Lines, Channels, Gann Tools, Fibonacci Tools,
  Elliott Tools, Shapes. **Arrows and Graphical objects are absent.**
- **Hard cap: "The total number of objects on all charts cannot exceed 512. If you try to add
  more objects, the oldest objects will be automatically deleted."**
- **Top-of-list controls:** a **lock** button ("This will disable the ability to move objects
  or access their properties") and a **hide** button ("To quickly view a "clean" chart without
  deleting the previously added objects"). "You can also hide individual objects by tapping
  the similar buttons next to their name."
- **Deleting:** tap the delete button at the top, select objects, tap delete again.
- **Properties:** tap the object to select, then long-tap, then tap the edit button.
- **Property fields:** **Name**, **Ray right/left**, **Point**, **Symbol**, **Timeframe**,
  **Style**, **Draw as background**, **Levels**.
- **Selection is a single tap**: "select the object by tapping on it. The object is considered
  selected when markers (object points) appear."
- A **zoomed sub-window appears in the upper left corner** while dragging a point.
- **Copying:** long press → copy button on the top panel.

### iOS (iPhone)

- **Opened from the top of the chart**, not a radial menu: "tap [objects icon] at the top of
  the chart".
- **Adding:** "Then tap **"Add object"** or select one of the recently used objects below."
- **Categories are seven** — the same six as Android **plus Text** ("an object to add text
  labels to the chart").
- **Hard cap is 128**, not 512: "The total number of objects on all charts cannot exceed 128."
- **Top-of-list controls are named in text:** **"Lock all"** and **"Hide all"**.
- **Deleting:** a delete-all button in the upper right, or **swipe right-to-left on the object
  row** and use the **"Delete"** button that appears.
- **Properties:** long-tap the object → **"Properties"** from the context menu; or tap the
  objects icon and select one of the added objects.
- **Property fields:** **Name**, **Ray right/left**, **Coordinates**, **Visualization**,
  **Style**, **Draw as background**, **Levels**.

### Desktop / mobile divergences that matter

1. **Mobile has no Description field** on an object. Desktop's Common tab has one. So mobile
   cannot populate the desktop Objects List "Description" column.
2. **Mobile has a Symbol dimension desktop lacks.** Android exposes **Symbol** (with an "All
   symbols" value); iOS folds it into **Visualization** ("instruments and timeframes"). Objects
   set to all symbols appear under **"Independent charts"**.
3. **The anchor-points field is named differently on each platform:** desktop **Parameters**
   (Date/Value), Android **Point**, iOS **Coordinates**.
4. **Timeframe visibility is named differently:** desktop **Visualization** tab, Android
   **Timeframe** field, iOS **Visualization** field.
5. **"Draw as background"** on mobile vs **"Draw object as background"** on desktop.
6. **Mobile has no Disable selection**; it has **Lock all** / **Hide all** instead, which are
   list-level, not per-object properties.
7. **Object caps differ three ways:** Android 512 across all charts, iOS 128 across all charts,
   desktop unstated.
8. **Mobile drops whole object categories** — no Arrows or Graphical objects on either; iOS
   keeps Text, Android does not.
9. **iOS states explicitly that per-timeframe settings require duplication:** "If the object
   should have different settings depending on the chart period, create several copies of the
   object and enable the display for each of them in the required timeframe."

Sources: [Android objects](https://www.metatrader5.com/en/mobile-trading/android/help/chart/objects) ·
[iPhone objects](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart/objects)

## 5. Cross-checks against section 5 of `03-chart-ui.md`

The earlier summary line in `03-chart-ui.md` — *"Objects List (Ctrl+B) — columns Object · Name
· Description · Window; buttons Show · Properties · Delete · List all. Object Properties tabs:
Common · Parameters · Levels · Visualization"* — is **correct on columns and buttons** and
**wrong on tab order**. Tab order is **Common · Levels · Parameters · Visualization**, and
Levels is present only on Fibonacci tools and Andrews' Pitchfork. That line should be amended.

The 44-vs-46 discrepancy noted there still stands: the Analytical Objects page says **"The
trading platform provides 46 analytical tools"** and **"46 analytical objects are available"**,
while `ENUM_OBJECT` enumerates exactly **44** constants (verified by extracting the full
constant list). Unreconciled.

## Could not verify

1. **Whether the Objects List can be sorted by clicking a column header.** No MetaQuotes text
   or screenshot addresses it.
2. **Double-click behaviour on an Objects List row.** Not documented anywhere.
3. **The fourth column header's full text as rendered.** It is clipped to one glyph plus an
   ellipsis in the only screenshot; the prose names it "Window".
4. **What generates the object ID in the auto-generated name.** Range, algorithm and whether
   it is monotonic are all undocumented. Observed values are 4–5 digits.
5. **Ctrl+A is contradicted** — "select all objects" (objects-list page) vs "Arrange height of
   all indicator windows by default" (hot-keys page). Probably different focus contexts, never
   reconciled by MetaQuotes.
6. **The English labels on the Visualization tree.** "All timeframes" is transcribed from
   English prose; "Minutes / Hours / Day / Week / Month" are translated from the Russian
   screenshot because **MetaQuotes' English `object_visualization.gif` is the wrong image** —
   it serves a Levels screenshot, byte-identical to `indicator_visualization.gif`.
7. **The expanded contents of the Visualization tree's Minutes and Hours nodes.** The 11 + 7
   split is inferred from `OBJPROP_TIMEFRAMES`, never screenshotted.
8. **Whether the monthly leaf reads "Month", "MN" or "MN1".**
9. **Whether `(%$)`'s parentheses are part of the token** or just sentence punctuation. No
   screenshot shows a level description using it.
10. **Any level-description placeholder other than `%$`.** None is documented in the MT5 help
    or the MQL5 reference; `%$` itself is documented for only two objects (Fibonacci
    Retracement and Fibonacci Expansion).
11. **The shipped default of "Select objects by single mouse click".**
12. **Selection handle colour and size.** "Square markers or frames" is all MetaQuotes says;
    handles are not legible in any published screenshot.
13. **Whether the object right-click context menu has separators**, and whether it carries
    items beyond the eight listed.
14. **Whether any object type lacks a Parameters tab.** All seven sampled objects have one.
15. **The Levels tab prose omits the "Edit" button entirely** and calls the reset button
    "Defaults" where the dialog reads "Default". Screenshot preferred; unreconciled.
16. **"Edit" vs "Properties" as the Objects List button label** — the Analytical Objects page
    says "click "Edit"", the objects-list page and the screenshot both say "Properties".
17. **Magnet sensitivity's unit** — MetaQuotes writes "pixels" and "pips" in the same sentence.
18. **Desktop's maximum object count per chart.** Mobile states 512 (Android) and 128 (iOS);
    desktop states nothing.
19. **"46 analytical objects"** (help prose) vs **44** (`ENUM_OBJECT`). Carried over from
    `03-chart-ui.md`, still unresolved.

## Sources

MetaQuotes MT5 help:
[lists of objects applied](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) ·
[analytical objects](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects) ·
[platform settings](https://www.metatrader5.com/en/terminal/help/startworking/settings) ·
[hot keys](https://www.metatrader5.com/en/terminal/help/start_advanced/hotkeys) ·
[lines](https://www.metatrader5.com/en/terminal/help/objects/lines) ·
[Trendline](https://www.metatrader5.com/en/terminal/help/objects/lines/trend_line) ·
[Trendline by Angle](https://www.metatrader5.com/en/terminal/help/objects/lines/trend_line_angle) ·
[Horizontal Line](https://www.metatrader5.com/en/terminal/help/objects/lines/hor_line) ·
[shapes](https://www.metatrader5.com/en/terminal/help/objects/shapes) ·
[Rectangle](https://www.metatrader5.com/en/terminal/help/objects/shapes/rectangle) ·
[Fibonacci tools](https://www.metatrader5.com/en/terminal/help/objects/fibo) ·
[Fibonacci Retracement](https://www.metatrader5.com/en/terminal/help/objects/fibo/fibo_retracement) ·
[Fibonacci Expansion](https://www.metatrader5.com/en/terminal/help/objects/fibo/fibo_expansion) ·
[Gann tools](https://www.metatrader5.com/en/terminal/help/objects/gann) ·
[Gann Fan](https://www.metatrader5.com/en/terminal/help/objects/gann/gann_fan) ·
[channels](https://www.metatrader5.com/en/terminal/help/objects/channels) ·
[Andrews' Pitchfork](https://www.metatrader5.com/en/terminal/help/objects/channels/andrews_pitchfork) ·
[indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators)

MetaQuotes mobile help:
[Android objects](https://www.metatrader5.com/en/mobile-trading/android/help/chart/objects) ·
[Android chart](https://www.metatrader5.com/en/mobile-trading/android/help/chart) ·
[iPhone objects](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart/objects) ·
[iPhone chart](https://www.metatrader5.com/en/mobile-trading/iphone/help/chart)

MQL5 reference:
[ENUM_OBJECT](https://www.mql5.com/en/docs/constants/objectconstants/enum_object) ·
[ENUM_OBJECT_PROPERTY](https://www.mql5.com/en/docs/constants/objectconstants/enum_object_property) ·
[visibility of objects](https://www.mql5.com/en/docs/constants/objectconstants/visible) ·
[ObjectCreate](https://www.mql5.com/en/docs/objects/objectcreate) ·
[ObjectName](https://www.mql5.com/en/docs/objects/objectname) ·
[ObjectsTotal](https://www.mql5.com/en/docs/objects/objectstotal) ·
[OBJ_FIBO](https://www.mql5.com/en/docs/constants/objectconstants/enum_object/obj_fibo)

Screenshots read directly (all under `https://www.metatrader5.com/i/help/terminal/`):
`en/objects_list.png` · `en/obj_properties_common.png` · `en/obj_properties_levels.png` ·
`en/object_plot_settings.gif` · `en/object_visualization.gif` (**wrong asset**) ·
`en/indicator_visualization.gif` (byte-identical to the previous) ·
`ru/object_visualization.gif` (**the only correct Visualization-tab image**) ·
`en/trendline_parameters.png` · `en/horizontal_line_parameters.png` ·
`en/rectangle_parameters.png` · `en/fibo_retracement_parameters.png` ·
`en/gann_fan_parameters.png` · `en/andrews_pitchfork_parameters.png`

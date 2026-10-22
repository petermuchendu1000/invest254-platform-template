# 19. Desktop and phone, one feature at a time

Asked for: *"You need to test everything both in mobile and desktop - one item at a time, every
feature, tool, how do they behave, are they accessed in both mobile and desktop, what are their
UI/UXs...? take screenshots, compare it with official MT5, then, enforce complete UI/UX."*

## How this is measured

The phone shell and the desktop terminal are different **trees**, not one tree restyled
(`lib/ui/useIsPhone` says why). So a control present in the source proves nothing about whether a
finger can reach it, and the audit asks the only question that matters: **starting from a fresh
page, can a trader get to this feature on this shell?** `scratchpad/parity.mjs` answers it by
navigating and looking for a VISIBLE element, at 1440x900 and at 360x800.

Each row carries its own selector **per shell**, because MetaTrader itself puts the same feature in
different places on the two:

| | desktop | phone |
| --- | --- | --- |
| period | a 21-button strip across the toolbar | one button that opens a quick strip, gear for the full sheet |
| indicators | the `⚙ Tools` menu | the `∿` button |
| objects | a left-hand rail with an Insert tree | an Objects button in the top bar (iOS) / radial menu (Android) |

A row that used the same selector on both would be testing this shell's sameness, not MetaTrader's
parity.

## The matrix

20 of 21, after the two gaps below were closed.

| feature | desktop | phone |
| --- | :-: | :-: |
| Market Watch / symbol list | yes | yes |
| Add a symbol | yes | yes |
| Timeframes (all 21) | yes | yes |
| Chart type (4) | yes | yes |
| Indicators (38) | yes | yes |
| Chart Properties (F8) | yes | yes |
| Auto scale / free movement | yes | yes *(was no)* |
| Objects: INSERT an object | yes | yes *(was no)* |
| Objects List | yes | yes |
| Crosshair | yes | yes |
| One-click trading panel | yes | yes |
| Order ticket: volume | yes | yes |
| Order ticket: Stop Loss | yes | yes |
| Order ticket: Take Profit | yes | yes |
| Levels in Price \| Pips \| Currency | yes | **no** |
| Expiry | yes | yes |
| Sell / Buy by market | yes | yes |
| Account summary line | yes | yes |
| Open positions list | yes | yes |
| History: Positions / Orders / Deals | yes | yes |
| Messages / notifications | yes | yes |

## The one row still unequal, and why it was NOT "fixed"

`Levels in Price | Pips | Currency` is on the desktop ticket and not the phone's. The phone ticket
sets a stop and a target perfectly well — `Lower SL` / `Raise SL` / `Lower TP` / `Raise TP`, as
prices. What it has no control for is the UNIT those figures are stated in.

This is left alone deliberately. `04-mobile-app.md` does not document that control on MetaTrader's
mobile new-order screen in either direction; the only related researched fact is that while dragging
a level on the chart, *"potential P/L shows in points and in money"* (section 3). Adding a unit
selector because the desktop has one would be inventing MetaTrader behaviour from this shell's own
symmetry, which is the opposite of what this whole exercise is for. **Open question for a future
research pass**, not a defect to patch.

## The first gap: no way to create an object on a phone

**A phone trader could not create a graphical object.** The desktop object rail is
`{phone ? null : <DrawRail .../>}` in `CandleChart.tsx`, and the phone's indicator sheet carried
only the Objects **list** — so the phone listed objects it had no way to produce. The rail was
dropped deliberately (it took 40 of 360 pixels, and MetaTrader's Android chart has no rail either),
but the thing that replaces it on MetaTrader was never built.

What MetaTrader actually does, from the researched facts in
[04-mobile-app.md](./04-mobile-app.md):

* §3 — *"iOS has a dedicated Objects button in the top bar; Android does not — on Android,
  graphical objects are reached through the radial menu only."*
* §5 — the iOS chart context menu is **Trade · Indicators · Objects · Settings · Cancel**; the
  Android radial menu's documented capabilities are *change the timeframe · attach indicators ·
  **apply objects** · enable crosshairs · open chart settings*.

So **both** phone platforms can apply an object; only the route differs. This shell now carries
iOS's route, which is the one that fits a top bar it already has: an **Objects** button beside
Indicators, opening MetaTrader's 44-object Insert tree as a sheet in its own eight groups. Picking
one arms the tool and closes the sheet, so the next tap lands on the chart — the same `setTool` the
desktop rail drives, into the same `ChartDrawings` surface, which was already rendered on the phone
and simply had nothing to arm it. The sheet also carries Cursor (a phone has no Esc to cancel a
pending object with) and the Objects list.

## The second gap: no vertical-scale control on the phone

MetaTrader documents three vertical-scale commands for **both** mobile platforms
([04-mobile-app.md](./04-mobile-app.md) section 6): *"There is an **Auto-scale** mode that restricts
movement to horizontal only and auto-fits the price range; **Free chart movement** returns to 2-D.
**Reset vertical scale** restores the original scale. (Both platforms.)"*

The desktop Tools menu carried all three. The phone carried none — so a phone trader who stretched
the price axis had no way back but a reload, on the one shell where that stretch happens by
accident, with a finger. All three are now in the phone's chart sheet, driving the same
`setAutoScale` / `resetVerticalScale` the desktop menu drives.

## Not gaps, and why

Seven rows of the first matrices read "not reachable" and were the PROBE, not the product. Each was
checked by hand before anything was changed, which is the only reason none of them turned into a
pointless fix:

| row | what was really true |
| --- | --- |
| Add a symbol (phone) | the Quotes screen has its own `Add symbol` button; the probe looked for the desktop row's "click to add" wording |
| Order ticket SL / TP (phone) | the ticket has `Lower SL` / `Raise SL` / `Lower TP` / `Raise TP` — it abbreviates, as MetaTrader's own phone ticket does |
| History tabs (both) | `POSITIONS ORDERS DEALS` are on both; the probe's settle was too short for a route that fetches positions AND transactions |
| Messages (desktop) | `Ctrl+T` opens the full Toolbox: Trade, Exposure, History, News, **Mailbox**, Calendar, Alerts, Articles, Code Base, Experts, Journal |
| History tabs, again | the tabs are capitalised in the markup and uppercased in CSS, so `innerText` reads `ORDERS` while the DOM text a selector matches reads `Orders` |
| Indicators (desktop) | all 38 open from the `⚙ Tools` menu |
| Auto scale (desktop) | in that same menu |

The last two were an artefact of the probe itself: four rows open the Tools menu, and when the probe
stopped reloading between rows, the second click on an already-open menu CLOSED it. Each row gets a
fresh page for that reason.



* **Pending order.** Present on the phone bar and DISABLED, with the reason on it: every contract
  here is market execution. Absent on the desktop ticket, which states `Market Execution` instead.
  Both are honest about the same fact.
* **Zoom buttons.** Desktop only, and correctly: they are `[@media(pointer:coarse)]:hidden`, and
  MetaTrader's phone chart zooms by pinch, which is documented verbatim in §6.
* **Measure.** Desktop rail only. MetaTrader's phone measures through the crosshair instead: *"tap a
  second point to measure"* (§6), which this shell's crosshair does.
* **The desktop top bar.** It is the brand's `colorPrimary` blue strip. On a phone that is right —
  MetaTrader's mobile app has a blue navigation bar. On the desktop terminal MetaTrader uses dark
  chrome with a File/View/Insert menu. A shell-structure question, carried forward.

## Probes

* `scratchpad/parity.mjs` — the reachability matrix above, both shells.
* `scratchpad/verify.mjs`, `scratchpad/verify2.mjs` — the by-hand check of every row that read "not
  reachable", which is what separated the one real gap from the six false ones.
* `scratchpad/phoneobjects.mjs` — 6/6. Opens the Objects button on a 360x800 touch screen, picks
  Trendline, taps twice on the plot, and reads MetaTrader's own
  `Objects on XAUUSD,M1 (1)` heading back off the Objects list.

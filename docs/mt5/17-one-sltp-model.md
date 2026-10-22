# One Stop Loss and one Take Profit, on both shells

## The reported bug

> "SL/TP and amounts etc does not work on desktops."

It was accurate, and worse than it sounds. There were **two different SL/TP concepts** in the app and
they did not know about each other.

| | phone advanced dialog | desktop ticket, Toolbox, Modify |
|---|---|---|
| concept | SL **and** TP | TP only |
| unit | signed **points** from an anchor price | **money** (floating profit, in cents) |
| anchor | `ref`, so a level is a stable price | none |
| shown as | Price / Pips / Currency | money only |
| ratio lock | yes | no |
| side swap | yes | no |
| drawn on the chart | yes, draggable | no |
| store | `pp-order-levels` | `pp-take-profit` |

So on desktop:

- **The Stop Loss was a read-only `<span>`** printing the stake. There was no control: a stop could
  not be set at all, by any means.
- **The Take Profit was a different concept** wearing MetaTrader's label: a target floating profit in
  cents, with no unit selector, no lock and no side logic.
- **The chart never drew the levels.** `MT5ChartLevels` was gated on the `phone` prop, so the desktop
  chart mounted nothing, and nothing on desktop ever wrote the levels store anyway.
- **`useRestoreLevels()` had no desktop caller**, so a desktop session never even read the saved pair
  out of storage.
- **The amount control looked broken for three separate reasons**: the centre value was a `<span>`
  with no way to type into it, the two step cells were fixed at `[0.01, 0.1]`, and a fresh ticket
  opens at the brand's minimum so **both minus cells were greyed from the first paint**.

And the phone was not consistent with itself either: its simple ticket used the money store while
its advanced dialog used the points store, so a target set on one read "not set" on the other.

## MetaTrader's TP is a price, and now it fires like one

The money target's defence was that "closing at a price level would pay an amount unrelated to that
level". That is true of the **payout** — this contract's payout rises with elapsed time, not with the
distance to a level — but it is not what MetaTrader's T/P promises. MetaTrader's T/P promises to
**close there**. What the close is worth is a separate question, and the UI says so.

So `lib/game/levelWatch.ts` closes the position when the price reaches the TP level, through the
ordinary manual sell, under the engine's own two conditions (the brand allows an early close, and the
contract was decided a win). MetaTrader's semantics, actually working.

It is armed in `TradeSurface`, which is the one parent both shells hang off. The money watcher it
replaces was armed **inside the desktop Toolbox**, so on a phone a target could be set and nothing
would ever fire it.

There is no stop-loss trigger, and that is a fact about the engine rather than an omission: `sell`
refuses a losing position outright, and a contract whose price has crossed its stop is a losing one
by definition. A trigger would produce nothing but a refusal the trader never asked for. The rows say
so instead.

## What is now one thing

| surface | before | after |
|---|---|---|
| desktop ticket | SL a label, TP in money | `MT5LevelRows`: both levels, Price/Pips/Currency, ratio lock, type-in |
| desktop chart | drew nothing | draws and drags both levels |
| Toolbox S/L and T/P columns | the stake, and a money stepper | the levels, as prices, stepped in points |
| Modify position | money stepper | the levels, as prices |
| Close position | printed the money target | prints the TP level |
| phone simple ticket | money stepper | the levels, as prices |
| phone advanced dialog | the levels | unchanged |

`lib/game/takeprofit.ts` is deleted. One store, one concept, six surfaces.

## Shaped for a docked panel, not copied from the phone

The phone stacks a chip above its stepper because at 360px a chip, two 44px buttons and a full price
came to 166px against 164 available. A docked ticket is wider and MetaTrader's own desktop ticket
puts each level on one row, so `MT5LevelRows` is label, stepper, clear.

## The amounts

- The centre value is a button that opens a field, which is MetaTrader's own affordance ("tap the
  centre value to type on the keyboard"). Typed figures go through `setLots`, so they snap to the
  symbol's grid and clamp to the brand's range: a typed volume cannot land off-grid or outside what
  the engine accepts.
- The step cells derive from the symbol's own step (see `14-per-symbol-volume.md`), so an index
  steps in tenths and the figures scale with the volume instead of being `[0.01, 0.1]` at 0.03 lots
  and at 30.

## Verified

| | |
|---|---|
| `apps/web/src/lib/game/levelWatch.test.ts` | 6 tests: a buy fires above and a sell below, the POSITION's direction decides rather than the level's shape, an unset level never fires, and a level is a price on the instrument's own tick |
| `scratchpad/desksltp.mjs` (1440x900) | **23/23**: both rows exist, the unit control and the lock are there, a stop can be set *at all*, the target is a price, stepping moves one point, the levels are drawn on the desktop chart in MetaTrader's colours, the chart tag and the ticket show the same number, Pips/Price round-trips, the volume takes a typed figure, the Toolbox shows S/L and T/P, and Modify position states the TP as a price |
| `scratchpad/toolbox.mjs` | 18/18 |
| `scratchpad/phone.mjs` | 128/128 |
| `scratchpad/ticket.mjs`, `levels.mjs` | 15/15, 4/4 |
| `npm test` | 1801 pass, 0 fail |

### Two probe details worth keeping

The Toolbox row re-renders on every tick (that *is* the live P/L), so a click aimed at it detaches
mid-click; the probe retries rather than forcing, because a forced click on a detached node proves
nothing about what a trader can reach.

And the desktop route to the position menu is a click on the table row, not the
`[aria-label^="Position menu"]` button: that button belongs to the narrow-screen row, which is
`sm:hidden` at desktop width, so it is in the DOM and never clickable. Aiming at it waits for ever.

### Known, not this change

`closeform.mjs` and `manualclose.mjs` both need a contract the engine decided a WIN before they can
exercise a close, and give up after nine tries at a 12.5% win rate. They fail on probability before
reaching any assertion about the close, on this branch and without it.

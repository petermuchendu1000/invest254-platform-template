# 18. MetaTrader's brand, on every screen a terminal can reach

Reported: *"position detail does not follow the MT5 brand — we were to address every form, page,
etc that does not follow the brand and enforce."*

## What was actually wrong

`MT5History` is a clean MetaTrader screen: a blue title bar, grey column headings, dotted-leader
figures. Tapping one of its deal rows opened `PositionDetailModal`, and **that file had no terminal
detection at all** — it rendered the app's generic `Modal`: a soft `rounded-2xl` card on the app's
`bg-surface`, with `text-up`/`text-down` for the figures and a brand-accent `Done` button. So one tap
took the trader from MetaTrader to the app.

Two more things were wrong once the screen was open, and neither is a colour:

1. **It printed the engine's curve rate, not the chart price.** `Price: 0.30412`, while the history
   table one layer behind it read `2,412.37` for the same trade. Those are different numbers for one
   figure: the rate is the engine's unitless curve value, the price is what the trader saw on the
   axis, stamped at execution (migration 0180). The detail now resolves both through `priceText`,
   the same function the screen it opens from uses — which also carries the `at market` fallback for
   a trade placed before the column existed, so no number is invented.
2. **It never named the instrument.** MetaTrader puts the symbol on every record. The trade does not
   carry its own symbol yet (task 64, blocked on the money-RPC migration), so the detail reads the
   one the terminal quotes, exactly as the history table does.

## The rest of the sweep

`PositionDetailModal` was the reported seam, not the only one. The screens were then swept
mechanically rather than by eye, because "looks MetaTrader-ish" is not a test. Two structural tells
separate MetaTrader's chrome from the app's, and both are measurable in the browser:

| tell | MetaTrader | the app's shell |
| --- | --- | --- |
| panel corners | 0–2px, a flush pane with a 1px rule | `rounded-xl` (14px) / `rounded-2xl` (20px) cards |
| surface | `#0f1720`, raised `#202933` | `bg-surface`, resolved through `--pp-*` to the brand |

`scratchpad/sweep.mjs` walks `/`, `/history`, `/wallet`, `/account` and `/dashboard` at desktop and
phone widths and fails any **panel-sized** box (at least 220x64 — a card, not a chip) whose radius is
over 4px, plus any page whose body is not MetaTrader's surface. It found four panes that were already
MetaTrader's *colours* but had kept the app's corner radius, which is the kind of miss that survives
a screenshot review:

- Market Watch (`MarketWatch.tsx`)
- the chart window (`GameCurve.tsx`)
- the Toolbox (`MT5Toolbox.tsx`)
- the order ticket (`MT5OrderTicket.tsx`, both its skeleton and its body)

and two smaller ones: the account panel (`MT5AccountPanel.tsx`) and the Interface menu. All are now
`rounded-sm`. Deliberately NOT squared: `rounded-full`, which is reserved here for status dots,
spinners and the support launcher — MetaTrader's own controls are round there too.

`AccountDialogs` (deposit, withdraw) is repainted a different way, through `MT5_TOKENS`: it is ~1,100
lines of payment code whose tokens are read from `--pp-*`, so re-pointing the properties repaints it
with no diff to the payment logic. See `lib/ui/mt5Tokens.ts`.

## What the sweep deliberately does not judge

- **The app accent.** This brand's `--pp-accent` is `#41be56`, within a few points of MetaTrader's
  own green, so an accent test here would pass on colours that are wrong and fail on colours that are
  right. Corners and surface are the honest signals.
- **Admin and platform routes.** `/admin/*` and `/platform/*` are back-office screens, not a
  trader's terminal; MetaTrader has no opinion about them.
- **The desktop top bar.** It is the brand's `colorPrimary` blue strip. On a phone that is right —
  MetaTrader's mobile app has a blue navigation bar. On the desktop terminal MetaTrader uses dark
  chrome with a File/View/Insert menu instead. That is a shell-structure question rather than a
  repaint, and is carried into the desktop/mobile parity audit.

## Probes

- `scratchpad/brand.mjs` — 22/22. Opens a settled deal from the History screen at both widths and
  asserts the detail paints on `#0f1720`, carries the blue title bar, has square corners, prints the
  chart price rather than the rate, and names the instrument.
- `scratchpad/sweep.mjs` — 22/22. The corner-and-surface sweep above.

The stub API (`scratchpad/stubapi.mjs`) now serves two settled deals and a `/positions/:id` record,
because the engine is in-memory and restarts with no history, and the probe needs a closed deal to
open.

# 54 — The candlestick trade screen (`trade_ui = 'candlestick'`)

A fourth trade layout, beside `classic`, `digits` and `broker`. **Migration:** `0189_trade_ui_broker_candlestick.sql`

## What it is
One screen: the chart on the left, a Trading Panel and a Chat / Top / Tours rail on the right. On a
phone the same four surfaces become four tabs with a tab bar under them. Built to a supplied mock,
to its own measurements and palette (`#0a0f1c` page, `#111827` panels, `#1f2937` rules,
`#22c55e` accent) rather than the brand token set — this layout is the product being sold, so it
looks the same on every brand that wears it, with only the wordmark and the currency changing.

| | Phone (`< md`) | Desktop (`md+`) |
|---|---|---|
| Chart | 350px, under a sticky 40px quote bar | fills the column under a 64px quote bar |
| Panel | under the chart, same scroll | 320px rail column |
| Chat / Top / Tours | three of four bottom tabs | 320px rail column (640px rail at `lg`) |

Two trees, `md:hidden` / `hidden md:flex`, not one tree at two widths — the mock is two arrangements,
and the server's first paint is already right on both.

## `broker` — the name for what was already here
The MetaTrader terminal (Market Watch, order ticket, Toolbox, chart toolbars) had no name: it
rendered whenever `sites.chart_style` was a TradingView type. `trade_ui = 'broker'` names it, so a
brand can wear the terminal without that being a side effect of which chart it bought. **The old
route still works** — `isBrokerTerminalBrand()` (lib/ui/terminalScreen) accepts either, which is why
every candlestick brand live today (muchwins) is unaffected. Both the screen and the shell call it;
they must agree, or the terminal renders inside the wrong chrome.

## Turning it on
1. Set `sites.trade_ui = 'candlestick'`.
2. **Set `sites.chart_style` to `candlestick`** (or `bars`/`baseline`) as well. The screen draws OHLC
   bars, and only a market-profile chart style makes the engine produce them — on a `line` brand
   `getMarket()` is null, so there is no price anchor and the tape stays empty.
3. Preview before flipping either: `?ui=candlestick` on any brand. The override persists to
   localStorage and is resolved in ONE place (`lib/ui/tradeUi`), so the screen AND its shell both
   honour it.

## The contract is unchanged
Stake, direction and the brand's default duration — the same rise/fall contract `BetPanel` places,
settled by the same engine, in KES cents. The mock has no expiry control and neither does this
screen: the duration comes from `/game/config`. The three money rules are copied from `BetPanel`
deliberately rather than shared, because they are the money path: a logged-out tap opens the deposit
sheet seeded with the stake, a short balance does the same, and one tap is one trade.

## Three things the mock shows that this does NOT fake
The page this was built from generates some of its own content (it ships a `/api/chat/simulate`).
Where that content would be invented here, the surface is built and the true state is shown instead:

- **Live Chat** — the mock's is a public room carrying `System: <name> has successfully withdrawn
  KES 14,650`. Those withdrawals did not happen. The tab keeps the mock's chrome and carries the
  **real** customer-care chat this product already has (docs/50). The "2,341 Online" counter is
  dropped: there is no number that would be true.
- **Top Traders** — no leaderboard exists (no endpoint, no table, and no decision about what "top"
  measures). The panel is built to the mock and says it has nothing to show. Wire a ranking to
  `rows` in `TopTradersPane` and it is finished.
- **Tournaments** — same: the surface is here, there are no tournaments behind it.

## Stop Loss
Rendered exactly as the mock renders it, and **disabled unless the brand's engine prices
continuously** (`isContinuousBrand`), with the reason on the control. The engine holds protective
levels as *prices* and fires them on its own tick; it has no money stop, and deriving a price from a
shilling figure would be new game math rather than a UI change. The field on the page this copies is
never sent to its own trade API at all.

## Files
| File | What it is |
|---|---|
| `components/game/candlestick/CandlestickTradeScreen.tsx` | both arrangements + the tab state |
| `components/game/candlestick/CandlestickTape.tsx` | the chart: bars, two axes, nothing else |
| `components/game/candlestick/TradingPanel.tsx` | order entry, and the in-flight contract |
| `components/game/candlestick/{ChatPane,TopTradersPane,TournamentsPane}.tsx` | the rail |
| `components/game/candlestick/HowToModal.tsx` | How to Trade, written for THIS contract |
| `components/layout/CandlestickTopBar.tsx` | the header; its shell branch is in `AppShell` |
| `lib/ui/tradeUi.ts` | `resolveTradeUi` + the `?ui=` override, shared by screen and shell |

`CandlestickTape` is deliberately not `CandleChart`: that one is MetaTrader's chart and belongs to
the broker terminal. Hiding its chrome with CSS would leave its state, shortcuts and context menus
live underneath.

# MT5 fidelity: the facts, and the gap

The goal is a terminal that is MetaTrader 5, not a terminal that resembles one. Everything
in this folder was researched on 2026-10-05 from MetaQuotes' own help, the MQL5 reference
and MetaQuotes' own screenshots read pixel by pixel. **Every claim carries a source.** Where
a fact could not be established the report says "I could not verify X" instead of filling
the gap, and those gaps are listed per document so they can be settled deliberately rather
than invented.

This exists because the opposite happened: the close-position experience was designed from
memory, and the result was a notification MetaTrader does not have in place of a form it
does.

| File | Covers |
|---|---|
| `01-order-and-close-dialogs.md` | New Order, Close position, Modify position, one-click trading, error strings, measured colours. Desktop and mobile. |
| `02-toolbox-and-panels.md` | Toolbox tabs and columns, Market Watch, Depth of Market, Symbol Specification, account summary line. |
| `03-chart-ui.md` | Toolbars, chart types, F8 Properties, scales and gestures, the 44 objects, the 38 indicators, trade levels. |
| `04-mobile-app.md` | The five bottom tabs, Quotes/Chart/Trade/History/Settings, the mobile close screen. |
| `05-options-reports-tradingview.md` | Options (12 tabs), login, reports/statement, DoM, push behaviour. TradingView conventions and palette. |
| `06-our-current-ui-inventory.md` | What this repository actually renders today, read from the source. |
| `07-objects-list-and-properties.md` | Objects List (Ctrl+B) columns and buttons, Object Properties tabs and fields, on-chart selection and context menu, mobile objects. |
| `08-chart-properties.md` | Chart Properties (F8): the three tabs, 13 colours, 4 schemes, 13 Show checkboxes, the scale-fixing controls, the chart context menu, chart shift. **MT5 has no logarithmic scale.** |
| `09-toolbox.md` | The Toolbox window (Ctrl+T), its docking, the twelve tabs in order plus the conditional `Search` tab, exact columns and context menus per tab, the account summary line measured character by character, Margin Call behaviour, mobile equivalents. |
| `10-market-watch.md` | Market Watch (Ctrl+M), its four tabs `Symbols/Details/Trading/Ticks`, the six Symbols columns, tick-direction colouring measured to the hex value, both published context menus, Depth of Market, the complete Symbol Specification field list, the Symbols dialog, mobile `Quotes`. |
| `11-market-data-sources.md` | Where prices and symbol metadata may lawfully come from. **TradingView has no public data API and its ToS forbids redistribution.** Binance / Coinbase / Kraken / Bitstamp, ECB + Frankfurter, Alpha Vantage / Twelve Data / Finnhub / Massive (ex Polygon.io) / Marketstack free tiers, Yahoo, open data, and open symbol-reference datasets — each with its licence clause quoted. Ranked for metadata vs. redistributed prices. |

## Settled facts that contradicted our build

- **Profit is blue, loss is red.** "No green anywhere in the Trade or History P/L columns."
  MetaQuotes writes "Positive and negative values are colored in blue and red, respectively"
  four separate times for sibling columns.
- **MT5 has exactly three chart types** (Bar chart, Candlesticks, Line chart). Area and
  Baseline do not exist. Mobile adds Heikin Ashi as a native fourth.
- **The modern desktop order dialog has no Type dropdown.** It has a left sidebar:
  Market Execution / Limit Order / Stop Order / Stop Limit Order, plus Modify Position when
  opened on a position. The "Buy Limit / Sell Stop" strings live in the mobile tab strip.
- **Default Fibonacci levels are 0, 23.6, 38.2, 50, 61.8, 100, 161.8, 261.8, 423.6 %.**
  78.6 is not one of them.
- **The Toolbox has twelve tabs**, not six: Trade | Exposure | History | News | Mailbox |
  Calendar | Company | Alerts | Articles | Code Base | Experts | Journal.
- **The mobile app has five bottom tabs**, not six, and no Messages tab:
  Quotes · Chart · Trade · History · Settings.
- **The Options dialog has twelve tabs**, not eight.
- **There is no free, licence-clean source of redistributable intraday FX or metals prices.**
  Every free FX source checked is either end-of-day only (ECB), non-redistributable
  (open.er-api.com) or personal-use-only (Alpha Vantage, Finnhub, Twelve Data, Marketstack,
  Massive). XAUUSD benchmarks need a paid ICE Benchmark Administration licence. Crypto is the
  exception: CoinGecko's free Demo API may be redistributed commercially with attribution.
  See `11-market-data-sources.md`.
- **TradingView is a charting library, not a data source.** Lightweight Charts is Apache 2.0
  and free; TradingView's *data* is licensed "for exclusive display-only use" and its ToS
  says "we do not permit commercial usage of any of our services or APIs".
- **Market Watch prices are coloured by tick direction**, `#0000FF` up / `#FF0000` down, and
  back to the normal foreground colour after 15 seconds unchanged. Not by buy/sell, and **not
  grey** — MetaQuotes writes "Gray" but renders black on white and white on black. **Bid and Ask
  are coloured independently of each other.** See `10-market-watch.md`.

## Confirmed correct in our build

- Trade tab default columns: Symbol | Ticket | Time | Type | Volume | Price | S / L | T / P |
  Price | Profit, with `S / L` and `T / P` spaced around the slash exactly as the UI writes them.
- The `✕` in the Profit column closes a position immediately with no confirmation.
- Dragging the vertical scale rescales it; double-clicking it restores the automatic scale.
- All 21 timeframes.

## The gap, in the order it will be closed

Each item lands as its own change with its own browser test. No item is started before the
one above it is merged.

1. **Close position form** — the form exists in MT5 and we shipped a bare button.
2. **Order ticket** — bid and ask are two prices, not one; T/P is a price, not an amount;
   the Expiry row has no MetaTrader equivalent.
3. **Position context menu** — tap a Trade row for Close position / Modify position / Chart.
4. **Trade levels on the chart** — open position, S/L and T/P as draggable lines.
5. **Chart types** — drop Area and Baseline, add Heikin Ashi.
6. **Indicators** — 38 in four correctly-named groups.
7. **Objects** — the 44-object Insert tree, Objects List, object properties. **Done.** The
   tree, the `Objects on <SYMBOL>,<TF> (<count>)` list, the four-tab properties dialog and the
   eight-item object context menu are all built to
   [07-objects-list-and-properties.md](./07-objects-list-and-properties.md).
8. **Chart Properties (F8)** — three tabs, 13 colours, four schemes. **Done.** Common, Show
   and Colors, built to [08-chart-properties.md](./08-chart-properties.md). The
   `Linear | Log | Percent` price-scale control is deleted: MetaTrader has neither a
   logarithmic nor a percentage scale.
9. **Toolbox tabs** — Exposure, Calendar, Articles, Code Base, Experts. **Done.** All twelve,
   in MetaTrader's order, built to [09-toolbox.md](./09-toolbox.md). Exposure carries real
   numbers; Company is hidden exactly as MetaTrader hides it.
10. **Market Watch** — `Symbol | Bid | Ask | Spread | Time | Daily Change`, the four bottom
    tabs, tick-direction colouring, Depth of Market, Symbol Specification. Researched: build to
    [10-market-watch.md](./10-market-watch.md).
11. **Account summary line** — MT5's exact labels, spacing and Margin Call highlighting.
12. **Residual non-MT5 surfaces** — the welcome-bonus celebration still fires on a terminal
    brand, and "Bets" / "No bets yet" / "Won ×1.95" are still in player-facing history.

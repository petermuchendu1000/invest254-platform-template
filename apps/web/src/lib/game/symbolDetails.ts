'use client';

/**
 * MetaTrader's Market Watch **Details** tab, as data.
 *
 * Read off `en/market_watch_details_x2.png` at 4x (docs/mt5/10-market-watch.md section 5). It is not
 * a grid: two columns, label left and value right-aligned, under a blue `SYMBOL, Description`
 * header, with the same three-state direction glyph against every row that the Symbols tab puts in
 * its gutter.
 *
 * MetaTrader's own list for a futures contract runs to thirty rows. Most of them describe things
 * this instrument does not have, and a row with nothing behind it would be a worse answer than no
 * row: the exchange-model margins and limits, and every order-flow figure (`Volume`, `Deals`,
 * `Turnover`, `Open Interest`, `Buy Orders`, `Sell Volume` and the rest), because contracts here are
 * struck against the brand rather than matched against other orders, so there is no book to count.
 *
 * `Bid` and `Ask` ARE here, and used not to be. They were cut on the grounds that this platform
 * quotes one price with no spread; the engine now publishes the spread it has always charged, so
 * both sides are real figures derived from one quote. Their HIGH and LOW counterparts are still
 * absent: MetaTrader uses the `Last` trio when a symbol's chart is built on Last prices, which is
 * what this one's Chart mode says, and the session's extremes are that trio's.
 *
 * What is left is real, and is given in MetaTrader's own order and under its own labels. `Last High`
 * and `Last Low` rather than `Bid High`/`Bid Low` because MetaTrader uses the Last pair when a
 * symbol's chart is built on Last prices, which is what this one's Chart mode says.
 *
 * ── `Tick Value` and `Face Value`, the two rows a one-price platform does NOT lose ───────────────
 *
 * Neither is two-sided, so the argument that deletes `Bid`, `Ask` and `Spread` here
 * (docs/mt5/10-market-watch.md 404-417) does not touch them, and both sit at the head of
 * MetaTrader's own list (603-638). They were both missing, for one stated reason that has since
 * stopped being true.
 *
 * `Face Value` is now stated. It is the contract's nominal value, which on this platform is set by
 * the brand rather than by an exchange: one lot stakes a fixed sum (`LOT_STAKE_CENTS`), and that sum
 * is the whole of what a lot is. It is a real figure, not a derived one, which is why MetaTrader
 * renders it as a static row rather than a ticking one.
 *
 * `Tick Value` is still absent, and the reason it carried — that the payout follows elapsed time
 * rather than the price — is obsolete: the live result has followed the PRICE since
 * packages/shared/src/livepnl.ts was rewritten. The honest reason now is narrower and still holds.
 * The money a tick is worth is `stake * gain` per unit of favourable move, and `gain` is calibrated
 * by the settlement engine PER DIRECTION, server-side, and never sent to the client: a tick is
 * worth different money on a buy than on a sell of the same symbol, and the client is told neither
 * number. A single figure in this row would therefore be invented, and it would be invented twice
 * over. MetaTrader omits a row that has no meaning for an instrument, and that is what this is.
 */

export interface DetailRow {
  label: string;
  value: string;
  /**
   * Whether this row ticks.
   *
   * MetaTrader's rule: "Static rows show the grey dot and black text; live rows show green/red
   * arrows and blue/red values." Only the price and the change move between quotes here; the
   * session's own high, low, open and close move once a day, and the tick size never.
   */
  live: boolean;
}

export interface DetailInput {
  digits: number;
  /**
   * What one lot stakes, already formatted BARE — no currency code, as every figure in this list is
   * (docs/mt5/09-toolbox.md 429). This is MetaTrader's `Face Value`: see the header note.
   */
  faceValue: string;
  /** The live price, or null before a quote has landed. */
  last: number | null;
  /**
   * MetaTrader's two sides, around `last`, by the spread the engine charges. Null on a brand that
   * publishes none, and then the two rows are omitted rather than printed as the same number twice.
   */
  sides: { bid: number; ask: number } | null;
  /** The session's own bar: its open, high and low. Null when the day's bar has not arrived. */
  session: { open: number; high: number; low: number } | null;
  /**
   * The previous session's close.
   *
   * MetaTrader defines Daily Change against "the close price of the last session", and on this
   * platform that is exactly the day's base: the price axis is re-anchored every UTC midnight by
   * carrying the previous day's close forward. So the two are the same number by construction.
   */
  previousClose: number | null;
}

const fixed = (n: number | null, digits: number): string => (n === null ? '-' : n.toFixed(digits));

export function detailRows(i: DetailInput): DetailRow[] {
  const change = i.last !== null && i.previousClose ? ((i.last - i.previousClose) / i.previousClose) * 100 : null;
  return [
    // The tick: 10^-digits. MetaTrader leads its list with this.
    { label: 'Tick Size', value: (10 ** -i.digits).toFixed(i.digits), live: false },
    // MetaTrader's order puts Tick Value between these two. It is absent, and the header note says
    // why: the gain it follows from is per-direction and server-side, so no single figure is true.
    { label: 'Face Value', value: i.faceValue, live: false },
    // MetaTrader's order puts the two sides ahead of Last, and they tick with it.
    ...(i.sides === null ? [] : [
      { label: 'Bid', value: fixed(i.sides.bid, i.digits), live: true },
      { label: 'Ask', value: fixed(i.sides.ask, i.digits), live: true },
    ]),
    { label: 'Last', value: fixed(i.last, i.digits), live: true },
    { label: 'Last High', value: fixed(i.session?.high ?? null, i.digits), live: false },
    { label: 'Last Low', value: fixed(i.session?.low ?? null, i.digits), live: false },
    // No space before the percent sign, as the Symbols tab writes it and unlike the account strip.
    { label: 'Daily Change', value: change === null ? '-' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, live: true },
    { label: 'Open Price', value: fixed(i.session?.open ?? null, i.digits), live: false },
    { label: 'Close Price', value: fixed(i.previousClose, i.digits), live: false },
  ];
}

/**
 * Today's session so far, from the symbol's own closed hourly bars plus the live price.
 *
 * MetaTrader's `Open Price`, `Last High` and `Last Low` are the CURRENT session's, and the engine
 * deliberately never serves a bar that has not finished — "a bar that has not finished yet must
 * never be served as if it had" — so today's daily bar does not exist to ask for. Asking for the
 * last CLOSED daily bar instead returns yesterday's, which is what this panel used to show: a
 * session open from one day beside a Daily Change measured against another. The numbers were
 * individually true and told a lie together.
 *
 * Hourly bars are the cheapest honest source: the day chain keeps them for every day it has walked,
 * each carries its own high and low, and the hour still forming is covered by the live price.
 */
export function sessionSoFar(
  bars: ReadonlyArray<{ time: number; open: number; high: number; low: number; close: number }>,
  tradeDate: string,
  live: number | null,
): { open: number; high: number; low: number } | null {
  const today = bars.filter((b) => new Date(b.time * 1000).toISOString().slice(0, 10) === tradeDate);
  if (today.length === 0) {
    // Just after midnight there is no closed hour yet, so the live price is the whole session.
    return live === null ? null : { open: live, high: live, low: live };
  }
  const open = today[0]!.open;
  let high = -Infinity;
  let low = Infinity;
  for (const b of today) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  // The hour still forming is not in `bars`, so the live price extends the extremes itself.
  if (live !== null) {
    if (live > high) high = live;
    if (live < low) low = live;
  }
  return { open, high, low };
}

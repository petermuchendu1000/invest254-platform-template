/**
 * MetaTrader's Market Watch quote colours.
 *
 * Verbatim, from MetaQuotes' own help:
 *
 *   "Prices in the 'Market Watch' window have different colors: Blue — the current price is higher
 *    than the previous one; Red — the current price is lower than the previous one; Gray — the
 *    price has not changed for the last 15 seconds. If the depth of market and the Last trade price
 *    is available for a symbol, the color is determined by the Last price. Otherwise, the color is
 *    determined by the Bid price."
 *
 * Two things in that sentence are easy to read past, and both were wrong here before:
 *
 *   The third state is STALENESS, not an unchanged tick. A quote that keeps arriving at the same
 *   number does not lose its colour; a quote that stops CHANGING for fifteen seconds does. This
 *   panel used to hold its last direction colour for ever, so a dead feed looked exactly like a
 *   live one that had ticked up.
 *
 *   MetaQuotes' word "Gray" is wrong, and its own screenshots prove it. The unchanged price is
 *   sampled at #000000 on the white Market Watch and at #FFFFFF on the black Popup Prices, which is
 *   the window's normal FOREGROUND colour rather than a grey. Only the gutter glyph is literally
 *   grey. So the third state drops back to the panel's own text colour, which on this dark terminal
 *   is white; painting it grey would have dimmed a perfectly current quote that simply had not
 *   moved.
 *
 *   The colour follows the LAST price where a symbol has one, and only falls back to Bid where it
 *   does not. This platform quotes one price per symbol, which IS the last traded price, so the
 *   first branch applies and there is no bid to fall back to.
 */

/**
 * Blue, red, or the window's own foreground. `null` means no quote has arrived yet, which is not
 * one of MetaTrader's three.
 */
export type QuoteTone = 'up' | 'down' | 'stale';

/** MetaTrader's own timeout, in milliseconds. */
export const STALE_AFTER_MS = 15_000;

export interface QuoteToneInput {
  /** Direction of the last change, or null before any change has been seen. */
  up: boolean | null;
  /** When the quote last CHANGED, in epoch ms. Null before the first change. */
  changedAt: number | null;
  now: number;
}

export function quoteTone({ up, changedAt, now }: QuoteToneInput): QuoteTone | null {
  if (up === null || changedAt === null) return null;
  // "the price has not changed for the last 15 seconds" — measured from the last CHANGE, so a
  // repeated identical quote does not refresh it.
  if (now - changedAt >= STALE_AFTER_MS) return 'stale';
  return up ? 'up' : 'down';
}

/**
 * The colours themselves. MetaTrader's blue and red are the same pair it uses for its buy and sell
 * sides; the stale state is `currentColor`, which is the window's foreground, as measured from
 * MetaQuotes' own light and dark renders of the same grid.
 */
export const QUOTE_TONE_COLOUR: Record<QuoteTone, string> = {
  up: '#3183ff',
  down: '#f23645',
  stale: 'currentColor',
};

/**
 * MetaTrader's three-state gutter glyph, left of the symbol in Market Watch.
 *
 * Read off `en/market_watch_x2.png` at 3x (docs/mt5/10-market-watch.md section 2.4): a thin green
 * arrow up, a thin red arrow down, or a grey filled dot where the price has not moved. MetaQuotes
 * documents none of it, which is why the colours are recorded as measured values rather than as
 * named tokens.
 *
 * Note the glyph's colours are NOT the quote's. The arrow is green and red; the price beside it is
 * blue and red. That is MetaTrader being inconsistent with itself, and copying it is the point.
 */
export type GutterGlyph = 'up' | 'down' | 'flat';

export const GUTTER_GLYPH: Record<GutterGlyph, string> = {
  up: '↗',
  down: '↘',
  flat: '•',
};

export const GUTTER_COLOUR: Record<GutterGlyph, string> = {
  up: '#00A91C',
  down: '#D83933',
  flat: '#A1A1A1',
};

/**
 * Which glyph a row shows.
 *
 * The grey dot covers every case that is not a live up or down tick: no quote yet, and a price that
 * has stopped moving. MetaTrader shows the dot on exactly those rows (XAUUSD and USDRUB in its own
 * screenshot, both stale by their Time column), so one state covers both here too.
 */
export function gutterGlyph(input: QuoteToneInput): GutterGlyph {
  const tone = quoteTone(input);
  return tone === 'up' ? 'up' : tone === 'down' ? 'down' : 'flat';
}

/**
 * The PHONE's corner triangle, which is a different marker on a different screen.
 *
 * The gutter glyph above belongs to the DESKTOP Market Watch grid, where it was sampled
 * (docs/mt5/10-market-watch.md section 2.4: a green arrow, a red arrow or a grey dot, left of the
 * Symbol column in a six-column table). MetaTrader's phone Quotes row is not that row narrowed; it
 * is a two-column, three-line row (docs/mt5/04-mobile-app.md section 2) and it carries **no
 * tick-direction glyph at all**. What sits in its top-left corner is this:
 *
 *   "a small filled triangle in the row's top-LEFT corner — blue (#1C5FE9 measured) = net floating
 *    profit, red = loss" (04-mobile-app.md 81)
 *
 * So the two are not alternatives and neither replaces the other. The phone shows the triangle; the
 * desktop shows the arrow. That the phone's marker is blue-and-red while the desktop's is
 * green-and-red is consistent on MetaTrader's own terms: its mobile palette rule (section 8) is
 * "Profit = blue, Loss = red" and reserves green for Take Profit, and the desktop grid's green arrow
 * is about the PRICE moving rather than about money.
 *
 * It states a different fact from either: not where the price went, but that this symbol is one the
 * trader is currently exposed on, and whether that exposure is up or down.
 */
export type PositionMark = 'profit' | 'loss';

export const POSITION_MARK_COLOUR: Record<PositionMark, string> = {
  // Measured off Android's Quotes screen (04-mobile-app.md 585).
  profit: '#1C5FE9',
  /**
   * NOT measured, and worth saying so: every published screenshot of the marker happens to show a
   * profitable position, so no loss triangle exists to sample. MetaQuotes' prose says only "red".
   * This is Android's own measured loss red from the Trade screen (04-mobile-app.md 581), which is
   * the nearest thing the reference actually contains — the same figure this marker summarises.
   */
  loss: '#BA0000',
};

/**
 * Which way the exposure is, from the net floating P/L of the positions on the symbol.
 *
 * Breaking even is not a loss, so zero is blue: MetaTrader has two states here and no third.
 */
export const positionMark = (floatingCents: number): PositionMark =>
  floatingCents < 0 ? 'loss' : 'profit';

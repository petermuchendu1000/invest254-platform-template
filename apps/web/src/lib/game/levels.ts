/**
 * Stop Loss and Take Profit as MetaTrader's advanced trading dialog holds them.
 *
 * ── How MetaTrader stores them, and why this copies it ───────────────────────────────────────────
 *
 * In POINTS, signed, measured from the reference price: "Last-used volume and SL/TP (stored in pips
 * and converted to price) are restored on the next order" (docs/mt5/04-mobile-app.md section 5b).
 * Storing the price instead would make a level restored on the next order meaningless, because the
 * price has moved; a distance survives.
 *
 * A point here is the instrument's own smallest quoted unit, `10^-digits`, which is what the Quotes
 * row's daily-change figure counts in too. MetaQuotes uses "points" and "pips" for this
 * interchangeably across its own pages and screenshots; one unit is used throughout rather than
 * copying that inconsistency.
 *
 * Sign convention: POSITIVE is above the reference price, negative below. So the buy-shaped pair
 * MetaTrader defaults to is `tp > 0, sl < 0`.
 *
 * ── What these levels do on THIS contract ────────────────────────────────────────────────────────
 *
 * They are inputs, and this module is only about the inputs. What the engine will act on is a
 * separate question, recorded here because it is the first thing anyone reading this file will want
 * to know, and it has two answers:
 *
 *   On a CONTINUOUS position — a brand with a price axis, pool mode off — the engine checks both
 *   levels on every tick, stop first, and closes the position at what it is worth at that price. So
 *   a stop is a real stop and can return part of the stake, and a target is a real target.
 *
 *   On a non-continuous one the outcome is committed at open, `set_levels` is refused
 *   ("LEVELS_UNSUPPORTED") and the contract runs to its horizon, so neither level fires.
 *
 * `isContinuousBrand` in lib/game/levelWatch.ts is the one place that tells the two apart, and the
 * surfaces say which they are on rather than drawing a working stop over an engine that will not
 * honour it. See docs/mt5/20-real-sl-tp.md.
 */

/** MetaTrader's three ways of expressing a level. Its segmented control shows Price and Pips; the
 *  help documents Currency as the third, "an approximate money amount". */
export type LevelUnit = 'price' | 'points' | 'currency';

export const LEVEL_UNITS: readonly { id: LevelUnit; label: string }[] = [
  { id: 'price', label: 'Price' },
  // MetaTrader's own label on the control is "Pips"; the unit is this instrument's point.
  { id: 'points', label: 'Pips' },
  { id: 'currency', label: 'Currency' },
];

/** Signed distances from the reference price, in points. Null is MetaTrader's "not set". */
export interface Levels {
  slPoints: number | null;
  tpPoints: number | null;
}

/**
 * The size of one point on this instrument: the tick, `10^-digits`.
 *
 * Written as a division rather than `10 ** -digits`, which is not the same number: the negative
 * exponent evaluates to 0.000009999999999999999 at five digits, and a point size a hair under the
 * tick drifts a level by a point every few thousand of them. `1 / 1e5` is the exact double.
 */
export const pointSize = (digits: number): number => 1 / 10 ** digits;

/** A signed point distance as a price on this instrument's own tick. */
export const priceOfPoints = (ref: number, points: number, digits: number): number =>
  Number((ref + points * pointSize(digits)).toFixed(digits));

/** A price back to a signed point distance, rounded to whole points. */
export const pointsOfPrice = (ref: number, price: number, digits: number): number =>
  Math.round((price - ref) * 10 ** digits);

/**
 * MetaTrader's default shape: "Levels default as for a buy (TP above price, SL below)."
 *
 * The distance is the caller's, because MetaTrader restores the last one used rather than inventing
 * a figure, and a first-ever order has nothing to restore.
 */
export const buyShaped = (distancePoints: number): Levels => ({
  slPoints: -Math.abs(distancePoints),
  tpPoints: Math.abs(distancePoints),
});

/**
 * "If you then tap Sell, the app swaps them automatically."
 *
 * A buy-shaped pair becomes sell-shaped and the other way round. A pair that is already right for
 * the side is left alone, so tapping the same side twice does not flip it back and forth.
 */
export function swapForSide(levels: Levels, side: 'buy' | 'sell'): Levels {
  const shape = shapeOf(levels);
  if (shape === null || shape === side) return levels;
  return {
    slPoints: levels.slPoints === null ? null : -levels.slPoints,
    tpPoints: levels.tpPoints === null ? null : -levels.tpPoints,
  };
}

/**
 * Which side a pair is shaped for, or null when it is neither.
 *
 * Buy: the target above the price and the stop below. Sell: the other way. A pair with both on the
 * same side is neither, which is the invalid state MetaTrader paints red.
 */
export function shapeOf({ slPoints, tpPoints }: Levels): 'buy' | 'sell' | null {
  const sl = slPoints ?? null;
  const tp = tpPoints ?? null;
  // One level set is enough to have a shape: MetaTrader lets a trader set only a stop, or only a
  // target, and the dialog still knows which way round it is.
  if (sl === null && tp === null) return null;
  if (sl !== null && sl === 0) return null;
  if (tp !== null && tp === 0) return null;
  const buyish = (sl === null || sl < 0) && (tp === null || tp > 0);
  const sellish = (sl === null || sl > 0) && (tp === null || tp < 0);
  return buyish ? 'buy' : sellish ? 'sell' : null;
}

/**
 * Which trade buttons stay live, which is MetaTrader's own rule and a surprising one:
 *
 *   "If you manually invert them, only the Sell button stays enabled and Buy is disabled, on the
 *    assumption you meant it."
 *
 * So a sell-shaped pair disables Buy rather than silently swapping back, while a buy-shaped pair
 * leaves both live because tapping Sell will swap them. A pair that is neither disables both:
 * "Invalid fields are highlighted in red and the trade buttons go inactive."
 */
export function sidesEnabled(levels: Levels): { buy: boolean; sell: boolean } {
  const shape = shapeOf(levels);
  if (shape === null) {
    // No levels at all is not invalid: it is an order with no stop and no target, which is the
    // ordinary case. Only a pair that contradicts itself disables both buttons.
    const none = levels.slPoints === null && levels.tpPoints === null;
    return { buy: none, sell: none };
  }
  return shape === 'buy' ? { buy: true, sell: true } : { buy: false, sell: true };
}

/**
 * MetaTrader's lock button: "fixes the TP:SL ratio — adjust one and the other follows, including
 * while dragging on the chart; the setting persists across orders."
 *
 * The ratio is taken from the pair as it stood BEFORE the edit, so moving the stop drags the target
 * by the same proportion rather than by the same number of points. With either level unset there is
 * no ratio to hold, and the other is left alone.
 */
export function applyRatioLock(
  before: Levels,
  after: Levels,
  edited: 'sl' | 'tp',
): Levels {
  const bSl = before.slPoints;
  const bTp = before.tpPoints;
  if (bSl === null || bTp === null || bSl === 0 || bTp === 0) return after;
  if (edited === 'sl') {
    const sl = after.slPoints;
    if (sl === null) return after;
    return { slPoints: sl, tpPoints: Math.round(bTp * (sl / bSl)) };
  }
  const tp = after.tpPoints;
  if (tp === null) return after;
  return { slPoints: Math.round(bSl * (tp / bTp)), tpPoints: tp };
}

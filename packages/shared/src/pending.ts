/**
 * MetaTrader's four pending order types, and the rules that decide which of them a click offers.
 *
 * A pending order is an instruction to open a position when the price reaches a level, rather than
 * now. The four differ in which side of the current price the level sits on and which way the
 * trader expects the market to go through it:
 *
 *   Buy Limit    buy BELOW the price   (the trader wants a dip to buy into)
 *   Sell Limit   sell ABOVE the price  (a rally to sell into)
 *   Buy Stop     buy ABOVE the price   (a breakout upward to join)
 *   Sell Stop    sell BELOW the price  (a breakdown to join)
 *
 * This module is the rules alone: which two a click offers, what the row says, and whether a
 * trigger has been reached. It is in the SHARED package because the same three questions are asked
 * by the chart's menu, by the engine that holds the order, and by the tick loop that fills it — and
 * three copies of "has it triggered?" is three chances to disagree about a trader's money. The
 * engine is the authority; the client asks the same function so the row it draws cannot promise a
 * fill the server would not make.
 *
 * MetaQuotes, verbatim, on the pair a click offers: *"Depending on the cursor position, available
 * order types are displayed in the menu. If the menu is activated above the current price, a user
 * can place Sell Limit and Buy Stop orders. If the menu is activated below the current price, Buy
 * Limit and Sell Stop orders can be placed."* (docs/mt5/08-chart-properties.md:527-533.)
 */

export type PendingKind = 'buyLimit' | 'sellLimit' | 'buyStop' | 'sellStop';

export const PENDING_KINDS: readonly PendingKind[] = ['buyLimit', 'sellLimit', 'buyStop', 'sellStop'];

/**
 * Is this one of the four?
 *
 * The socket carries whatever the client sent, so the kind has to be checked before it is trusted.
 * `pendingLevelValid` happens to refuse an unknown kind (its switch falls through), but relying on
 * that would mean an unknown type was reported as "invalid price", which is a wrong reason.
 */
export const isPendingKind = (x: unknown): x is PendingKind =>
  typeof x === 'string' && (PENDING_KINDS as readonly string[]).includes(x);

/** MetaTrader's own labels, with its own spacing and capitals. */
export const PENDING_LABELS: Readonly<Record<PendingKind, string>> = {
  buyLimit: 'Buy Limit',
  sellLimit: 'Sell Limit',
  buyStop: 'Buy Stop',
  sellStop: 'Sell Stop',
};

/** Which way the position opens when the order fills. */
export const pendingDirection = (kind: PendingKind): 'buy' | 'sell' =>
  kind === 'buyLimit' || kind === 'buyStop' ? 'buy' : 'sell';

/**
 * The two types a click at `clicked` offers, given the current price, in MetaTrader's own order:
 * its screenshot's top row is the FIRST of the pair, and its `Trading` submenu lists the pair in
 * the same order.
 *
 * A click exactly on the price offers the above-price pair, which is the side MetaTrader's own
 * screenshot shows and the only way to break the tie without inventing a rule.
 */
export const pendingKindsAt = (
  clicked: number,
  last: number,
): readonly [PendingKind, PendingKind] =>
  clicked >= last ? ['sellLimit', 'buyStop'] : ['buyLimit', 'sellStop'];

/**
 * The row MetaTrader prints: type, volume, then the level, e.g. `Sell Limit 1  219.306`.
 *
 * Two spaces before the price, which is what its screenshot shows and what separates the volume
 * from the level at a glance.
 */
export const pendingRowLabel = (
  kind: PendingKind,
  lots: string,
  price: number,
  digits: number,
): string => `${PENDING_LABELS[kind]} ${lots}  ${price.toFixed(digits)}`;

/**
 * Has this order's level been reached?
 *
 * The asymmetry is the whole of what distinguishes a limit from a stop, so it is stated once:
 *
 *   Buy Limit   fills when the price falls TO or below the level.
 *   Sell Stop   fills on the same test, because both want the market to come down to them.
 *   Sell Limit  fills when the price rises TO or above the level.
 *   Buy Stop    the same test, upward.
 *
 * Inclusive at the level, because a price that is exactly the level HAS reached it, and a trader
 * who set 3090 and watched the market print 3090 without filling would be right to call it a bug.
 */
export const pendingTriggered = (
  kind: PendingKind,
  trigger: number,
  price: number,
): boolean =>
  kind === 'buyLimit' || kind === 'sellStop' ? price <= trigger : price >= trigger;

/**
 * Is this level on the side its type requires, given where the market is now?
 *
 * MetaTrader refuses an order whose level is on the wrong side ("Invalid price"), because such an
 * order would fill the instant it was placed and is therefore a market order wearing the wrong
 * name. The caller reports the refusal; this says only whether it is one.
 */
export const pendingLevelValid = (
  kind: PendingKind,
  trigger: number,
  last: number,
): boolean => {
  if (!Number.isFinite(trigger) || !Number.isFinite(last)) return false;
  switch (kind) {
    case 'buyLimit':
    case 'sellStop':
      return trigger < last;
    case 'sellLimit':
    case 'buyStop':
      return trigger > last;
  }
};

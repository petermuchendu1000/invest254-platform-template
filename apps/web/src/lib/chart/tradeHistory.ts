/**
 * MetaTrader's `Trade History` on the chart: the deals that are already closed, drawn where they
 * happened.
 *
 * Its Show tab has carried the checkbox since that dialog was built, and its context menu row was
 * left out because nothing drew a picture behind it. This is that picture. MetaTrader marks each
 * deal with an arrow at its price and time, and joins a position's entry to its exit with a line,
 * so a trader scrolling back can see where they got in and out without reading the History tab.
 *
 * Pure, and separate from the chart, for the reason every other piece of this chart's arithmetic
 * is: the mapping from a closed position to a pair of marks is a rule worth pinning down, and it
 * cannot be checked through a canvas.
 *
 * ── On which deals are drawable ────────────────────────────────────────────────────────────────
 *
 * A position carries its entry and exit as RATES, and a rate becomes a price only through the day's
 * anchor. The chart holds one anchor: today's. A deal from an earlier trade date was priced against
 * a different one, and pricing it through today's would put it on the chart at a price it never
 * traded at. So a deal is drawn only when the caller can price it, and `tradeHistoryMarks` takes
 * the prices rather than the rates for exactly that reason: the decision about what can be priced
 * belongs to whoever holds the anchors, and this module will not guess.
 */

/** A closed position, as much of one as a mark needs. */
export interface ClosedDeal {
  id: string;
  direction: 'buy' | 'sell';
  openedAtMs: number;
  settledAtMs: number | null;
  /** Display prices, already mapped through the anchor the deal belongs to. Null when unpriceable. */
  entryPrice: number | null;
  exitPrice: number | null;
  /** Settled profit or loss, in cents, which decides the mark's colour. */
  pnlCents: number;
  /** MetaTrader's ticket, printed on the mark so it matches the History tab's row. */
  ticket: string;
}

export type MarkSide = 'entry' | 'exit';

export interface TradeMark {
  /** Chart time, in SECONDS, which is what lightweight-charts takes. */
  time: number;
  price: number;
  side: MarkSide;
  /** `aboveBar` for a sell entry and a buy exit; `belowBar` for the other two. */
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
  /** The deal this mark belongs to, so a pair can be joined and a click can find its row. */
  dealId: string;
}

/**
 * MetaTrader's colours for a closed deal: blue for a profit and red for a loss, the same pair the
 * whole terminal uses for money. The ENTRY mark is drawn in the direction's own colour instead,
 * because at the moment of entry there is no result yet to colour it by.
 */
export const DEAL_COLOURS = {
  buy: '#3183ff',
  sell: '#f23645',
  win: '#3183ff',
  loss: '#f23645',
} as const;

/**
 * Two marks per closed deal, oldest first.
 *
 * A deal with no exit price is still drawn at its entry: a position opened before midnight and
 * closed after it has an entry this chart can price and an exit it cannot, and showing where the
 * trader got in is better than showing nothing. A deal with neither is skipped entirely.
 */
export function tradeHistoryMarks(deals: readonly ClosedDeal[]): TradeMark[] {
  const out: TradeMark[] = [];
  for (const d of deals) {
    const won = d.pnlCents > 0;
    if (d.entryPrice !== null && Number.isFinite(d.entryPrice)) {
      out.push({
        time: Math.floor(d.openedAtMs / 1000),
        price: d.entryPrice,
        side: 'entry',
        // A buy opens from below the price and a sell from above it, which is the way MetaTrader
        // points its entry arrow: into the trade.
        position: d.direction === 'buy' ? 'belowBar' : 'aboveBar',
        shape: d.direction === 'buy' ? 'arrowUp' : 'arrowDown',
        color: DEAL_COLOURS[d.direction],
        text: `${d.direction} #${d.ticket}`,
        dealId: d.id,
      });
    }
    if (d.settledAtMs !== null && d.exitPrice !== null && Number.isFinite(d.exitPrice)) {
      out.push({
        time: Math.floor(d.settledAtMs / 1000),
        price: d.exitPrice,
        side: 'exit',
        // The exit points the opposite way: out of the trade.
        position: d.direction === 'buy' ? 'aboveBar' : 'belowBar',
        shape: d.direction === 'buy' ? 'arrowDown' : 'arrowUp',
        color: won ? DEAL_COLOURS.win : DEAL_COLOURS.loss,
        text: `#${d.ticket}`,
        dealId: d.id,
      });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * The line joining a deal's entry to its exit, which is the other half of what MetaTrader draws.
 *
 * Only for a deal that has both ends on this chart: a line to a point that could not be priced
 * would run off to nowhere.
 */
export interface TradeLine {
  dealId: string;
  from: { time: number; price: number };
  to: { time: number; price: number };
  /** Blue when the deal made money, red when it lost. */
  color: string;
}

export function tradeHistoryLines(deals: readonly ClosedDeal[]): TradeLine[] {
  const out: TradeLine[] = [];
  for (const d of deals) {
    if (d.entryPrice === null || d.exitPrice === null || d.settledAtMs === null) continue;
    if (!Number.isFinite(d.entryPrice) || !Number.isFinite(d.exitPrice)) continue;
    out.push({
      dealId: d.id,
      from: { time: Math.floor(d.openedAtMs / 1000), price: d.entryPrice },
      to: { time: Math.floor(d.settledAtMs / 1000), price: d.exitPrice },
      color: d.pnlCents > 0 ? DEAL_COLOURS.win : DEAL_COLOURS.loss,
    });
  }
  return out;
}

'use client';

/**
 * What a terminal calls a settled trade.
 *
 * The non-terminal shells call a settled position a TRADE: a tab labelled `Trades`, an empty state
 * reading `No trades yet`, an error reading `Couldn't load trade history.`, and a result column
 * reading `Won x1.95`. (It was `Bets` until the owner renamed it platform-wide: this is a trading
 * product, and the gambling word was doing it no favours. The DB value and the API's `bet`/`bets`
 * identifiers are untouched — they are wire and storage names, not words anyone reads.)
 *
 * MetaTrader has no such vocabulary. A trade that has finished is a CLOSED DEAL, and whether it
 * made money is told by the signed, coloured Profit figure beside it rather than by a word: that is
 * why MetaTrader's own Deals list has no "won" column.
 *
 * The classic and digits shells keep their own words, because they are not pretending to be
 * MetaTrader. This module is the one place the two vocabularies are written down together, so the
 * next surface that needs them does not invent a third.
 */

export interface DealOutcome {
  status: 'open' | 'settled' | string;
  result?: 'win' | 'loss' | string | null;
  /** Payout multiple on a win, for the classic shell's label. */
  multiplier?: number | null;
}

/**
 * The result column's label.
 *
 * On a terminal, `Closed` for anything settled: the P/L figure beside it is signed and coloured, so
 * a second word saying the same thing in a different vocabulary would be noise. MetaTrader uses
 * `Cancelled` where this platform says `Void`.
 */
export function dealResultLabel(p: DealOutcome, terminal: boolean): string {
  if (p.status === 'open') return 'Open';
  if (!terminal) {
    if (p.result === 'win') return `Won ×${(p.multiplier ?? 1).toFixed(2)}`;
    if (p.result === 'loss') return 'Lost';
    return 'Void';
  }
  return p.result === 'win' || p.result === 'loss' ? 'Closed' : 'Cancelled';
}

/** The tab a trade list sits behind. MetaTrader's History tab is headed `Deals`. */
export const dealsTabLabel = (terminal: boolean): string => (terminal ? 'Deals' : 'Trades');

/** Empty and error states, in whichever vocabulary the shell speaks. */
export function dealListCopy(terminal: boolean): {
  emptyTitle: string;
  emptyBody: string;
  loadError: string;
} {
  return terminal
    ? {
      emptyTitle: 'No deals yet',
      emptyBody: 'Positions you have closed will appear here.',
      loadError: 'Couldn’t load your trade history.',
    }
    : {
      emptyTitle: 'No trades yet',
      emptyBody: 'Your placed positions will show up here.',
      loadError: 'Couldn’t load trade history.',
    };
}

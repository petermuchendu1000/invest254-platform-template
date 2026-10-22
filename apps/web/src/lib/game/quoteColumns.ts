'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Which columns the Market Watch Symbols grid draws.
 *
 * MetaTrader's documented set is `Symbol | Bid | Ask | Spread | Time | Daily Change`
 * (docs/mt5/10-market-watch.md 25), and its context menu's `Columns ▸` submenu switches the
 * optional ones on and off. `Symbol` is not among them: every grid has it, and MetaTrader offers no
 * way to hide it.
 *
 * The set is per device, like the symbol list, the panel height and the chart's indicators: it is a
 * window preference, not an account setting, and nothing the broker needs to know.
 *
 * Bid and Ask became real columns here once the engine began publishing the brand's spread. Before
 * that this grid printed one `Last` price, with a comment explaining that two prices around a
 * non-existent spread would be a lie; the spread exists and is charged on every position, so the
 * two sides are now the honest rendering and the single price is the one that would mislead.
 */

export type QuoteColumn = 'bid' | 'ask' | 'spread' | 'time' | 'change';

export const QUOTE_COLUMNS: ReadonlyArray<{ id: QuoteColumn; label: string }> = [
  { id: 'bid', label: 'Bid' },
  { id: 'ask', label: 'Ask' },
  { id: 'spread', label: 'Spread' },
  { id: 'time', label: 'Time' },
  { id: 'change', label: 'Daily Change' },
];

/** MetaTrader's own default: every documented column shown. */
const DEFAULT_ON: readonly QuoteColumn[] = ['bid', 'ask', 'spread', 'time', 'change'];

interface QuoteColumnsState {
  on: readonly QuoteColumn[];
  toggle: (id: QuoteColumn) => void;
  /** Restore after mount, so the server render and the first client render agree. */
  restore: () => void;
}

const STORAGE_KEY = 'pp-quote-columns';

const isColumn = (x: unknown): x is QuoteColumn =>
  typeof x === 'string' && QUOTE_COLUMNS.some((c) => c.id === x);

export const useQuoteColumnsStore = create<QuoteColumnsState>()((set, get) => ({
  on: DEFAULT_ON,
  toggle: (id) => {
    const cur = get().on;
    // Kept in MetaTrader's own order however they are switched, so the grid never reorders itself.
    const next = cur.includes(id)
      ? cur.filter((c) => c !== id)
      : QUOTE_COLUMNS.filter((c) => c.id === id || cur.includes(c.id)).map((c) => c.id);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { /* blocked storage: the choice still holds for this session */ }
    set({ on: next });
  },
  restore: () => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as unknown;
      // An empty stored set is a real choice (every column off), so it is honoured; a corrupt one
      // is not, and falls back to MetaTrader's default rather than blanking the grid.
      if (Array.isArray(parsed) && parsed.every(isColumn)) set({ on: parsed as QuoteColumn[] });
    } catch { /* private mode / corrupt value */ }
  },
}));

export function useRestoreQuoteColumns(): void {
  const restore = useQuoteColumnsStore((s) => s.restore);
  useEffect(() => { restore(); }, [restore]);
}

/**
 * The spread between two sides, in the symbol's own POINTS, which is the unit MetaTrader's Spread
 * column uses: its EURUSD row reads `0`, not `0.00001`.
 *
 * Each side is rounded to the symbol's digits BEFORE the subtraction, deliberately. The grid prints
 * both sides rounded, so differencing the raw values can put a `58` in the Spread column beside two
 * prices 0.57 apart; a trader reading the row would be right to call that a bug. Rounding first
 * makes the column exactly the gap between the two numbers on screen.
 */
export const spreadPoints = (
  bid: number | null,
  ask: number | null,
  digits: number,
): number | null => {
  if (bid === null || ask === null) return null;
  const unit = 10 ** digits;
  return Math.round(ask * unit) - Math.round(bid * unit);
};

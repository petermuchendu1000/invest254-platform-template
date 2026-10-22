'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * MetaTrader Android's Quotes view mode.
 *
 * "In the simple view mode only the Bid and Ask prices are shown" — the row loses its daily change,
 * its time, its spread and its High/Low, leaving the symbol on the left and the prices on the
 * right. Advanced is the full three-line row. It is toggled from Settings and from the row's own
 * context menu item "Advanced view mode" (docs/mt5/04-mobile-app.md section 2).
 *
 * iOS has no such toggle; its equivalent switches between a mobile row and a desktop-style table.
 * This shell follows Android, as the rest of its phone chrome does.
 */
export type QuotesView = 'advanced' | 'simple';

interface QuotesViewState {
  view: QuotesView;
  toggle: () => void;
}

const STORAGE_KEY = 'pp-quotes-view';

export const useQuotesViewStore = create<QuotesViewState>()((set, get) => ({
  // MetaTrader's own default is the advanced row: its Quotes screenshots show it, and the simple
  // one is the reduced mode a trader opts into.
  view: 'advanced',
  toggle: () => {
    const view: QuotesView = get().view === 'advanced' ? 'simple' : 'advanced';
    try { window.localStorage.setItem(STORAGE_KEY, view); }
    catch { /* blocked storage: the mode still holds for this session */ }
    set({ view });
  },
}));

/** Restored after mount: a store seeded from storage during the server render is a mismatch. */
export function useRestoreQuotesView(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'simple' || raw === 'advanced') useQuotesViewStore.setState({ view: raw });
    } catch { /* ignore */ }
  }, []);
}

'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Which of MetaTrader's five mobile tabs is showing.
 *
 * Both of MetaQuotes' mobile builds have exactly five, and the fifth differs: iOS ends with
 * Settings, Android with Messages (docs/mt5/04-mobile-app.md section 1). Android's set is the one
 * here, because this shell also has the drawer that only Android has, and on Android Settings lives
 * in that drawer rather than in the bar.
 *
 * The label of the second tab differs too: iOS "Chart", Android "Charts". Android's again.
 *
 * It is in-app state rather than a route because MetaTrader's tabs are: switching tab does not
 * change what a share link points at, and the chart must not unmount and refetch its history every
 * time the trader looks at their positions.
 */
export type MobileTab = 'quotes' | 'charts' | 'trade' | 'history' | 'messages';

export const MOBILE_TABS: readonly { id: MobileTab; label: string }[] = [
  { id: 'quotes', label: 'Quotes' },
  { id: 'charts', label: 'Charts' },
  { id: 'trade', label: 'Trade' },
  { id: 'history', label: 'History' },
  { id: 'messages', label: 'Messages' },
];

interface MobileTabState {
  tab: MobileTab;
  set: (tab: MobileTab) => void;
}

const STORAGE_KEY = 'pp-mobile-tab';

/**
 * Charts, not Quotes.
 *
 * MetaTrader opens on whichever tab it was last on, and on a fresh install that is Quotes. This one
 * opens on Charts because the chart is what this product is: a trader arriving from a link has come
 * to see the price, and a list of symbols would be a step in the way.
 */
export const useMobileTabStore = create<MobileTabState>()((set) => ({
  tab: 'charts',
  set: (tab) => {
    try { window.localStorage.setItem(STORAGE_KEY, tab); }
    catch { /* blocked storage: the tab still works for this session */ }
    set({ tab });
  },
}));

const isTab = (v: string | null): v is MobileTab =>
  v !== null && MOBILE_TABS.some((t) => t.id === v);

/**
 * Restore the last tab once the client has mounted, for the same reason every other preference here
 * restores that way: the store's initialiser also runs during the server render, where there is no
 * localStorage, and a store seeded differently on the two sides is a hydration mismatch.
 */
export function useRestoreMobileTab(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (isTab(raw)) useMobileTabStore.setState({ tab: raw });
    } catch { /* ignore */ }
  }, []);
}

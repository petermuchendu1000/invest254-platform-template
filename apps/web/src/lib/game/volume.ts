'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The order volume, in lots, shared by every surface that can place one.
 *
 * MetaTrader keeps one volume for the symbol: set it on the chart's one-click panel and the trading
 * dialog opens on that volume, because they are the same order seen twice. This store is what makes
 * that true here. Held per-hook it was not: the phone's one-click panel and the New Order ticket
 * each had their own `useState`, so a trader who stepped the panel to 0.10 and tapped BUY got a
 * ticket still showing the brand's minimum. The stake they had chosen was simply dropped.
 *
 * `null` means "not chosen yet", which is not the same as zero: the first surface to learn the
 * brand's limits seeds it with the minimum, and until then there is no volume to print.
 *
 * It is remembered across sessions, as MetaTrader remembers the last volume used. The value is
 * re-clamped to the brand's current limits wherever it is read, so a stored volume cannot survive
 * the brand lowering its ceiling.
 */
interface VolumeState {
  lots: number | null;
  set: (lots: number) => void;
}

const STORAGE_KEY = 'pp-order-lots';

export const useVolumeStore = create<VolumeState>()((set) => ({
  lots: null,
  set: (lots) => {
    try { window.localStorage.setItem(STORAGE_KEY, String(lots)); }
    catch { /* blocked storage: the volume still holds for this session */ }
    set({ lots });
  },
}));

/** Restored after mount: a store seeded from storage during the server render is a mismatch. */
export function useRestoreVolume(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) useVolumeStore.setState({ lots: n });
    } catch { /* ignore */ }
  }, []);
}

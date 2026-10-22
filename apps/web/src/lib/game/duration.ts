'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The contract term, in seconds, shared by every surface that can place an order.
 *
 * Same rule and same reason as the volume store beside it: MetaTrader keeps ONE set of order terms,
 * so a term chosen on one surface is the term the next one opens on. Held as a `useState` inside
 * `useOrderEntry` it was not — the desktop ticket, the phone's New Order screen and the chart's
 * one-click panel each had their own, so a trader who set 2m on the ticket and then armed an order
 * from the chart got the brand's default instead, silently.
 *
 * That matters more now that the chart's context menu can place a PENDING order: the row it draws
 * states a volume and a level, and the term behind it has to be the one the trader set rather than
 * whatever the surface happened to default to.
 *
 * `null` means "not chosen yet", which is not zero: the first surface to learn the brand's
 * configuration seeds it with that brand's default term. Remembered across sessions, as MetaTrader
 * remembers the last order it placed, and re-checked against the brand's offered terms wherever it
 * is read, so a stored term cannot survive the brand dropping it.
 */
interface DurationState {
  durationS: number | null;
  set: (durationS: number) => void;
}

const STORAGE_KEY = 'pp-order-duration';

export const useDurationStore = create<DurationState>()((set) => ({
  durationS: null,
  set: (durationS) => {
    try { window.localStorage.setItem(STORAGE_KEY, String(durationS)); }
    catch { /* blocked storage: the term still holds for this session */ }
    set({ durationS });
  },
}));

/** Restored after mount: a store seeded from storage during the server render is a mismatch. */
export function useRestoreDuration(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) useDurationStore.setState({ durationS: n });
    } catch { /* ignore */ }
  }, []);
}

/**
 * The term to use, given what the brand offers.
 *
 * A stored term the brand no longer offers falls back to its default, which is the same clamp the
 * volume store documents: a remembered figure must never outlive the configuration it was valid in.
 */
export function effectiveDuration(
  stored: number | null,
  offered: readonly number[],
  fallback: number,
): number {
  if (stored !== null && offered.includes(stored)) return stored;
  return fallback;
}

'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import type { Levels } from '@/lib/game/levels';

/**
 * The Stop Loss and Take Profit levels, and the ratio lock, remembered between orders.
 *
 * Both are MetaTrader's own behaviour: "Last-used volume and SL/TP (stored in pips and converted to
 * price) are restored on the next order. Only the most recent values are kept, NOT per symbol", and
 * of the lock: "the setting persists across orders".
 *
 * Not per symbol, deliberately, because MetaTrader's is not. Levels are held in POINTS for the same
 * reason MetaTrader holds them in pips: a price restored onto the next order would be meaningless
 * once the price has moved, and a distance survives.
 */
interface LevelsState {
  levels: Levels;
  /**
   * The price the stored distances are measured FROM, so a level stays where it was put.
   *
   * Points alone are not a level. Rendered against whatever the price happens to be at the moment
   * of the read, a stop placed 100 points below the market crawls down with the market and never
   * sits anywhere; the chart and the ticket also disagreed, because each sampled the live price a
   * fraction of a second apart and got a different absolute price from the same distance.
   *
   * MetaTrader stores pips for one job only: restoring a level onto the NEXT order, where the old
   * price is long gone. A level on the ticket in front of you is a PRICE and stays put. Holding the
   * reference gives both: the absolute level is `ref + points`, stable while the ticket is open,
   * and the distance is what survives to the next order.
   *
   * Null before any level has been set, and re-based to the live price when levels are restored
   * into a new session, which is exactly MetaTrader's "stored in pips and converted to price".
   */
  ref: number | null;
  locked: boolean;
  set: (levels: Levels, ref?: number | null) => void;
  setLocked: (locked: boolean) => void;
}

const LEVELS_KEY = 'pp-order-levels';
const LOCK_KEY = 'pp-order-levels-locked';

export const useLevelsStore = create<LevelsState>()((set, get) => ({
  levels: { slPoints: null, tpPoints: null },
  ref: null,
  locked: false,
  set: (levels, ref) => {
    try { window.localStorage.setItem(LEVELS_KEY, JSON.stringify(levels)); }
    catch { /* blocked storage: the levels still hold for this session */ }
    // The reference is adopted on the first set and then held: a later edit moves the level
    // relative to where the pair was anchored, not relative to wherever the price has got to.
    const next = get().ref ?? (ref ?? null);
    set({ levels, ref: levels.slPoints === null && levels.tpPoints === null ? null : next });
  },
  setLocked: (locked) => {
    try { window.localStorage.setItem(LOCK_KEY, locked ? '1' : '0'); }
    catch { /* ignore */ }
    set({ locked });
  },
}));

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Whether storage has already been read, for this page load.
 *
 * ONCE, not once per caller. The restore deliberately clears the anchor so the first surface to
 * render a restored pair re-bases it on the live price, which is right exactly once; a second
 * caller running the same effect later throws away an anchor that a dragged or stepped level is
 * being measured from, and the level jumps to a different price. That is what happened: the order
 * dialog restored on every open, so reopening it moved a stop the trader had just placed on the
 * chart, and the two surfaces then disagreed about the same level.
 */
let restored = false;

/** Restored after mount: a store seeded from storage during the server render is a mismatch. */
export function useRestoreLevels(): void {
  useEffect(() => {
    if (restored) return;
    restored = true;
    try {
      const raw = window.localStorage.getItem(LEVELS_KEY);
      if (raw !== null) {
        const p: unknown = JSON.parse(raw);
        if (p !== null && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          /**
           * Restored WITHOUT a reference, so the first surface to render them re-bases the pair on
           * the live price. That is MetaTrader's own behaviour for a restored level: the distance
           * is what it keeps, "converted to price" against the market it is coming back to.
           */
          useLevelsStore.setState({
            levels: { slPoints: finiteOrNull(o.slPoints), tpPoints: finiteOrNull(o.tpPoints) },
            ref: null,
          });
        }
      }
      const lock = window.localStorage.getItem(LOCK_KEY);
      if (lock !== null) useLevelsStore.setState({ locked: lock === '1' });
    } catch { /* corrupt value: no levels is a fine default */ }
  }, []);
}

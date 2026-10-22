'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { TIMEFRAME_KEYS, isTimeframe, type Timeframe } from '@invest254/shared/candles';

/**
 * MetaTrader mobile's timeframe picker: a quick strip of up to nine, and a grouped sheet of all 21.
 *
 * From docs/mt5/04-mobile-app.md section 3, verified against `android/en/chart_period.png`:
 *
 *   "tapping the timeframe button opens a horizontal quick strip across the top — e.g.
 *    `M1 M5 M15 M30 H1 H4 D1 W1 [⚙]` — with the current one highlighted in solid blue and a gear at
 *    the right end = 'Set up timeframes'. The gear opens the full grouped bottom sheet ... long-press
 *    adds/hides a timeframe from the quick strip ... Maximum 9 timeframes on the quick strip."
 *
 * The groups and their membership are MetaTrader's own, and they add to 21:
 *   Minutes  M1 M2 M3 M4 M5 M6 M10 M12 M15 M20 M30   (11)
 *   Hours    H1 H2 H3 H4 H6 H8 H12                    (7)
 *   Days     D1 W1 MN                                 (3)
 *
 * MetaTrader's third group is labelled with `MN`; this codebase's period key is `MN1`, which is the
 * key MQL5 itself uses (`PERIOD_MN1`). The key stays `MN1` and the BUTTON prints `MN`, so the strip
 * reads the way the phone's does without inventing a second period identifier.
 */
export const MOBILE_TF_GROUPS: readonly { label: string; items: readonly Timeframe[] }[] = [
  { label: 'Minutes', items: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30'] },
  { label: 'Hours', items: ['H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12'] },
  { label: 'Days', items: ['D1', 'W1', 'MN1'] },
];

/** What a period button prints. Only MN1 differs from its key, and MetaTrader's own strip says MN. */
export const mobileTfLabel = (tf: Timeframe): string => (tf === 'MN1' ? 'MN' : tf);

/** MetaTrader's documented ceiling for the quick strip. */
export const MAX_QUICK_TF = 9;

/** The strip in MetaQuotes' own example, which is what a fresh install shows. */
export const DEFAULT_QUICK_TF: readonly Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

interface QuickTfState {
  quick: readonly Timeframe[];
  /** Long-press on the sheet: add it to the strip, or take it off. */
  toggle: (tf: Timeframe) => void;
  reset: () => void;
}

const STORAGE_KEY = 'pp-quick-timeframes';

/**
 * The strip is kept in MetaTrader's own period order rather than in the order the trader tapped
 * them, because that is how its own strip reads: `M1 M5 M15 M30 H1 H4 D1 W1` is ascending, and a
 * strip that put H4 before M5 because of the order of two long-presses would be unreadable.
 */
const inPeriodOrder = (set: Iterable<Timeframe>): Timeframe[] => {
  const want = new Set(set);
  return TIMEFRAME_KEYS.filter((k) => want.has(k));
};

const persist = (quick: readonly Timeframe[]): void => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(quick)); }
  catch { /* blocked storage: the strip still holds for this session */ }
};

export const useQuickTfStore = create<QuickTfState>()((set, get) => ({
  quick: DEFAULT_QUICK_TF,
  toggle: (tf) => {
    const have = get().quick;
    const next = have.includes(tf)
      // Never empty: a strip with nothing on it would leave the gear as the only way to change
      // period, which is not a state MetaTrader's own strip can be in.
      ? (have.length > 1 ? inPeriodOrder(have.filter((k) => k !== tf)) : have)
      // At the ceiling the long-press does nothing, as MetaTrader's does.
      : (have.length >= MAX_QUICK_TF ? have : inPeriodOrder([...have, tf]));
    persist(next);
    set({ quick: next });
  },
  reset: () => { persist(DEFAULT_QUICK_TF); set({ quick: DEFAULT_QUICK_TF }); },
}));

/** Restored after mount: a store seeded from storage during the server render is a mismatch. */
export function useRestoreQuickTf(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const kept = inPeriodOrder(parsed.filter((v): v is Timeframe => typeof v === 'string' && isTimeframe(v)))
        .slice(0, MAX_QUICK_TF);
      if (kept.length > 0) useQuickTfStore.setState({ quick: kept });
    } catch { /* corrupt value: the default strip is a fine fallback */ }
  }, []);
}

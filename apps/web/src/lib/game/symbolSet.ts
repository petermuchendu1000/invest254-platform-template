'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The trader's Market Watch list, which in MetaTrader is a SET the trader curates rather than the
 * broker's whole catalogue.
 *
 * MetaQuotes is explicit that the window "shows the symbols selected by the trader" and that the
 * Symbols dialog (Ctrl+U) is where they are added and removed, with Hide, Hide All and Show All on
 * the context menu. A broker's catalogue runs to hundreds of instruments; the window shows a dozen.
 * So the list is a stored preference, not a server fact, and this is where it lives.
 *
 * It holds symbol NAMES only. What each symbol is comes from the engine's `symbols` reply, and the
 * two are deliberately separate: a stored list that outlives a catalogue change must not resurrect
 * an instrument the brand has stopped offering, so every read is filtered against what the brand
 * currently says it has.
 */

/**
 * The list a trader starts with: the seven majors and gold.
 *
 * MetaTrader brokers open a fresh terminal on a short default set rather than on nothing, and the
 * majors are the conventional one. Gold is included because it is this platform's own default
 * symbol, so the list always contains the instrument the chart is already on.
 */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
];

interface SymbolSetState {
  /** Symbol names, in the order the window lists them. */
  watched: readonly string[];
  /** Whether the stored list has been read back yet (see `useRestoreSymbolSet`). */
  restored: boolean;
  /** Add a symbol to the end of the list, as MetaTrader's Symbols dialog does. */
  show: (symbol: string) => void;
  /** MetaTrader's `Hide` (Delete). */
  hide: (symbol: string) => void;
  /** MetaTrader's `Show All` — but bounded, because a cap applies (see `MAX_WATCHED`). */
  showAll: (symbols: readonly string[]) => void;
  /** MetaTrader's `Hide All`, which leaves the symbols with open positions. We have none, so it empties. */
  hideAll: () => void;
  /** MetaTrader's `Sort`, which sorts the window alphabetically. */
  sort: () => void;
  /** Replace the whole list, for the Symbols dialog's apply. */
  replace: (symbols: readonly string[]) => void;
}

/**
 * The cap, which must match the engine's `MAX_WATCHED_SYMBOLS`.
 *
 * It is not a display limit: the engine holds a bounded number of per-symbol price chains resident
 * and quotes only the ones that are warm, so a longer list would simply contain rows that never
 * quote. Enforcing it here means the trader is stopped at the point of asking rather than left with
 * silent rows.
 */
export const MAX_WATCHED = 20;

/**
 * The set of symbols to ask the engine to quote: the charted one, then the watch list, deduplicated
 * and capped.
 *
 * The chart's symbol goes first so that when the union exceeds the cap it is the tail of the watch
 * list that is dropped rather than the instrument on screen. Pulled out of the hook because the
 * ordering rule is the whole substance of it, and a rule worth stating is worth testing.
 */
export function quoteSubscription(
  charted: string | null,
  watched: readonly string[],
  cap: number = MAX_WATCHED,
): string[] {
  const out: string[] = [];
  for (const s of [...(charted === null ? [] : [charted]), ...watched]) {
    if (s && !out.includes(s) && out.length < cap) out.push(s);
  }
  return out;
}

const STORAGE_KEY = 'pp-market-watch';

const persist = (watched: readonly string[]): void => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(watched)); }
  catch { /* blocked storage: the list still works for this session */ }
};

const dedupe = (symbols: readonly string[]): string[] => {
  const out: string[] = [];
  for (const s of symbols) if (s && !out.includes(s) && out.length < MAX_WATCHED) out.push(s);
  return out;
};

export const useSymbolSetStore = create<SymbolSetState>()((set, get) => {
  const commit = (watched: readonly string[]) => {
    const next = dedupe(watched);
    persist(next);
    set({ watched: next });
  };
  return {
    watched: DEFAULT_WATCHLIST,
    restored: false,
    show: (symbol) => commit([...get().watched, symbol]),
    hide: (symbol) => commit(get().watched.filter((s) => s !== symbol)),
    showAll: (symbols) => commit(symbols),
    hideAll: () => commit([]),
    sort: () => commit([...get().watched].sort((a, b) => a.localeCompare(b))),
    replace: (symbols) => commit(symbols),
  };
});

/**
 * Read the stored list back once the client has mounted.
 *
 * Not in the store's initialiser: that runs during the server render too, where there is no
 * localStorage, and a store seeded differently on the two sides is a hydration mismatch. The same
 * reason `levelsStore` restores this way.
 *
 * An EMPTY stored list is respected rather than replaced with the default. `Hide All` is a thing a
 * trader can choose, and reviving eight symbols on the next reload would make it look broken.
 */
export function useRestoreSymbolSet(): void {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) { useSymbolSetStore.setState({ restored: true }); return; }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) { useSymbolSetStore.setState({ restored: true }); return; }
      const names = dedupe(parsed.filter((x): x is string => typeof x === 'string'));
      useSymbolSetStore.setState({ watched: names, restored: true });
    } catch { useSymbolSetStore.setState({ restored: true }); }
  }, []);
}

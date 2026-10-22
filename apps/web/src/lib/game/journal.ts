'use client';

import { useSyncExternalStore } from 'react';

/**
 * Terminal logs — the real content behind MetaTrader's Journal and Experts tabs.
 *
 * MetaQuotes documents the two as one subsystem with two streams, and splits them by what wrote the
 * line: the Journal records what the TERMINAL did (connecting, authorising, sending an order, the
 * server's answer, errors), and the Experts journal records what the PROGRAMS running on the chart
 * did — "information about the running indicators and Expert Advisor, including opening/closing of
 * positions, modification of orders, Expert Advisor alerts and comments" (docs/mt5/09-toolbox.md
 * 7.7). This platform runs no Expert Advisors, but it does run indicators and it does fire alerts,
 * and those are exactly the events that stream names.
 *
 * Every line in either is an event that genuinely happened on this session; nothing is synthesised
 * to fill a tab.
 *
 * They live outside React on purpose. These events arrive on the socket, often several a second
 * during a round, and routing each through component state would re-render the trade screen for a
 * log that is usually not even on screen. Components subscribe through `useJournal` / `useExperts`,
 * which read a snapshot and only re-render when the buffer actually changes.
 *
 * Each buffer is per session and per tab: neither is persisted, because a log that survived a
 * reload would describe a terminal that is no longer running.
 */

export type JournalLevel = 'info' | 'ok' | 'warn' | 'error';

export interface JournalEntry {
  id: number;
  atMs: number;
  level: JournalLevel;
  /** Short source tag, as MT5 prints one ('Network', 'Trade', 'Chart'). */
  tag: string;
  text: string;
}

/** Ring size. Deep enough to cover a long session, bounded so a tab left open cannot grow forever. */
const MAX_ENTRIES = 500;

/** Server snapshot: the logs are client-only, so SSR renders them empty. */
const EMPTY: JournalEntry[] = [];

interface Log {
  log: (level: JournalLevel, tag: string, text: string) => void;
  get: () => JournalEntry[];
  subscribe: (cb: () => void) => () => void;
  use: () => JournalEntry[];
  reset: () => void;
}

/**
 * One independent buffer. Two of these exist because MetaTrader shows two logs, and a single buffer
 * with a filter would be the wrong shape: a line written to the Experts journal is not a Journal
 * line that happens to be tagged, and the two counts, the two clears and the two ring limits are
 * separate in MetaTrader as well.
 */
function createLog(): Log {
  let seq = 0;
  let entries: JournalEntry[] = [];
  const subscribers = new Set<() => void>();

  const notify = (): void => { for (const cb of subscribers) cb(); };

  return {
    log(level, tag, text) {
      const entry: JournalEntry = { id: ++seq, atMs: Date.now(), level, tag, text };
      // A new array each time so `useSyncExternalStore` sees a changed snapshot; mutating in place
      // would leave subscribers rendering stale content.
      entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
      notify();
    },
    get: () => entries,
    subscribe(cb) {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },
    use() {
      return useSyncExternalStore(this.subscribe, this.get, () => EMPTY);
    },
    reset() {
      entries = [];
      seq = 0;
      notify();
    },
  };
}

const platform = createLog();
const experts = createLog();

/** Record a terminal event. Safe to call from anywhere, including outside React. */
export const logJournal = platform.log;
export const getJournal = platform.get;
export const subscribeJournal = platform.subscribe;
export const useJournal = (): JournalEntry[] => platform.use();
/** Test seam: drop everything and reset the counter. */
export const resetJournal = platform.reset;

/**
 * Record an Experts-journal event: something a program ON THE CHART did.
 *
 * The tag is the program's own name, as MetaTrader's Source column carries it — an indicator's
 * name, or `Alert` for a fired price alert. Terminal plumbing does not belong here; that is the
 * Journal's stream.
 */
export const logExperts = experts.log;
export const getExperts = experts.get;
export const subscribeExperts = experts.subscribe;
export const useExperts = (): JournalEntry[] => experts.use();
export const resetExperts = experts.reset;

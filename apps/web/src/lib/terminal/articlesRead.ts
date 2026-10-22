'use client';

import { useSyncExternalStore } from 'react';
import { ARTICLES } from './articles.js';

/**
 * Which articles this device has read.
 *
 * MetaTrader puts an unread count on the Articles tab itself — `Articles₇` on its own screenshot
 * (docs/mt5/09-toolbox.md 955) — so the tab has to know what has been opened. That is a per-device
 * fact, like the chart's indicators or the panel's height, so it lives in localStorage rather than
 * on the account: reading an article is not something the broker needs to record.
 *
 * Outside React, and for the same reason the journal is: the count is read by the tab strip on
 * every render of the Toolbox, and the reading pane writes to it while the grid behind it is
 * mounted. Both have to see the same value without one owning it.
 */

const STORAGE_KEY = 'pp-articles-read';

let read: ReadonlySet<string> = new Set<string>();
const subscribers = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set<string>();
let restored = false;

const KNOWN = new Set(ARTICLES.map((a) => a.id));

/**
 * Lazily, from the first subscription: this module is imported during SSR, where there is no
 * `window`, and a value restored during render rather than after mount would be a hydration
 * mismatch. `useSyncExternalStore` re-reads the snapshot after subscribing, so the count appears on
 * the first paint after mount.
 */
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return;
    // Retired ids are dropped: an article removed from the library would otherwise be remembered as
    // read forever, and the stored list would grow without bound across deployments.
    read = new Set(ids.filter((x): x is string => typeof x === 'string' && KNOWN.has(x)));
  } catch { /* private mode / corrupt value — everything unread is a fine default */ }
}

export function markArticleRead(id: string): void {
  if (!KNOWN.has(id) || read.has(id)) return;
  const next = new Set(read);
  next.add(id);
  read = next;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* blocked storage */ }
  for (const cb of subscribers) cb();
}

export function getReadArticles(): ReadonlySet<string> {
  return read;
}

function subscribe(cb: () => void): () => void {
  restore();
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

export function useReadArticles(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getReadArticles, () => EMPTY);
}

/** Test seam. */
export function resetReadArticles(): void {
  read = new Set<string>();
  restored = true;
  for (const cb of subscribers) cb();
}

'use client';

/**
 * The light/dark choice, applied the one way.
 *
 * There were two implementations of this control and they disagreed. The settings screen toggled
 * both `light` and `dark`; the auth modal's sun/moon toggled only `light`, so one click left
 * `<html class="dark light">` with both palettes claiming the element and whichever rule came last
 * in the stylesheet winning. The pre-paint script in app/layout sets both, so a reload "fixed" it
 * and the next click broke it again.
 *
 * It is one function now, and it is the only writer.
 */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'pp-theme';

/** What is stored, or null when the trader has never chosen and the brand's default stands. */
export function storedTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch { return null; }
}

/** What is on screen right now, read from the element the stylesheet selects on. */
export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

/** Apply and remember a choice. Both classes, always, so the two can never both be set. */
export function applyTheme(next: Theme): void {
  const el = document.documentElement;
  el.classList.remove('light', 'dark');
  el.classList.add(next);
  try { window.localStorage.setItem(THEME_STORAGE_KEY, next); }
  catch { /* blocked storage: the choice still holds for this session */ }
}

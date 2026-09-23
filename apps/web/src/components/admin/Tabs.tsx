'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * UI-C: ONE tab style for page sections (underline tabs, the Polaris/Stripe pattern), replacing three
 * different ones (a full-width mint segmented control, pills and underline tabs). Scrolls sideways on a
 * phone instead of overflowing the page, and is keyboard-operable (←/→, Home/End) with ARIA tab roles.
 */
export interface TabDef<T extends string> { id: T; label: string; hint?: string }

export function PageTabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: ReadonlyArray<TabDef<T>>; value: T; onChange: (id: T) => void; label: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const idx = Math.max(0, tabs.findIndex((t) => t.id === value));
  function onKey(e: React.KeyboardEvent) {
    const n = tabs.length;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % n;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  }
  React.useEffect(() => { refs.current[idx]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [idx]);
  return (
    <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="flex min-w-max gap-1 border-b border-border">
        {tabs.map((t, i) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={t.hint}
              onClick={() => onChange(t.id)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
                on ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tab state kept in the URL (?tab=…) so a tab can be linked, bookmarked and survives a reload
 * (the brand page's tabs used to reset to the first one). Unknown values fall back to the default.
 */
export function useTabParam<T extends string>(ids: ReadonlyArray<T>, fallback: T, key = 'tab'): [T, (t: T) => void] {
  const [tab, setTab] = React.useState<T>(fallback);
  React.useEffect(() => {
    const v = new URLSearchParams(window.location.search).get(key);
    if (v && (ids as ReadonlyArray<string>).includes(v)) setTab(v as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = React.useCallback((t: T) => {
    setTab(t);
    const u = new URL(window.location.href);
    if (t === fallback) u.searchParams.delete(key); else u.searchParams.set(key, t);
    window.history.replaceState(window.history.state, '', u.toString());
  }, [fallback, key]);
  return [tab, set];
}

'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Persistent icon-rail sidebar collapse (the pattern used by VS Code / Linear / Vercel): the
 * sidebar shrinks to an icon-only rail and the choice is remembered across visits via localStorage.
 * SSR-safe: starts expanded, then hydrates the stored value on mount (avoids a hydration mismatch).
 * Collapse is a DESKTOP affordance — callers apply it behind `md:` utilities so the mobile
 * top-scroll nav is unaffected.
 *
 * @param key localStorage key so different consoles (admin vs platform) remember independently.
 */
export function useSidebarCollapsed(key: string): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(key) === '1');
    } catch {
      /* private mode / storage disabled — keep expanded */
    }
  }, [key]);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [key]);

  return { collapsed, toggle };
}

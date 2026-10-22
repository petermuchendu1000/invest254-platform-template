'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * PLAYER interface preference for the classic (waves) shell.
 *
 *  - `classic` — the full rise/fall trading terminal (price header, red/green curve, Buy/Sell, real
 *    currency). The default.
 *  - `basic`   — the simplified game skin (the one marketers always see): neutral single-colour wave,
 *    points, wordless arrows, neutral chrome. A player can opt in via the gear on the trade screen.
 *
 * Presentation ONLY and per-device (localStorage). It never grants marketer access — `useIsMarketer`
 * (role/routing) is unchanged, and every marketer endpoint stays gated server-side. A real marketer is
 * always on the basic skin regardless of this preference (see `useMarketerSkin`).
 */
export type InterfaceMode = 'classic' | 'basic';

interface InterfaceModeState {
  mode: InterfaceMode;
  setMode: (mode: InterfaceMode) => void;
  toggle: () => void;
}

export const useInterfaceModeStore = create<InterfaceModeState>()(
  persist(
    (set) => ({
      mode: 'classic',
      setMode: (mode) => set({ mode }),
      toggle: () => set((s) => ({ mode: s.mode === 'basic' ? 'classic' : 'basic' })),
    }),
    { name: 'pp-interface-mode', storage: createJSONStorage(() => localStorage) },
  ),
);

/**
 * Hydration-safe read: returns `classic` on the server and the first client render (so SSR and the
 * initial client paint agree — no hydration mismatch), then the stored value after mount. Mirrors the
 * marketer-preview pattern in `isMarketer.ts`.
 */
export function useInterfaceMode(): InterfaceMode {
  const mode = useInterfaceModeStore((s) => s.mode);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? mode : 'classic';
}

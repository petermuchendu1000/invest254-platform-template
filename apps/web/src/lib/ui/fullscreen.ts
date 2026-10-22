'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * MetaTrader's full-screen chart, which the app's title bar has to know about.
 *
 * *"Rotate to landscape = full-screen mode, automatically"* (docs/mt5/04-mobile-app.md section 3).
 * Full-screen means the app's chrome goes, and the title bar is 49px of a 360px-tall landscape
 * phone: hiding only the tab bar left the chart 164px of 360, which is not full-screen by any
 * reading of the word.
 *
 * Its own store because the two components are nowhere near each other: the phone shell decides,
 * and `TopBar` is above the whole route. Threading a prop would mean passing it through the layout.
 *
 * Not persisted. It follows the phone's orientation, and a stored "full-screen" restored on a
 * portrait phone would hide the title bar with nothing to put the space to.
 */
interface FullScreenState {
  on: boolean;
  set: (on: boolean) => void;
}

export const useFullScreenStore = create<FullScreenState>()((set) => ({
  on: false,
  set: (on) => set({ on }),
}));

/**
 * Declare full-screen for as long as the caller is mounted and asking for it.
 *
 * Released on unmount, because a chart that goes away with the flag still set would leave the app
 * with no title bar and no way to get it back.
 */
export function useDeclareFullScreen(on: boolean): void {
  const set = useFullScreenStore((s) => s.set);
  useEffect(() => {
    set(on);
    return () => set(false);
  }, [on, set]);
}

'use client';

import { create } from 'zustand';

/**
 * MetaTrader's side panel, open or shut.
 *
 * Its own store because two unrelated components reach it: the hamburger in the title bar opens it,
 * and the panel itself closes it. Threading a prop between them through the shell would be the only
 * alternative.
 */
interface DrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useNavDrawer = create<DrawerState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

import { create } from 'zustand';

/**
 * Global open/close state for the AI "Entry Scanner". The AI item in the digits bottom nav lives in
 * the app shell (outside GameSocketProvider), so it only toggles this flag; the scanner itself is
 * rendered inside the trade screen (which is inside GameSocketProvider) so it can actually sample
 * each instrument's live tick feed.
 */
interface EntryScannerState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useEntryScanner = create<EntryScannerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

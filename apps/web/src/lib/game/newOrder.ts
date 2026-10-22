'use client';

import { create } from 'zustand';

/**
 * A request to bring up the order ticket, which is MetaTrader's F9.
 *
 * MetaTrader's `New Order` opens a dialog. This terminal's ticket is not a dialog: on the desktop
 * it is docked beside the chart and never closed, and on a phone it is MetaTrader's own New Order
 * SCREEN, pushed over whatever tab is showing. So the request is published here and each surface
 * answers it the way it can — the phone shell opens its screen, the desktop ticket scrolls itself
 * into view and marks itself for a moment so the eye lands on it.
 *
 * A counter rather than a boolean: pressing F9 twice has to be answerable twice, and a boolean that
 * was already true the second time would be a key that silently did nothing. Surfaces watch the
 * number and act when it changes, so nothing has to be reset.
 */
interface NewOrderState {
  /** Bumped on every request. Zero means none has been made this session. */
  rev: number;
  ask: () => void;
}

export const useNewOrderStore = create<NewOrderState>()((set) => ({
  rev: 0,
  ask: () => set((s) => ({ rev: s.rev + 1 })),
}));

/** Make the request. Safe to call from outside React, which is where the chart's menu runs. */
export const askNewOrder = (): void => { useNewOrderStore.getState().ask(); };

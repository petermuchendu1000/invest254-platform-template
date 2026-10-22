'use client';

import { create } from 'zustand';

/** The candlestick screen's own small pieces of UI state (its How to Trade sheet). */
export const useCandlestickUi = create<{
  howToOpen: boolean;
  setHowTo: (v: boolean) => void;
  /**
   * Whether a contract is in flight, so the header's Real/Demo switch can refuse mid-trade.
   *
   * The header is mounted in `AppShell`, OUTSIDE `GameSocketProvider` — the provider lives inside
   * the trade screen — so the badge cannot ask the socket directly the way the digits pill does.
   * The screen knows, and writes it here. The server refuses the switch anyway; this exists so the
   * player is told "you have a trade open" instead of being handed a generic failure.
   */
  tradeOpen: boolean;
  setTradeOpen: (v: boolean) => void;
}>((set) => ({
  howToOpen: false,
  setHowTo: (howToOpen) => set({ howToOpen }),
  tradeOpen: false,
  setTradeOpen: (tradeOpen) => set({ tradeOpen }),
}));

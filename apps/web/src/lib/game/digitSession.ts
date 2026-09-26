import { create } from 'zustand';

/**
 * DIGITS-UI (mock parity): the trade screen's live session, shared with the app shell.
 *
 * The digits top bar (auto-trade pill, History), the bottom nav (Positions) and the positions panel
 * live outside the trade screen, so the screen publishes its in-flight contract and this session's
 * settled contracts here. Presentation state only: every figure comes from the engine's
 * `digit_settled` event, and nothing here places or settles a trade.
 */
export interface OpenContract { label: string; stakeCents: number; openedAtMs: number }
export interface ClosedContract {
  id: string; label: string; stakeCents: number; payoutCents: number; pnlCents: number;
  won: boolean; digit: number; openedAtMs: number; settledAtMs: number;
  /** DEMO-1: played on the demo account. */
  demo?: boolean;
}

interface DigitSessionState {
  open: OpenContract | null;
  closed: ClosedContract[];
  /** AUTO mode is running, and on which side (drives the top-bar pill). */
  auto: { side: string } | null;
  /** Overlays owned by the shell. */
  positionsOpen: boolean;
  historyOpen: boolean;
  howToOpen: boolean;
  setOpenContract: (c: OpenContract | null) => void;
  addClosed: (c: ClosedContract) => void;
  setAuto: (a: { side: string } | null) => void;
  setPositionsOpen: (v: boolean) => void;
  setHistoryOpen: (v: boolean) => void;
  setHowToOpen: (v: boolean) => void;
  /** Sign-out / another account: forget this session's contracts. */
  reset: () => void;
}

export const useDigitSession = create<DigitSessionState>((set) => ({
  open: null,
  closed: [],
  auto: null,
  positionsOpen: false,
  historyOpen: false,
  howToOpen: false,
  setOpenContract: (open) => set({ open }),
  addClosed: (c) => set((s) => ({ closed: [c, ...s.closed].slice(0, 200) })),
  setAuto: (auto) => set({ auto }),
  setPositionsOpen: (positionsOpen) => set({ positionsOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setHowToOpen: (howToOpen) => set({ howToOpen }),
  reset: () => set({ open: null, closed: [], auto: null }),
}));

/** Session totals derived from the settled list. */
export function sessionStats(closed: ClosedContract[]) {
  let wins = 0; let losses = 0; let pnl = 0;
  for (const c of closed) { if (c.won) wins++; else losses++; pnl += c.pnlCents; }
  return { trades: closed.length, wins, losses, pnlCents: pnl };
}

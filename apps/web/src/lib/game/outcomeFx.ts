import { create } from 'zustand';

/** Dispatched (window event) when the flying payout chip reaches the balance pill. */
export const BALANCE_BUMP_EVENT = 'pp-balance-bump';

/** Outcome headline computed by the engine's engagement layer (presentOutcome). */
export type OutcomeHeadline = 'big_win' | 'win' | 'small_win' | 'near_miss' | 'loss';

/** A settled position ready to be celebrated / acknowledged by the FX layer. */
export interface OutcomeFx {
  /** Monotonic id so the overlay re-fires even for identical consecutive results. */
  id: number;
  result: 'win' | 'loss';
  headline: OutcomeHeadline;
  nearMiss: boolean;
  lossDisguisedAsWin: boolean;
  lockedMultiplier: number;
  /** Gross amount returned to the wallet (cents). */
  payoutCents: number;
  /** Net profit/loss vs stake (cents). Positive on any win, negative on a loss. */
  pnlCents: number;
  stakeCents: number;
  mode: 'auto' | 'manual';
  /**
   * Identity of the closed position, carried so a terminal can report the close the way MetaTrader
   * does: by ticket and side. Optional because the classic shell's celebration never names them and
   * a settle that arrives with no position in hand (a reconnect, say) still has a result to show.
   */
  ticket?: string | undefined;
  direction?: 'buy' | 'sell' | undefined;
  /**
   * The instrument the closed position settled on.
   *
   * Carried here rather than read from the game socket, because this outcome is rendered by
   * `OutcomeOverlay`, which is mounted ABOVE `GameSocketProvider` in the tree: a hook into that
   * provider throws there, and the close notice took the whole app down with it on every settle.
   * The provider knows the symbol when it fires the outcome, so it states it.
   */
  symbol?: string | undefined;
}

interface OutcomeFxState {
  current: OutcomeFx | null;
  /** Fire an outcome celebration/acknowledgement. */
  show: (fx: Omit<OutcomeFx, 'id'>) => void;
  /** Dismiss the current outcome. */
  clear: () => void;
}

/**
 * Global outcome-FX bus. The game socket pushes settled outcomes here; the
 * OutcomeOverlay consumes them and orchestrates the celebratory / honest
 * feedback. Kept separate from the toast system so the overlay can own the
 * screen briefly without competing with transient notifications.
 */
export const useOutcomeFx = create<OutcomeFxState>((set) => ({
  current: null,
  show: (fx) => set({ current: { ...fx, id: Date.now() } }),
  clear: () => set({ current: null }),
}));

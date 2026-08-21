import { create } from 'zustand';

/**
 * Welcome-bonus celebration bus. Sign-up credits a restricted KES bonus (migration 0094); the
 * WelcomeBonusOverlay consumes this and reuses the winning-card language (confetti, count-up, the
 * chip that flies into the balance pill) to anchor a positive emotional peak on the user's very
 * first moment — the peak-end rule working for the brand. Kept separate from the game outcome bus
 * (outcomeFx) so a promotional gift never masquerades as a real trade result.
 */
export interface WelcomeBonusFx {
  /** Monotonic id so the overlay re-fires even for identical consecutive amounts. */
  id: number;
  /** Bonus amount credited, in cents. */
  amountCents: number;
}

interface WelcomeBonusFxState {
  current: WelcomeBonusFx | null;
  /** Fire the welcome-bonus celebration. */
  show: (amountCents: number) => void;
  /** Dismiss the current celebration. */
  clear: () => void;
}

export const useWelcomeBonusFx = create<WelcomeBonusFxState>((set) => ({
  current: null,
  show: (amountCents) => set({ current: { amountCents, id: Date.now() } }),
  clear: () => set({ current: null }),
}));

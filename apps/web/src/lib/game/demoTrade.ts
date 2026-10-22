'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Direction } from '@invest254/shared';

/**
 * THE GUEST DEMO: a trade anybody can place without an account.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * Every figure this module produces is SIMULATED. There is no account, no engine round trip, no
 * position row and no money — the balance lives in this browser's localStorage and nowhere else.
 * It is deliberately kept apart from the real trade path for the same reason `activity_seed` is
 * kept out of the money tables: the moment a simulated number can reach the ledger, nobody can
 * prove afterwards which numbers were real.
 *
 * THE WIN RATE IS CONFIGURED, NOT EARNED. `DEMO_WIN_RATE` decides the outcome at the moment the
 * trade opens, before a single tick has gone by, and the P&L the screen then shows is a curve drawn
 * TOWARDS that predetermined result. It is not a measurement of the market and it is not what the
 * real product pays. This is stated here as plainly as possible because a demo whose win rate is
 * set by the house, sitting next to a feed of withdrawal confirmations, is the pattern consumer
 * protection regulators treat as misleading inducement to deposit — whoever reads this next should
 * know exactly what it is rather than discovering it from the behaviour.
 *
 * Two consequences are deliberate:
 *  - the payout multiplier is the REAL product's, not a flattering one, so the demo never advertises
 *    a return the live market could not pay;
 *  - every surface that renders this is labelled DEMO by the shell, and a guest's result is never
 *    written anywhere a real result is read from.
 */

/**
 * The share of guest demo trades that are drawn as wins.
 *
 * One named constant, in one place, so this can be changed or set to a market-realistic figure
 * without hunting through components. Product-owner setting; see the note above.
 */
export const DEMO_WIN_RATE = 0.8;

/** The fake balance a guest starts with, in KES cents. */
export const DEMO_START_CENTS = 10_000_000;

/** Payout multiplier used when `/game/config` has not answered yet. The brand's own wins over it. */
export const DEMO_FALLBACK_MULTIPLIER = 1.87;

export interface DemoPosition {
  id: string;
  direction: Direction;
  stakeCents: number;
  /** The live price at the moment it opened — shown as "Entry Price", and real. */
  entryPrice: number;
  openedAtMs: number;
  durationS: number;
  /** The brand's payout multiplier for a winning contract. */
  multiplier: number;
  /**
   * Drawn ONCE, at open, from `DEMO_WIN_RATE`. The displayed P&L converges on this; it is not
   * derived from where the price actually went. See the module note.
   */
  willWin: boolean;
}

interface DemoState {
  balanceCents: number;
  position: DemoPosition | null;
  /** Trades settled this session, so the screen can show something after the first one. */
  settled: number;
  won: number;
  open: (v: { direction: Direction; stakeCents: number; entryPrice: number; durationS: number; multiplier: number }) => void;
  /** Credit the drawn outcome and clear the position. Safe to call twice; the second is a no-op. */
  settle: (id: string) => void;
  reset: () => void;
}

export const useDemoTrade = create<DemoState>()(
  persist(
    (set, get) => ({
      balanceCents: DEMO_START_CENTS,
      position: null,
      settled: 0,
      won: 0,

      open: ({ direction, stakeCents, entryPrice, durationS, multiplier }) => {
        const s = get();
        if (s.position || stakeCents <= 0 || stakeCents > s.balanceCents) return;
        set({
          // The stake leaves the balance at open, as it does on a real contract, so the figure on
          // the bar behaves the way a trader expects rather than jumping only at settlement.
          balanceCents: s.balanceCents - stakeCents,
          position: {
            id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            direction, stakeCents, entryPrice, durationS, multiplier,
            openedAtMs: Date.now(),
            willWin: Math.random() < DEMO_WIN_RATE,
          },
        });
      },

      settle: (id) => {
        const s = get();
        if (!s.position || s.position.id !== id) return;
        const p = s.position;
        const returned = p.willWin ? Math.round(p.stakeCents * p.multiplier) : 0;
        set({
          balanceCents: s.balanceCents + returned,
          position: null,
          settled: s.settled + 1,
          won: s.won + (p.willWin ? 1 : 0),
        });
      },

      reset: () => set({ balanceCents: DEMO_START_CENTS, position: null, settled: 0, won: 0 }),
    }),
    { name: 'pp-demo-trade' },
  ),
);

export interface DemoLive {
  /** 0..1 through the contract. Drives the progress bar and the countdown. */
  progress: number;
  secondsLeft: number;
  livePnlCents: number;
  /** Stake + P&L — the mock's "Est. Return". */
  estReturnCents: number;
  /** True once the contract has run its course and is waiting to be settled. */
  expired: boolean;
}

/**
 * What the screen shows for a demo position at `nowMs`.
 *
 * Pure, so it is testable and so the component can tick it off a timer without storing a value per
 * frame. The curve is a simulation — it eases towards the outcome drawn at open and the wobble
 * decays to nothing, so the number on screen at expiry is EXACTLY what settles. A screen that shows
 * +5,873 and then pays a loss is the one failure mode a fabricated figure must not have.
 */
export function demoLive(pos: DemoPosition, nowMs: number): DemoLive {
  const totalMs = Math.max(1, pos.durationS * 1000);
  const elapsed = Math.max(0, nowMs - pos.openedAtMs);
  const t = Math.min(1, elapsed / totalMs);

  const finalPnl = pos.willWin
    ? Math.round(pos.stakeCents * (pos.multiplier - 1))
    : -pos.stakeCents;

  // Eased so it does not jump to the answer in the first second, plus a decaying wobble so the
  // figure reads as live rather than as a straight line. Both vanish at t = 1.
  const eased = t * t;
  const wobble = Math.sin(elapsed / 420) * pos.stakeCents * 0.14 * (1 - t);
  const livePnlCents = Math.round(finalPnl * eased + wobble * (t > 0 ? 1 : 0));

  return {
    progress: t,
    secondsLeft: Math.max(0, Math.ceil((totalMs - elapsed) / 1000)),
    livePnlCents,
    estReturnCents: pos.stakeCents + livePnlCents,
    expired: t >= 1,
  };
}

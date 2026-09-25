/**
 * DEMO-2 — the figures each wallet surface shows, from one place (BUGLOG #82). `wallet.real` is the
 * ACTIVE account's spendable balance (the demo balance in demo mode), so it must never be offered as
 * withdrawable: money in and out is always the REAL account. Marketers are demo-locked by design and
 * keep their own demo transfer, so for them the active balance is the withdrawable one.
 *
 * Structurally typed (no imports) so it stays pure and unit-testable under `node --test`.
 */
export interface WalletLike {
  real: number; bonus: number; mode?: 'real' | 'demo'; modeLocked?: boolean;
  realBalance?: number; bonusBalance?: number; demoBalance?: number;
}

export interface WalletFigures {
  /** The player is in demo mode (not a demo-locked marketer): withdrawals need a switch to Real. */
  demo: boolean;
  /** The Real account: cash + bonus. */
  realTotal: number;
  /** What can be withdrawn right now (0 while in demo). */
  withdrawable: number;
  /** The Real cash that would become withdrawable after switching. */
  realCash: number;
  demoBalance: number;
}

export function walletFigures(w: WalletLike | null | undefined): WalletFigures {
  if (!w) return { demo: false, realTotal: 0, withdrawable: 0, realCash: 0, demoBalance: 0 };
  const inDemo = w.mode === 'demo';
  if (inDemo && w.modeLocked) {
    // marketer: always demo; their withdraw is the demo transfer
    return { demo: false, realTotal: w.real + w.bonus, withdrawable: w.real, realCash: w.real, demoBalance: w.demoBalance ?? w.real };
  }
  const realCash = w.realBalance ?? (inDemo ? 0 : w.real);
  const bonus = w.bonusBalance ?? (inDemo ? 0 : w.bonus);
  return {
    demo: inDemo,
    realTotal: realCash + bonus,
    withdrawable: inDemo ? 0 : realCash,
    realCash,
    demoBalance: w.demoBalance ?? (inDemo ? w.real : 0),
  };
}

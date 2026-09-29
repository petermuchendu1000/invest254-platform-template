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
  practiceBalance?: number; marketerPractice?: boolean;
}

export interface WalletFigures {
  /** The player is in demo mode (not a demo-locked marketer). */
  demo: boolean;
  /**
   * May a withdrawal be OFFERED at all? This is the single gate every surface asks before rendering
   * a Withdraw button, tab, menu item or tap target — the demo balance is play money and must never
   * be presented as cashable, not even as a disabled control or a "switch to Real to withdraw" hint.
   *
   * False while the wallet is still unknown: which account is active decides whether money can leave,
   * so nothing offers a way out before the answer is in (a Withdraw button that appears and then
   * vanishes is exactly the hint this is meant to remove). The server refuses a demo withdrawal with
   * DEMO_ACCOUNT regardless — this keeps the UI from ever asking.
   */
  canWithdraw: boolean;
  /** The Real account: cash + bonus. */
  realTotal: number;
  /** What can be withdrawn right now (0 while in demo). */
  withdrawable: number;
  /** The Real cash that would become withdrawable after switching. */
  realCash: number;
  demoBalance: number;
}

export function walletFigures(w: WalletLike | null | undefined): WalletFigures {
  if (!w) return { demo: false, canWithdraw: false, realTotal: 0, withdrawable: 0, realCash: 0, demoBalance: 0 };
  const inDemo = w.mode === 'demo';
  if (w.modeLocked) {
    // 0176 — a MARKETER is a normal player with two accounts:
    //  • Real = their funny money (demo_balance), withdrawn via the instant marketer transfer;
    //  • Demo = a separate practice bucket (practice_balance), never withdrawable.
    // `marketerPractice` is which tab is active. Withdraw is offered ONLY on Real (funny), exactly as
    // a player may withdraw Real but never Demo. The funny figure is the Real tab regardless of tab.
    const practice = w.marketerPractice === true;
    const funny = w.demoBalance ?? w.real;
    const practiceBal = w.practiceBalance ?? 0;
    return {
      demo: practice,
      canWithdraw: !practice,
      realTotal: funny,
      withdrawable: practice ? 0 : funny,
      realCash: funny,
      demoBalance: practiceBal,
    };
  }
  const realCash = w.realBalance ?? (inDemo ? 0 : w.real);
  const bonus = w.bonusBalance ?? (inDemo ? 0 : w.bonus);
  return {
    demo: inDemo,
    canWithdraw: !inDemo,
    realTotal: realCash + bonus,
    withdrawable: inDemo ? 0 : realCash,
    realCash,
    demoBalance: w.demoBalance ?? (inDemo ? w.real : 0),
  };
}

'use client';

import { cn } from '@/lib/cn';
import { walletFigures } from '@/lib/wallet/figures';
import type { WalletDto } from '@/lib/api/types';

/**
 * The Real/Demo account panel — ONE surface, shared by both shells (the classic `AccountSwitcher`
 * and the digits `AccountPill`), so the two can never drift in behaviour or in looks.
 *
 * Design rules it holds to:
 *  - **Anchored, not full-bleed.** A 280px card hung under the trigger it belongs to. The old panel
 *    spanned the whole phone width, which read as a slab dropped over the chart rather than a menu
 *    belonging to the balance.
 *  - **One vocabulary.** The R/D badge is the same mark as the trigger's, so a row and the pill say
 *    the same thing. No arbitrary coloured dots.
 *  - **One type scale.** Name 14px semibold, figure 12px mono tabular, caption 11px. Nothing else.
 *  - **The active row is marked with a check**, not a green word competing with the primary button.
 *  - **Deposit and Withdraw are 44px**, not 60px slabs — they are secondary to choosing an account.
 *  - **DEMO-3:** on the Demo account there is no Withdraw at all — absent, never disabled.
 */

const Check = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
    <path d="m5 10.5 3.2 3.2L15 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Refresh = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
    <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M16.8 3v3.2h-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface AccountMenuProps {
  wallet: WalletDto;
  /** Format cents in the display currency (each shell already has one). */
  fmt: (cents: number) => string;
  onSwitch: (mode: 'real' | 'demo') => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onTopupDemo: () => void;
  switching?: boolean;
  toppingUp?: boolean;
  /**
   * Which edge of the trigger the card hangs from. A RIGHT-anchored trigger (the classic top bar,
   * the digits desktop bar) drops the card to its left with `right-0`. A LEFT-anchored trigger (the
   * digits phone bar, where the pill sits by the menu button) must use `left-0`, or the 280px card
   * runs off the LEFT edge of the screen. Default 'right' keeps every existing caller unchanged.
   */
  align?: 'left' | 'right';
}

export function AccountMenu({
  wallet, fmt, onSwitch, onDeposit, onWithdraw, onTopupDemo, switching, toppingUp, align = 'right',
}: AccountMenuProps) {
  const f = walletFigures(wallet);
  // A MARKETER's Real/Demo switch is `marketerPractice` (account_mode stays 'demo' server-side); a
  // player's is `mode`. Either way this is which tab is active.
  const active = wallet.modeLocked
    ? (wallet.marketerPractice ? 'demo' : 'real')
    : (wallet.mode === 'demo' ? 'demo' : 'real');
  const bonus = wallet.modeLocked ? 0 : (wallet.bonusBalance ?? 0);

  const Row = ({ mode, label, cents, sub }: { mode: 'real' | 'demo'; label: string; cents: number; sub?: string }) => {
    const on = active === mode;
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={on}
        // The visible label is one word; assistive tech gets the whole sentence.
        aria-label={`${label} account, ${fmt(cents)}${on ? ', active' : ''}`}
        disabled={switching}
        onClick={() => onSwitch(mode)}
        className={cn(
          'flex min-h-[3.5rem] w-full items-center gap-3 px-3 text-left transition',
          on ? 'bg-surface-2' : 'active:bg-surface-2/70 sm:hover:bg-surface-2/60',
        )}
      >
        <span
          aria-hidden
          className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-extrabold',
            mode === 'demo' ? 'bg-warn/20 text-warn' : 'bg-accent/20 text-accent')}
        >
          {mode === 'demo' ? 'D' : 'R'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold leading-tight text-fg">{label}</span>
          <span className="mt-0.5 block truncate font-mono text-[12px] leading-tight tabular-nums text-muted">
            {fmt(cents)}{sub ? <span className="font-sans"> · {sub}</span> : null}
          </span>
        </span>
        {on ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
      </button>
    );
  };

  // NOTE: no scrim. Both top bars use `backdrop-blur`, which makes the header a containing block for
  // fixed descendants — a `fixed inset-0` overlay rendered here covers only the 56px header, not the
  // page, so it dims nothing while silently swallowing taps beneath it. The card carries its own
  // border and shadow, and the trigger's outside-tap handler (pointerdown) dismisses it.
  return (
    <>
      <div
        role="dialog"
        aria-label="Switch account"
        className={cn(
          'pp-pop-in absolute top-[calc(100%+10px)] z-50',
          // Right-anchored (classic + digits desktop): drop to the left, clamped to the viewport.
          // Left-anchored (digits phone, pill by the menu button): open to the right, and reserve
          // room for the pill's offset from the screen edge so it still fits a 320px phone.
          align === 'left'
            ? 'left-0 w-[min(17.5rem,calc(100vw-4rem))]'
            : 'right-0 w-[min(17.5rem,calc(100vw-1.5rem))]',
          'overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50',
        )}
      >
        {/* A MARKETER is a normal player with two accounts (0176): Real is their funny money
            (withdrawn via the instant marketer transfer), Demo is their separate practice bucket. The
            switch and rows are identical to a player's — indistinguishable — so nothing here names the
            account type. Their switch toggles the practice flag server-side; account_mode stays 'demo'. */}
        <div role="menu" aria-label="Accounts" className="flex flex-col">
          <Row mode="real" label="Real" cents={f.realTotal} {...(bonus > 0 ? { sub: `${fmt(bonus)} bonus` } : {})} />
          <div className="mx-3 h-px bg-border" />
          <Row mode="demo" label="Demo" cents={f.demoBalance} />
        </div>

        {active === 'demo' ? (
          <>
            <div className="h-px bg-border" />
            <button
              type="button"
              disabled={toppingUp}
              onClick={onTopupDemo}
              className="flex min-h-[2.75rem] w-full items-center gap-2 px-3 text-[12px] font-medium text-muted transition active:bg-surface-2/70 disabled:opacity-50 sm:hover:bg-surface-2/60 sm:hover:text-fg"
            >
              <Refresh className={cn('h-4 w-4', toppingUp && 'animate-spin')} />
              {toppingUp ? 'Topping up…' : 'Top up demo balance'}
            </button>
          </>
        ) : null}

        <div className="h-px bg-border" />
        <div className="p-2">
          {/* DEMO-3: no Withdraw on the Demo account — absent, not disabled. Deposit funds Real. */}
          <div className={cn('grid gap-2', f.canWithdraw ? 'grid-cols-2' : 'grid-cols-1')}>
            <button
              type="button"
              onClick={onDeposit}
              className="h-11 rounded-xl bg-accent text-[13px] font-semibold text-accent-fg transition active:brightness-95 sm:hover:brightness-105"
            >
              Deposit
            </button>
            {f.canWithdraw ? (
              <button
                type="button"
                onClick={onWithdraw}
                className="h-11 rounded-xl border border-border text-[13px] font-semibold text-fg transition active:bg-surface-2 sm:hover:border-accent/50"
              >
                Withdraw
              </button>
            ) : null}
          </div>
          {active === 'demo' ? (
            <p className="px-1 pt-2 text-[11px] leading-snug text-muted">
              Practice money: never withdrawable.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

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
}

export function AccountMenu({
  wallet, fmt, onSwitch, onDeposit, onWithdraw, onTopupDemo, switching, toppingUp,
}: AccountMenuProps) {
  const f = walletFigures(wallet);
  const active = wallet.mode === 'demo' ? 'demo' : 'real';
  const bonus = wallet.bonusBalance ?? 0;

  const Row = ({ mode, label, cents, sub }: { mode: 'real' | 'demo'; label: string; cents: number; sub?: string }) => {
    const on = active === mode;
    const locked = mode === 'real' && wallet.modeLocked;
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={on}
        // The visible label is one word; assistive tech gets the whole sentence.
        aria-label={`${label} account, ${fmt(cents)}${on ? ', active' : ''}`}
        disabled={locked || switching}
        onClick={() => onSwitch(mode)}
        className={cn(
          'flex min-h-[3.5rem] w-full items-center gap-3 px-3 text-left transition',
          on ? 'bg-surface-2' : 'active:bg-surface-2/70 sm:hover:bg-surface-2/60',
          // A locked row keeps FULL contrast and says why on the right. Dimming it to 40% with no
          // explanation is what made this read as a broken button rather than an unavailable account.
          locked && 'cursor-not-allowed',
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
          {/* No figure on an unavailable account: it competes with the badge for width (truncating
              both), and for a locked marketer the "real" figure is their demo balance anyway. */}
          {locked ? null : (
            <span className="mt-0.5 block truncate font-mono text-[12px] leading-tight tabular-nums text-muted">
              {fmt(cents)}{sub ? <span className="font-sans"> · {sub}</span> : null}
            </span>
          )}
        </span>
        {locked
          ? <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Unavailable</span>
          : on ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
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
          'pp-pop-in absolute right-0 top-[calc(100%+10px)] z-50 w-[min(17.5rem,calc(100vw-1.5rem))]',
          'overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50',
        )}
      >
        {/* A MARKETER has no Real account to switch to — offering one (even greyed out) misdescribes
            the account. Their balance is their own, their payout is the marketer transfer, and their
            earnings live in their own app.
            NAMED NEUTRALLY ON PURPOSE. The marketer system is covert by design — the dashboard entry
            is an invisible hotspot precisely so "NO visible button a watching player could notice".
            Printing "Marketer" (or "Demo") here would tell anyone looking over their shoulder exactly
            what the account is, which is the one thing this surface must not do. So: balance only. */}
        {wallet.modeLocked ? (
          <div className="flex min-h-[3.5rem] items-center px-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-muted">Balance</span>
              <span className="mt-0.5 block truncate font-mono text-[18px] font-bold leading-tight tabular-nums text-fg">{fmt(f.realTotal)}</span>
            </span>
          </div>
        ) : (
          <div role="menu" aria-label="Accounts" className="flex flex-col">
            <Row mode="real" label="Real" cents={f.realTotal} {...(bonus > 0 ? { sub: `${fmt(bonus)} bonus` } : {})} />
            <div className="mx-3 h-px bg-border" />
            <Row mode="demo" label="Demo" cents={f.demoBalance} />
          </div>
        )}

        {active === 'demo' && !wallet.modeLocked ? (
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
          {active === 'demo' && !wallet.modeLocked ? (
            <p className="px-1 pt-2 text-[11px] leading-snug text-muted">
              Practice money — never withdrawable.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

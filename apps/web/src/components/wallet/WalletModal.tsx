'use client';

import { useDisplayMoney } from '@/lib/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useDepositUi, type WalletMode } from '@/lib/wallet/depositUi';
import { useWallet } from '@/lib/wallet/hooks';
import { walletFigures } from '@/lib/wallet/figures';
import { useSession } from '@/lib/auth/session';
import { DepositPanel } from '@/components/wallet/DepositPanel';
import { WithdrawForm } from '@/components/wallet/WithdrawForm';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5_CONFIRM_TOKENS } from '@/lib/ui/mt5Tokens';

const TABS: { mode: WalletMode; label: string }[] = [
  { mode: 'deposit', label: 'Deposit' },
  { mode: 'withdraw', label: 'Withdraw' },
];

/**
 * Unified wallet sheet: a single modal with a Deposit/Withdraw toggle so the two flows share
 * one surface, one balance header, and one mental model. Any caller picks the starting tab.
 */
export function WalletModal() {
  const { parts } = useDisplayMoney();
  const open = useDepositUi((s) => s.open);
  const mode = useDepositUi((s) => s.mode);
  const setMode = useDepositUi((s) => s.setMode);
  const close = useDepositUi((s) => s.close);
  const token = useSession((s) => s.token);
  const { data: wallet } = useWallet();
  const f = walletFigures(wallet);
  /**
   * On a candlestick brand the sheet is part of the terminal, so it wears MetaTrader's palette. The
   * payment forms inside are NOT rewritten: re-pointing the theme tokens on the panel repaints the
   * whole tree, and a thousand lines of money-moving code stay exactly as they are. Only the sheet's
   * own chrome — the title bar and the tab strip — is MetaTrader's here.
   */
  const mt5 = useTerminalSkin();

  // DEMO-3: the Demo account has no way out. Any caller that still asks for the Withdraw tab (a stale
  // store value, a deep link, a mode switched while the sheet was open) lands on Deposit instead —
  // the sheet never renders a withdrawal surface for play money, and the tab strip is hidden because
  // there is only one action left. The server refuses a demo withdrawal anyway; this is the UI half.
  const active: WalletMode = f.canWithdraw ? mode : 'deposit';

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={active === 'deposit' ? 'Deposit' : 'Withdraw'}
      chrome={false}
      panelStyle={mt5 ? MT5_CONFIRM_TOKENS : undefined}
      // The tokens repaint the colours of all 1,100 lines of payment code below; `mt5-square` is the
      // other half — the radii, which are literal classes and so survive a token repaint.
      panelClassName={mt5 ? 'mt5-square sm:!rounded-sm' : undefined}
    >
      {/* Header. MetaTrader's is a solid blue band with the screen name and a close control. */}
      <div
        className={cn(
          'flex items-center justify-between border-b',
          mt5 ? 'border-[var(--mt5-border)] bg-[var(--mt5-blue)] px-3 py-2.5' : 'border-border p-4',
        )}
      >
        <h2 className={cn('font-semibold', mt5 ? 'text-[15px] text-white' : 'text-lg')}>
          {mt5 ? (active === 'deposit' ? 'Deposit' : 'Withdraw') : 'M-Pesa wallet'}
        </h2>
        {mt5 ? (
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="-mr-1 rounded p-1 text-white transition hover:bg-white/20"
          >
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <Button variant="ghost" size="sm" aria-label="Close" onClick={close}>✕</Button>
        )}
      </div>

      {/* Balance — the anchor for both actions */}
      <div className="px-4 pt-4">
        <div className="flex flex-col items-center gap-0.5 rounded-2xl bg-surface-2 px-4 py-3 text-center">
          <span className="text-xs text-muted">{active === 'deposit' ? 'Real balance' : 'Withdrawable'}</span>
          {token && !wallet ? (
            <Skeleton className="h-7 w-32" />
          ) : (() => {
            // DEMO-2: money in and out is always the Real account, never the demo balance.
            const bal = parts(active === 'deposit' ? f.realTotal : f.withdrawable);
            return (
              <>
                <span className="text-2xl font-extrabold leading-tight tracking-tight text-accent">{bal.display}</span>
                {bal.foreign ? <span className="text-xs font-medium text-muted">{bal.kes}</span> : null}
              </>
            );
          })()}
        </div>
      </div>

      {/* Deposit / Withdraw toggle — hidden entirely on the Demo account (Deposit is the only action) */}
      {f.canWithdraw ? (
        <div className={mt5 ? '' : 'px-4 pt-3'}>
          {/* MetaTrader underlines the active tab in blue rather than filling it. */}
          <div
            className={cn(
              'flex',
              mt5 ? 'border-b border-[var(--mt5-border)]' : 'rounded-xl border border-border bg-surface-2 p-1',
            )}
            role="tablist"
            aria-label="Wallet action"
          >
            {TABS.map(({ mode: m, label }) => {
              const on = active === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex-1 text-sm font-semibold transition',
                    mt5
                      ? cn(
                        'border-b-2 py-2.5 uppercase tracking-wider',
                        on ? 'border-[var(--mt5-blue)] text-white' : 'border-transparent text-[var(--mt5-muted)]',
                      )
                      : cn('rounded-lg py-2', on ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg'),
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Active form — key forces a clean remount (fresh state) when switching tabs */}
      {active === 'deposit' ? <DepositPanel key="deposit" /> : <WithdrawForm key="withdraw" />}
    </Modal>
  );
}

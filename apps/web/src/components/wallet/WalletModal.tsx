'use client';

import { useDisplayMoney } from '@/lib/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useDepositUi, type WalletMode } from '@/lib/wallet/depositUi';
import { useWallet } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { DepositForm } from '@/components/wallet/DepositForm';
import { WithdrawForm } from '@/components/wallet/WithdrawForm';

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

  if (!open) return null;

  return (
    <Modal open={open} onClose={close} title={mode === 'deposit' ? 'Deposit' : 'Withdraw'}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-lg font-semibold">M-Pesa wallet</h2>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={close}>✕</Button>
      </div>

      {/* Balance — the anchor for both actions */}
      <div className="px-4 pt-4">
        <div className="flex flex-col items-center gap-0.5 rounded-2xl bg-surface-2 px-4 py-3 text-center">
          <span className="text-xs text-muted">{mode === 'deposit' ? 'Available balance' : 'Available to withdraw'}</span>
          {token && !wallet ? (
            <Skeleton className="h-7 w-32" />
          ) : (() => {
            const bal = parts(wallet ? (mode === 'deposit' ? wallet.real + wallet.bonus : wallet.real) : 0);
            return (
              <>
                <span className="text-2xl font-extrabold leading-tight tracking-tight text-accent">{bal.display}</span>
                {bal.foreign ? <span className="text-xs font-medium text-muted">{bal.kes}</span> : null}
              </>
            );
          })()}
        </div>
      </div>

      {/* Deposit / Withdraw toggle */}
      <div className="px-4 pt-3">
        <div className="flex rounded-xl border border-border bg-surface-2 p-1" role="tablist" aria-label="Wallet action">
          {TABS.map(({ mode: m, label }) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 rounded-lg py-2 text-sm font-semibold transition',
                  active ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active form — key forces a clean remount (fresh state) when switching tabs */}
      {mode === 'deposit' ? <DepositForm key="deposit" /> : <WithdrawForm key="withdraw" />}
    </Modal>
  );
}

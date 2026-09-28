'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useDisplayMoney } from '@/lib/money';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { useWallet, useSetAccountMode, useTopupDemo } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useCountUp } from '@/lib/useCountUp';
import { BALANCE_BUMP_EVENT } from '@/lib/game/outcomeFx';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { AccountMenu } from '@/components/wallet/AccountMenu';

/**
 * Top-bar balance + Real/Demo account switcher for the standard shell.
 *
 * WHY THIS EXISTS: the account switcher only ever shipped on the `digits` trade surface, which 2 of
 * 15 brands run. On the other 13 the balance pill opened the Withdraw tab and there was no way to
 * reach the Demo account at all — the mode existed in the database and the API since migration 0123,
 * but a player could not switch to it.
 *
 * The trigger is a 44px pill: the account's mark (R/D), then the spendable balance. The panel itself
 * is `AccountMenu`, shared with the digits shell so the two surfaces cannot drift.
 *
 * Switching is refused by the server while a contract is open (`OPEN_POSITIONS`); the error is shown
 * rather than pre-empted, because the open-trade stores belong to each trade surface.
 */
export function AccountSwitcher() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const { data } = useWallet();
  const { fmt } = useDisplayMoney();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const setMode = useSetAccountMode();
  const topup = useTopupDemo();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // One spendable number, not two buckets (docs/31): the pill shows what the active account can stake.
  const total = (data?.real ?? 0) + (data?.bonus ?? 0);
  const shown = useCountUp(total, 700, total);
  const [bump, setBump] = useState(false);
  const prevRef = useRef(total);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: on a touch screen the synthetic mouse event only arrives after
    // the tap completes, so a mousedown-only handler makes the menu feel slow to dismiss.
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => {
    const trigger = () => {
      setBump(false);
      requestAnimationFrame(() => setBump(true));
      setTimeout(() => setBump(false), 750);
    };
    window.addEventListener(BALANCE_BUMP_EVENT, trigger);
    return () => window.removeEventListener(BALANCE_BUMP_EVENT, trigger);
  }, []);

  useEffect(() => {
    if (total > prevRef.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 750);
      prevRef.current = total;
      return () => clearTimeout(t);
    }
    prevRef.current = total;
  }, [total]);

  if (!hydrated || !token || !data) return null;

  const demo = data.mode === 'demo';

  const switchTo = (mode: 'real' | 'demo') => {
    if (mode === data.mode || setMode.isPending) return;
    setMode.mutate(mode, {
      onSuccess: (r) => {
        setOpen(false);
        toast.push({ tone: 'success', title: r.mode === 'demo' ? 'Demo account' : 'Real account', description: fmt(r.wallet.real + r.wallet.bonus) });
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Could not switch', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        id="balance-pill"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${demo ? 'Demo' : 'Real'} account, ${fmt(total)}. Switch account`}
        className={cn(
          'inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border bg-surface pl-1.5 pr-3 transition',
          demo ? 'border-warn/60' : 'border-border',
          'sm:hover:border-accent',
          bump && 'pp-balance-bump',
        )}
      >
        <span
          aria-hidden
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold',
            demo ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent')}
        >
          {demo ? 'D' : 'R'}
        </span>
        <span className="flex flex-col items-start leading-none">
          <span className={cn('text-[9px] font-semibold uppercase tracking-wider', demo ? 'text-warn' : 'text-muted')}>
            {demo ? 'Demo' : 'Real'}
          </span>
          <span className="mt-0.5 font-mono text-[13px] font-bold tabular-nums text-fg">{fmt(Math.round(shown))}</span>
        </span>
      </button>

      {open ? (
        <AccountMenu
          wallet={data}
          fmt={fmt}
          switching={setMode.isPending}
          toppingUp={topup.isPending}
          onSwitch={switchTo}
          onDeposit={() => { setOpen(false); openDeposit(); }}
          onWithdraw={() => { setOpen(false); openWithdraw(); }}
          onTopupDemo={() => topup.mutate(undefined, {
            onSuccess: (r) => toast.push({ tone: 'success', title: 'Demo balance topped up', description: fmt(r.demoBalance ?? 0) }),
            onError: (e) => toast.push({ tone: 'error', title: 'Could not top up', description: e instanceof ApiError ? e.message : 'Try again.' }),
          })}
        />
      ) : null}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { MeDto } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useDepositUi } from '@/lib/wallet/depositUi';

/* ── icons (currentColor, inherit row colour) ─────────────────────────────── */
const ic = 'h-[18px] w-[18px] shrink-0';
const DepositIcon = () => (
  <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M12 3v12M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 20h16" strokeLinecap="round" />
  </svg>
);
const WithdrawIcon = () => (
  <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M12 21V9M7 14l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 4h16" strokeLinecap="round" />
  </svg>
);
const HistoryIcon = () => (
  <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const AccountIcon = () => (
  <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" strokeLinecap="round" />
  </svg>
);
const LogoutIcon = () => (
  <svg viewBox="0 0 24 24" className={ic} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 8l-4 4 4 4M6 12h11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Profile avatar + quick-actions dropdown. Collapses the top-bar clutter (username + log out
 * + theme) into one tap, and surfaces the highest-intent money actions (Deposit/Withdraw)
 * right where the user looks for "their account". Closes on outside-click / Esc / navigation.
 */
export function ProfileMenu({ user }: { user: MeDto }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { logout } = useAuthActions();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = user.username.charAt(0).toUpperCase() || '@';
  const itemCls = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-fg transition hover:bg-surface-2';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-fg ring-2 ring-transparent transition hover:ring-accent/40"
      >
        {initial}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-2xl border border-border bg-surface p-1 shadow-2xl shadow-black/60 ring-1 ring-white/5"
        >
          {/* Identity */}
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-fg">
              {initial}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">@{user.username}</div>
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          {/* Money actions — highest intent first */}
          <button role="menuitem" className={itemCls} onClick={() => { setOpen(false); openDeposit(); }}>
            <span className="text-accent"><DepositIcon /></span> Deposit
          </button>
          <button role="menuitem" className={itemCls} onClick={() => { setOpen(false); openWithdraw(); }}>
            <span className="text-accent"><WithdrawIcon /></span> Withdraw
          </button>

          <div className="my-1 h-px bg-border" />

          <Link role="menuitem" href="/history" className={itemCls} onClick={() => setOpen(false)}>
            <HistoryIcon /> History
          </Link>
          <Link role="menuitem" href="/account" className={itemCls} onClick={() => setOpen(false)}>
            <AccountIcon /> Account
          </Link>

          {/* Theme toggle stays in the menu (doesn't close it) */}
          <div className="my-1 h-px bg-border" />

          <button
            role="menuitem"
            className={cn(itemCls, 'text-down hover:bg-down/10')}
            onClick={() => { setOpen(false); logout(); }}
          >
            <LogoutIcon /> Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { MeDto } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useWalletFigures } from '@/lib/wallet/hooks';

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
  const figures = useWalletFigures();
  /**
   * On a terminal brand this menu hangs off MetaTrader's blue title bar, and it was the last thing
   * up there still wearing the app's own look: a round green avatar, a 16px-radius card, green
   * action icons. Re-pointing the --pp-* tokens repaints the whole panel (surface, border, text,
   * accent) in one go; only the RADII are literal classes, so those are the only ones switched by
   * hand. MetaTrader is square — see --pp-radius in mt5Tokens.
   */
  const mt5 = useTerminalSkin();

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
  const itemCls = cn(
    'flex w-full items-center gap-3 px-3 py-2 text-sm font-medium text-fg transition hover:bg-surface-2',
    mt5 ? 'rounded-none' : 'rounded-lg',
  );
  // MetaTrader's accent is blue; the app's is green. The money icons follow whichever is in play.
  const iconTone = mt5 ? 'text-[var(--mt5-blue-link)]' : 'text-accent';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={cn(
          'flex items-center justify-center text-sm font-bold transition',
          mt5
            // Flat and outlined, like the title bar's other control: a filled green disc was the
            // single loudest non-MetaTrader thing on the band.
            ? 'h-8 w-8 rounded-sm border border-white/70 bg-transparent text-white hover:bg-white/20'
            : 'h-9 w-9 rounded-full bg-accent text-accent-fg ring-2 ring-transparent hover:ring-accent/40',
        )}
      >
        {initial}
      </button>

      {open ? (
        <div
          role="menu"
          style={mt5 ? MT5_TOKENS : undefined}
          className={cn(
            'absolute right-0 z-40 mt-2 w-60 overflow-hidden border border-border bg-surface shadow-2xl shadow-black/60',
            mt5 ? 'rounded-sm p-0' : 'rounded-2xl p-1 ring-1 ring-white/5',
          )}
        >
          {/* Identity */}
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className={cn(
              'flex h-9 w-9 items-center justify-center text-sm font-bold',
              mt5 ? 'rounded-sm bg-[var(--mt5-blue)] text-white' : 'rounded-full bg-accent text-accent-fg',
            )}>
              {initial}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">@{user.username}</div>
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          {/* Money actions — highest intent first */}
          <button role="menuitem" className={itemCls} onClick={() => { setOpen(false); openDeposit(); }}>
            <span className={iconTone}><DepositIcon /></span> Deposit
          </button>
          {/* DEMO-3: the Demo account has no way out — the item is absent, not disabled. */}
          {figures.canWithdraw ? (
            <button role="menuitem" className={itemCls} onClick={() => { setOpen(false); openWithdraw(); }}>
              <span className={iconTone}><WithdrawIcon /></span> Withdraw
            </button>
          ) : null}

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

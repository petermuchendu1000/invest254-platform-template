'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';
import { BalancePill } from '@/components/wallet/BalancePill';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';

function Icon({ path, className = 'h-5 w-5' }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={path} />
    </svg>
  );
}

/** Nav destinations that the digits shell moves into the hamburger drawer (the bottom nav on the
 *  digits trade surface is Live Chat / AI / Positions, so primary nav lives here). */
const NAV = [
  { href: '/', label: 'Trade', path: 'M3 12l4-4 4 4 6-6M17 6h4v4' },
  { href: '/wallet', label: 'Wallet', path: 'M3 7h15a2 2 0 012 2v6a2 2 0 01-2 2H3zM16 12h.01' },
  { href: '/history', label: 'History', path: 'M12 8v4l3 2M21 12a9 9 0 11-9-9' },
  { href: '/account', label: 'Account', path: 'M12 8a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0' },
  { href: '/legal', label: 'Legal', path: 'M12 3l8 4v5c0 4-3.5 7-8 9-4.5-2-8-5-8-9V7z' },
] as const;

/**
 * Digits-brand top bar (matches the digits broker mock): hamburger nav drawer, brand wordmark,
 * balance pill and Deposit CTA. Only rendered for brands
 * whose `trade_ui = 'digits'`; every other brand keeps the standard TopBar. Reuses the existing
 * wallet / auth / session stores so all behaviour is preserved.
 */
export function DigitsTopBar() {
  const brand = useBrand();
  const wordmark = brandWordmark(brand);
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const reset = useSession((s) => s.reset);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openAuth = useAuthUi((s) => s.openAuth);

  const [menuOpen, setMenuOpen] = useState(false);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [menuOpen]);

  const authed = hydrated && !!token;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-app items-center gap-2 px-3 sm:px-4">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-fg transition hover:bg-surface-2"
          >
            <Icon path="M3 6h18M3 12h18M3 18h18" />
          </button>

          <Link href="/" aria-label={`${brand.name} home`} className="text-[17px] font-extrabold leading-none tracking-tight text-fg">
            {wordmark}
          </Link>

          {authed ? <div className="ml-1"><BalancePill /></div> : null}

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {authed ? (
              <button
                type="button"
                onClick={() => openDeposit()}
                className="rounded-full bg-accent px-4 py-2 text-sm font-bold text-accent-fg shadow-[0_0_0_1px_color-mix(in_srgb,var(--pp-accent)_25%,transparent)] transition hover:brightness-105"
              >
                Deposit
              </button>
            ) : (
              <>
                <button type="button" onClick={() => openAuth('login')} className="rounded-full px-3 py-2 text-sm font-semibold text-muted transition hover:text-fg">Login</button>
                <button type="button" onClick={() => openAuth('register')} className="rounded-full bg-accent px-4 py-2 text-sm font-bold text-accent-fg transition hover:brightness-105">Sign Up</button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hamburger nav drawer */}
      {menuOpen ? (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          <button aria-label="Close menu" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <nav className="relative flex h-full w-72 max-w-[80vw] flex-col border-r border-border bg-surface p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[17px] font-extrabold tracking-tight text-fg">{wordmark}</span>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
                <Icon path="M6 6l12 12M18 6L6 18" className="h-4 w-4" />
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-muted transition hover:bg-surface-2 hover:text-fg"
                  >
                    <Icon path={n.path} className="h-5 w-5" />
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-auto border-t border-border pt-3">
              {authed ? (
                <button
                  type="button"
                  onClick={() => { reset(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-down transition hover:bg-down/10"
                >
                  <Icon path="M15 12H3M9 8l-4 4 4 4M13 4h6a1 1 0 011 1v14a1 1 0 01-1 1h-6" className="h-5 w-5" />
                  Log out
                </button>
              ) : (
                <div className="flex gap-2">
                  <button type="button" onClick={() => { openAuth('login'); setMenuOpen(false); }} className="flex-1 rounded-lg border border-border py-2.5 text-sm font-semibold text-fg hover:border-accent/60">Login</button>
                  <button type="button" onClick={() => { openAuth('register'); setMenuOpen(false); }} className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-fg">Sign Up</button>
                </div>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}

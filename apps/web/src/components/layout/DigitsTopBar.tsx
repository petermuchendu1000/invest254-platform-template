'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useAuthUi } from '@/lib/auth/ui';
import { useSession } from '@/lib/auth/session';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { useDigitSession } from '@/lib/game/digitSession';
import { useEntryScanner } from '@/lib/game/entryScannerUi';
import { useLiveChat } from '@/lib/chat/liveChat';
import { useLiveChatUnread } from '@/components/chat/LiveChatPanel';
import { useMyNotifications, useDismissNotification } from '@/lib/notifications/hooks';
import { DIcon, type IconName } from '@/components/game/digits/icons';
import { AccountMenu, AccountPill } from '@/components/layout/DigitsAccount';
import { SoundToggle } from '@/components/layout/SoundToggle';
import { useSound } from '@/lib/sound/sound';

/** Brand wordmark in two tones (first word light, the rest in the accent), e.g. "Tamu" + "Traders". */
function Wordmark({ text, className }: { text: string; className?: string }) {
  const i = text.indexOf(' ');
  const [a, b] = i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ''];
  return (
    <span className={cn('whitespace-nowrap font-extrabold leading-none tracking-tight', className)}>
      <span className="text-fg">{a}</span>{b ? <span className="text-accent">{b}</span> : null}
    </span>
  );
}

function NavButton({ icon, label, onClick, variant = 'plain' }: { icon?: IconName; label: string; onClick: () => void; variant?: 'plain' | 'pill' | 'accent' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium transition xl:px-3',
        variant === 'plain' && 'text-muted hover:text-fg',
        variant === 'pill' && 'border border-border text-fg hover:border-accent/50',
        variant === 'accent' && 'bg-accent font-semibold text-accent-fg shadow-[0_0_18px_-6px_var(--pp-accent)] hover:brightness-105',
      )}
    >
      {icon ? <DIcon name={icon} className="h-4 w-4" /> : null}
      {/* 1024–1279px: icons only, so the balance, Deposit and the account menu never run off-screen */}
      <span className={icon && variant !== 'accent' ? 'hidden xl:inline' : undefined}>{label}</span>
    </button>
  );
}

/** Phone drawer row: sound on / off (the header speaker is hidden on the narrowest phones). */
function SoundMenuRow() {
  const muted = useSound((s) => s.muted);
  const toggle = useSound((s) => s.toggle);
  return (
    <button type="button" role="switch" aria-checked={!muted} onClick={toggle}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-muted transition hover:bg-surface-2 hover:text-fg">
      <DIcon name={muted ? 'mute' : 'volume'} className="h-5 w-5" />Sound
      <span className={cn('ml-auto text-xs font-semibold', muted ? 'text-muted' : 'text-up')}>{muted ? 'Off' : 'On'}</span>
    </button>
  );
}

/** Notices from the brand (the same ones shown as banners), with a count badge. */
function Bell() {
  const { data } = useMyNotifications();
  const dismiss = useDismissNotification();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const items = data?.items ?? [];
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={`Notifications${items.length ? ` (${items.length})` : ''}`}
        className="relative grid h-10 w-10 place-items-center rounded-full text-fg transition hover:bg-surface-2">
        <DIcon name="bell" className="h-[18px] w-[18px]" />
        {items.length ? <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-down px-1 text-[9px] font-bold text-white">{items.length}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-2xl">
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Notifications</div>
          {items.length === 0 ? <p className="px-3 pb-3 text-[13px] text-muted">You’re all caught up.</p> : (
            <ul className="max-h-80 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-fg">{n.title}</div>
                    {n.body ? <div className="text-[12px] text-muted">{n.body}</div> : null}
                  </div>
                  {n.dismissible ? (
                    <button type="button" aria-label="Dismiss" onClick={() => dismiss.mutate(n.id)} className="text-muted hover:text-fg"><DIcon name="close" className="h-3.5 w-3.5" /></button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Digits-brand top bar (digits broker mock).
 *  - Desktop: wordmark · home · Trader's Hub · Deposit · Withdraw · History · AI · Live Chat ·
 *    How to Trade, then the balance pill, Deposit, notifications and the account menu.
 *  - Phone: menu · wordmark · balance pill (shows "Auto · <side>" while Auto runs) · Deposit · bell;
 *    the nav lives in the drawer.
 * Reuses the wallet / auth / session stores, so behaviour is unchanged.
 */
export function DigitsTopBar() {
  const brand = useBrand();
  const wordmark = brandWordmark(brand);
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const { logout } = useAuthActions();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const openAuth = useAuthUi((s) => s.openAuth);
  const openScanner = useEntryScanner((s) => s.setOpen);
  const setSupportOpen = useLiveChat((s) => s.setOpen);
  const chatUnread = useLiveChatUnread();
  const setHistoryOpen = useDigitSession((s) => s.setHistoryOpen);
  const setHowToOpen = useDigitSession((s) => s.setHowToOpen);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [menuOpen]);

  const authed = hydrated && !!token;
  const needAuth = (fn: () => void) => () => (authed ? fn() : openAuth('login'));

  const drawer: { icon: IconName; label: string; onClick?: () => void; href?: string }[] = [
    { icon: 'trend', label: "Trader's Hub", href: '/' },
    { icon: 'deposit', label: 'Deposit', onClick: needAuth(() => openDeposit()) },
    { icon: 'withdraw', label: 'Withdraw', onClick: needAuth(openWithdraw) },
    { icon: 'history', label: 'History', onClick: needAuth(() => setHistoryOpen(true)) },
    { icon: 'chat', label: 'Live Chat', onClick: () => setSupportOpen(true) },
    { icon: 'book', label: 'How to Trade', onClick: () => setHowToOpen(true) },
    { icon: 'user', label: 'Account', href: '/account' },
    { icon: 'shield', label: 'Legal', href: '/legal' },
  ];

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        {/* ── Desktop ── */}
        <div className="hidden h-[72px] items-center gap-2 px-4 lg:flex">
          <Link href="/" aria-label={`${brand.name} home`} className="shrink-0"><Wordmark text={wordmark} className="text-[19px]" /></Link>
          <Link href="/" aria-label="Trade" className="ml-4 grid h-10 w-10 place-items-center rounded-xl border border-accent/40 bg-accent/10 text-accent">
            <DIcon name="trend" className="h-5 w-5" />
          </Link>
          <Link href="/" className="ml-2 hidden whitespace-nowrap px-2 text-[14px] font-semibold text-fg xl:inline">Trader’s Hub</Link>
          <NavButton icon="deposit" label="Deposit" onClick={needAuth(() => openDeposit())} />
          <NavButton icon="withdraw" label="Withdraw" onClick={needAuth(openWithdraw)} />
          <NavButton icon="history" label="History" onClick={needAuth(() => setHistoryOpen(true))} />
          <NavButton icon="sparkles" label="AI" variant="accent" onClick={() => openScanner(true)} />
          <span className="relative"><NavButton icon="chat" label="Live Chat" variant="pill" onClick={() => setSupportOpen(true)} />{chatUnread ? <span data-badge="chat" className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-down px-1 text-[9px] font-bold text-white">{chatUnread}</span> : null}</span>
          <NavButton icon="book" label="How to Trade" variant="pill" onClick={() => setHowToOpen(true)} />

          <div className="ml-auto flex min-w-0 items-center gap-3">
            {authed ? (
              <>
                <div className="min-w-0"><AccountPill /></div>
                <button type="button" onClick={() => openDeposit()} className="h-10 shrink-0 whitespace-nowrap rounded-lg bg-accent px-5 text-[14px] font-semibold text-accent-fg shadow-[0_0_18px_-6px_var(--pp-accent)] transition hover:brightness-105">Deposit</button>
                <SoundToggle />
                <Bell />
                <AccountMenu />
              </>
            ) : (
              <>
                <button type="button" onClick={() => openAuth('login')} className="h-10 rounded-lg px-4 text-[14px] font-semibold text-muted hover:text-fg">Log in</button>
                <button type="button" onClick={() => openAuth('register')} className="h-10 rounded-lg bg-accent px-5 text-[14px] font-semibold text-accent-fg">Sign up</button>
              </>
            )}
          </div>
        </div>

        {/* ── Phone / tablet ── */}
        <div className="flex h-14 items-center gap-1.5 px-2 lg:hidden">
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-fg hover:bg-surface-2">
            <DIcon name="menu" className="h-5 w-5" />
          </button>
          {/* signed in on a narrow phone, the balance matters more than a clipped "Ta…" wordmark */}
          <Link href="/" aria-label={`${brand.name} home`} className={cn('min-w-0 truncate', authed && 'hidden min-[420px]:block')}><Wordmark text={wordmark} className="text-[15px]" /></Link>
          {/* the balance keeps its full width; the wordmark gives way on narrow phones */}
          {authed ? <div className="ml-1 shrink-0"><AccountPill compact /></div> : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {authed ? (
              <>
                {/* under 360px the speaker moves into the menu so Deposit and the bell stay visible */}
                <SoundToggle className="hidden h-9 w-9 min-[360px]:grid" />
                <button type="button" onClick={() => openDeposit()} className="h-9 rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg">Deposit</button>
                <Bell />
              </>
            ) : (
              <>
                <button type="button" onClick={() => openAuth('login')} className="h-9 rounded-lg px-2.5 text-[13px] font-semibold text-muted">Log in</button>
                <button type="button" onClick={() => openAuth('register')} className="h-9 rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-accent-fg">Sign up</button>
              </>
            )}
          </div>
        </div>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button aria-label="Close menu" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <nav className="relative flex h-full w-72 max-w-[80vw] flex-col border-r border-border bg-surface p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <Wordmark text={wordmark} className="text-[17px]" />
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
                <DIcon name="close" className="h-4 w-4" />
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {drawer.map((n) => {
                const cls = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-muted transition hover:bg-surface-2 hover:text-fg';
                const inner = <><DIcon name={n.icon} className="h-5 w-5" />{n.label}</>;
                return (
                  <li key={n.label}>
                    {n.href
                      ? <Link href={n.href} onClick={() => setMenuOpen(false)} className={cls}>{inner}</Link>
                      : <button type="button" onClick={() => { setMenuOpen(false); n.onClick?.(); }} className={cls}>{inner}</button>}
                  </li>
                );
              })}
              <li><SoundMenuRow /></li>
            </ul>
            <div className="mt-auto border-t border-border pt-3">
              {authed ? (
                <button type="button" onClick={() => { setMenuOpen(false); void logout(); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-down transition hover:bg-down/10">
                  <DIcon name="logout" className="h-5 w-5" />Sign out
                </button>
              ) : (
                <div className="flex gap-2">
                  <button type="button" onClick={() => { openAuth('login'); setMenuOpen(false); }} className="flex-1 rounded-lg border border-border py-2.5 text-sm font-semibold text-fg">Log in</button>
                  <button type="button" onClick={() => { openAuth('register'); setMenuOpen(false); }} className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-fg">Sign up</button>
                </div>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}

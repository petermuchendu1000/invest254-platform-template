'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNavDrawer } from '@/lib/ui/drawer';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useWallet, useWalletFigures } from '@/lib/wallet/hooks';
import { useBrand } from '@/lib/brand/BrandProvider';
import { mt5ServerName } from '@/lib/brand/mt5Server';
import { useDisplayMoney } from '@/lib/money';
import { useLiveChat } from '@/lib/chat/liveChat';
import { useLiveChatUnread } from '@/components/chat/LiveChatPanel';
import { MarketerLogoHotspot } from '@/components/marketer/MarketerHUD';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's side panel.
 *
 * This is how MetaTrader navigates: a hamburger in the title bar opens a panel headed by the account
 * — name, server, balance — over a list of destinations. It replaces the app's bottom nav on a
 * terminal brand, which is the point: the terminal already has a bar along the bottom (the Toolbox's
 * tabs), and two stacked bars cost a phone around 120px of the chart for one row of chrome.
 *
 * Every destination the bottom bar carried is here, so nothing became unreachable: Trade, History,
 * Funds, Settings and Chat, plus the session action. Scoped to terminal brands; every other shell
 * keeps its bottom nav and never mounts this.
 */

const ICON = 'h-[18px] w-[18px] shrink-0';

/** A channel: a speech bubble with lines, in the same stroke as the icons beside it. */
const CommunityIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.9-.9L3 20.5l1.7-4.9a8.1 8.1 0 0 1-1-3.9 8.4 8.4 0 0 1 8.5-8.2 8.4 8.4 0 0 1 8.8 8Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10h7M8.5 13.5h4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const TradeIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M3 12l4-4 4 4 6-6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M17 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const HistoryIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FundsIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18M16 15h2" strokeLinecap="round" />
  </svg>
);
const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.2 3H10.6l-.4 2.1a7.6 7.6 0 0 0-2.6 1.5l-2-.8L3.8 8.9l1.7 1.3a7.8 7.8 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.4 2.1h3.6l.4-2.1a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.3Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
/** An outward share: MetaTrader has no such screen, so this is the app's own, drawn to match. */
const InviteIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M16 11a4 4 0 100-8 4 4 0 000 8zM3 21v-1a6 6 0 016-6h2" />
    <path d="M19 14v6M16 17h6" />
  </svg>
);

/** A document with a folded corner: the licence, the terms and the risk statement live behind it. */
const LegalIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const SignOutIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M15 17l5-5-5-5M20 12H9M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function MT5Drawer() {
  const mt5 = useTerminalSkin();
  const open = useNavDrawer((s) => s.open);
  const setOpen = useNavDrawer((s) => s.setOpen);
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
  const { logout } = useAuthActions();
  const { data: wallet } = useWallet();
  /**
   * Which account this is, from the ONE rule (wallet/figures).
   *
   * Never `wallet.mode`: a marketer's account_mode is permanently 'demo' because their stakes spend
   * the demo bucket (migration 0084), while the money they are actually playing — and can withdraw —
   * is presented as their REAL account. Reading `mode` straight off the wallet therefore tagged
   * every marketer DEMO and named their server "<Brand>-Demo", on the one screen they hold up on a
   * live stream. `figures.demo` is `marketerPractice` for a marketer and `mode` for a player, which
   * is exactly the distinction the waves switcher has always made.
   */
  const figures = useWalletFigures();
  const brand = useBrand();
  const money = useDisplayMoney();
  const setChat = useLiveChat((s) => s.setOpen);
  const unread = useLiveChatUnread();

  // Escape closes, and the page behind must not scroll under the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, setOpen]);

  // A tap that navigates has done its job; leaving the panel open over the new screen has not.
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);

  if (!mt5 || !open) return null;

  const demo = figures.demo;
  const server = mt5ServerName(brand, demo ? 'demo' : 'real');
  const balanceCents = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);

  const close = () => setOpen(false);

  return (
    <>
      <button type="button" aria-label="Close menu" onClick={close} className="fixed inset-0 z-[70] bg-black/60" />
      <nav
        aria-label="Main menu"
        className="fixed bottom-0 left-0 top-0 z-[71] flex w-[82%] max-w-[320px] flex-col overflow-y-auto border-r border-[var(--mt5-border)] bg-[var(--mt5-surface)] text-[var(--mt5-text)] shadow-2xl"
      >
        {/* MetaTrader heads the panel with the account itself: who you are, which server, how much —
            and tapping it opens the account, which is also where the Real/Demo switch lives now that
            the title bar no longer carries the balance pill. */}
        {token && user ? (
          <Link href="/account" className="block bg-[var(--mt5-blue)] px-4 pb-3 pt-4 text-left">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">{user.username}</span>
              <span className="shrink-0 rounded-sm bg-white/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                {demo ? 'Demo' : 'Real'}
              </span>
            </div>
            {/* The covert marketer entry, on the one line of this card that is not a destination.
                It lives here because MetaTrader's phone shell has no brand logo to overlay: the
                app bar that used to carry it is hidden below `lg` on a terminal brand (see
                AppShell), since MetaTrader draws exactly one top bar and a second one above its
                chrome is not its screen. A corner-anchored hotspot was not an option either, as
                MarketerHUD's own note explains: it lands on the chart's hamburger.

                The server name is text, so nothing is taken from anyone: a player sees and reaches
                exactly what they did before, and a marketer's tap here opens the dashboard instead
                of the account. The username above it still opens the account for both. */}
            <div className="relative truncate text-[11px] leading-tight text-white/75">
              {server}
              <MarketerLogoHotspot />
            </div>
            <div className="mt-2 font-mono text-[20px] font-semibold leading-none tabular-nums">
              {money.fmt(balanceCents)}
            </div>
          </Link>
        ) : (
          <header className="bg-[var(--mt5-blue)] px-4 pb-3 pt-4">
            <div className="truncate text-[15px] font-semibold leading-tight">{brand.name || 'invest254'}</div>
            <div className="truncate text-[11px] leading-tight text-white/75">Not connected</div>
          </header>
        )}

        <div className="flex-1 py-1">
          <Row href="/" icon={<TradeIcon />} label="Trade" active={pathname === '/'} />
          <Row href="/history" icon={<HistoryIcon />} label="History" active={pathname.startsWith('/history')} />
          {/* The brand's channel (docs/56): announcements, questions and live sessions. */}
          <Row href="/community" icon={<CommunityIcon />} label="Community" active={pathname.startsWith('/community')} />
          <Row href="/wallet" icon={<FundsIcon />} label="Funds" active={pathname.startsWith('/wallet')} />
          <Row href="/account" icon={<SettingsIcon />} label="Settings" active={pathname.startsWith('/account')} />
          <Row
            onClick={() => { close(); setChat(true); }}
            icon={<ChatIcon />}
            label="Chat"
            badge={unread > 0 ? unread : undefined}
          />
        </div>

        <div className="border-t border-[var(--mt5-border)] py-1">
          {token ? (
            <Row onClick={() => { close(); logout(); }} icon={<SignOutIcon />} label="Log out" tone="bad" />
          ) : (
            <Row onClick={() => { close(); openAuth('login'); }} icon={<SignOutIcon />} label="Log in" />
          )}
        </div>
      </nav>
    </>
  );
}

function Row({
  href, onClick, icon, label, active, badge, tone,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean | undefined;
  badge?: number | undefined;
  tone?: 'bad' | undefined;
}) {
  const className = cn(
    // 44px tall: MetaTrader's rows are compact, but a tap target below the Apple minimum is a worse
    // phone screen than a faithful one.
    'flex w-full items-center gap-3 px-4 py-3 text-left text-[14px]',
    active ? 'bg-[var(--mt5-raised)] text-[var(--mt5-blue-link)]' : tone === 'bad' ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-text)]',
  );
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--mt5-red)] px-1 text-[10px] font-bold text-white">
          {badge}
        </span>
      ) : null}
    </>
  );
  if (href) return <Link href={href} className={className}>{body}</Link>;
  return <button type="button" onClick={onClick} className={className}>{body}</button>;
}

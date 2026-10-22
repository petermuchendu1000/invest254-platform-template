'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useNavDrawer } from '@/lib/ui/drawer';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useWallet } from '@/lib/wallet/hooks';
import { useDisplayMoney } from '@/lib/money';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useCandlestickUi } from '@/components/game/candlestick/ui';

/**
 * The candlestick screen's menu — the SIMPLE shell's navigation, not the terminal's.
 *
 * Why this exists at all, so nobody "restores" what it replaced: the candlestick shell used to open
 * `MT5Drawer` from its hamburger. That panel is the BROKER product's navigation — it is headed by a
 * MetaTrader account card with a server name, it paints from the `--mt5-*` tokens, and its rows are
 * Trade / History / Community / Funds / Settings. That vocabulary is aimed at someone who already
 * knows what a server and a funds ledger are. This screen is aimed at the opposite player: the
 * line-graph audience, who are served by `BottomNav`'s four plain words — TRADE / DEPOSIT / HISTORY
 * / PROFILE. Putting MetaTrader's panel behind this screen's hamburger handed the simple player the
 * serious product's menu, which is the one thing this shell must not do.
 *
 * Why a sheet and not `BottomNav` itself: the screen already owns a phone tab bar — TRADE / CHAT /
 * TOP / TOURS, from the reference design (`CandlestickTradeScreen`). Mounting `BottomNav` under it
 * would stack a second row of tabs beneath the mock's own four, which is exactly what AppShell's
 * note says this shell exists to avoid. Nor do these destinations fit in the header: at 320px that
 * bar is already carrying the wordmark, the Real/Demo badge, the balance, Deposit and this menu, and
 * five more controls there would be a scroll, not a navigation. A sheet behind the hamburger that is
 * ALREADY in the header costs no screen at rest, and takes the classic shell's own words with it.
 *
 * Deliberately NOT here:
 *  - Chat. The screen carries it as a tab (phone) and a rail pane (desktop), and `LiveChatPanel` is
 *    not even mounted in this shell, so a "Chat" row would have opened nothing.
 *  - "Funds" / "Settings" / "Community" / a server name / an account card. Broker words and broker
 *    chrome; see above.
 *
 * It is mounted only by AppShell's candlestick branch, so it needs no brand gate of its own, and it
 * shares `useNavDrawer` with the terminal's drawer — one shell mounts one of them, never both.
 */
export function CandlestickNavSheet() {
  const open = useNavDrawer((s) => s.open);
  const setOpen = useNavDrawer((s) => s.setOpen);
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const { data: wallet } = useWallet();
  const { fmt } = useDisplayMoney();
  const openAuth = useAuthUi((s) => s.openAuth);
  const { logout } = useAuthActions();
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const setHowTo = useCandlestickUi((st) => st.setHowTo);

  // Escape closes, and the page behind must not scroll under the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, setOpen]);

  // A tap that navigates has done its job; leaving the sheet open over the new screen has not.
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);

  if (!open) return null;

  const authed = !!token;
  const close = () => setOpen(false);
  const balance = fmt((wallet?.real ?? 0) + (wallet?.bonus ?? 0));
  // Signed out, a money control asks for the login first — the same rule the header applies.
  const needAuth = (fn: () => void) => { if (authed) fn(); else openAuth('login'); };

  return (
    <>
      <button type="button" aria-label="Close menu" onClick={close} className="fixed inset-0 z-[70] bg-black/60" /* brand-token-exempt: scrim, see HowToModal — dims the page behind the sheet rather than painting a themed surface */ />
      {/* The BRAND's palette, through the semantic utilities the rest of this screen now uses
          (`bg-surface` on the page's `bg`, `border-border` rules, `accent` highlights — i.e.
          `--pp-bg` / `--pp-surface` / `--pp-border` / `--pp-accent`, which each site fills from its
          own `sites.color_*`), so this sheet wears the brand it is serving instead of one mock's
          greens — never `--mt5-*`: those tokens ARE the broker terminal's identity. */}
      <nav
        aria-label="Menu"
        className="fixed bottom-0 right-0 top-0 z-[71] flex w-[80%] max-w-[300px] flex-col overflow-y-auto border-l border-border bg-surface text-fg shadow-2xl"
      >
        {/* Who you are and how much you have — two plain lines, not an account card: no server, no
            login type, nothing to decode. The balance repeats the header's on purpose; this is the
            one place a signed-out player is told there is nothing there yet. */}
        <header className="border-b border-border px-4 pb-3 pt-4">
          {authed ? (
            <>
              <div className="truncate text-sm font-semibold leading-tight">{user?.username ?? 'Account'}</div>
              <div className="mt-1 truncate text-lg font-bold leading-none text-accent">{balance}</div>
            </>
          ) : (
            <>
              <div className="truncate text-sm font-semibold leading-tight">Welcome</div>
              <div className="mt-1 text-xs leading-tight text-muted">Sign in to trade</div>
            </>
          )}
        </header>

        <div className="flex-1 py-1">
          {/* The classic shell's four, in the classic shell's words and its flat glyphs. */}
          <Row href="/" icon={<TradeIcon />} label="Trade" active={pathname === '/'} />
          {/* Deposit and Withdraw open the SHEETS, not /wallet: the top bar's Deposit button already
              means "open the deposit sheet", and two controls with one word must not go to two
              different places. Withdraw is here because the header hides it below `sm` — on a phone
              this is its only way in. */}
          <Row onClick={() => { close(); needAuth(openDeposit); }} icon={<DepositIcon />} label="Deposit" />
          <Row onClick={() => { close(); needAuth(openWithdraw); }} icon={<WithdrawIcon />} label="Withdraw" />
          <Row href="/history" icon={<HistoryIcon />} label="History" active={pathname.startsWith('/history')} />
          <Row href="/account" icon={<ProfileIcon />} label="Profile" active={pathname.startsWith('/account')} />
          {/* The how-to sheet's ONLY opener in this shell.
            *
            * AppShell mounts `HowToModal` in the candlestick branch and nowhere else, and the only
            * other opener there has ever been was a row in the terminal drawer this sheet replaces
            * (and before that a bare "?" in the header). If this row goes, the sheet is mounted and
            * unreachable — which is the trap that put the row in the drawer in the first place. */}
          <Row onClick={() => { close(); setHowTo(true); }} icon={<HowToIcon />} label="How to trade" />
        </div>

        <div className="border-t border-border py-1">
          {authed ? (
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
  href, onClick, icon, label, active, tone,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean | undefined;
  tone?: 'bad' | undefined;
}) {
  // 48px tall: this audience is thumbing a phone, and the rows are few enough that there is no
  // reason to pack them the way a terminal's panel does.
  const className = cn(
    'flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] font-medium transition-colors',
    active
      ? 'bg-accent/10 text-accent'
      : tone === 'bad'
        ? 'text-down hover:bg-fg/5'
        : 'text-fg hover:bg-fg/5',
  );
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );
  if (href) return <Link href={href} className={className} aria-current={active ? 'page' : undefined}>{body}</Link>;
  return <button type="button" onClick={onClick} className={className}>{body}</button>;
}

/**
 * The classic shell's glyphs, redrawn here rather than imported: `BottomNav` keeps its icons
 * file-local, and copying four paths is a smaller change than exporting them out of a file another
 * agent owns. Same shapes, so the two shells read as one family.
 */
const ICON = 'h-5 w-5 shrink-0';
const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={ICON} aria-hidden>
    {children}
  </svg>
);

const TradeIcon = () => svg(
  <>
    <path d="M3 12l4-4 4 4 6-6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M17 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);
const DepositIcon = () => svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);
/** Money leaving: the deposit coin with a downward arrow out of it. */
const WithdrawIcon = () => svg(
  <>
    <path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5" strokeLinecap="round" />
    <path d="M12 7.5v9M8.5 13l3.5 3.5L15.5 13" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);
const HistoryIcon = () => svg(
  <>
    <rect x="4" y="13" width="3.5" height="7" rx="1" />
    <rect x="10.25" y="8" width="3.5" height="12" rx="1" />
    <rect x="16.5" y="4" width="3.5" height="16" rx="1" />
  </>,
);
const ProfileIcon = () => svg(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0116 0" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);
const HowToIcon = () => svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 16.8h.01" strokeLinecap="round" />
  </>,
);
const SignOutIcon = () => svg(
  <path d="M15 17l5-5-5-5M20 12H9M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" strokeLinecap="round" strokeLinejoin="round" />,
);


'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useLiveChat } from '@/lib/chat/liveChat';
import { useLiveChatUnread } from '@/components/chat/LiveChatPanel';
import { DIcon } from '@/components/game/digits/icons';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { useBrokerTerminalBrand } from '@/lib/ui/useBrandShell';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';

type IconProps = { className?: string };

function TradeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <path d="M3 12l4-4 4 4 6-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** MARKETER: a neutral play glyph in place of the up-trending "trade" chart icon. */
function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function DepositIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function HistoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <rect x="4" y="13" width="3.5" height="7" rx="1" />
      <rect x="10.25" y="8" width="3.5" height="12" rx="1" />
      <rect x="16.5" y="4" width="3.5" height="16" rx="1" />
    </svg>
  );
}
function ProfileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0116 0" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const items = [
  { href: '/', label: 'TRADE', Icon: TradeIcon },
  { href: '/wallet', label: 'DEPOSIT', Icon: DepositIcon },
  { href: '/history', label: 'HISTORY', Icon: HistoryIcon },
  { href: '/account', label: 'PROFILE', Icon: ProfileIcon },
] as const;
// MARKETER: "TRADE" + up-trend chart icon → "PLAY" + play glyph; "DEPOSIT" → neutral "WALLET".
const marketerItems = [
  { href: '/', label: 'PLAY', Icon: PlayIcon },
  { href: '/wallet', label: 'WALLET', Icon: DepositIcon },
  { href: '/history', label: 'HISTORY', Icon: HistoryIcon },
  { href: '/account', label: 'PROFILE', Icon: ProfileIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { isMarketer } = useMarketerSkin();
  /**
   * A terminal brand has NO bottom nav.
   *
   * The terminal already ends in a bar: the Toolbox's own tabs. Stacking the app's nav under it put
   * two rows of chrome along the bottom of a phone — about 120px, on the screen where the chart
   * matters most. MetaTrader navigates from the side panel instead, so that is where these
   * destinations went (MT5Drawer): Trade, History, Funds, Settings and Chat are all there, so
   * nothing became unreachable.
   *
   * Every other shell keeps this bar.
   */
  const mt5 = useBrokerTerminalBrand() && !isMarketer;
  const setChat = useLiveChat((s) => s.setOpen);
  // Every hook BEFORE the early return. React matches hooks by call order, so a hook after it is
  // called on some renders and not others, and a brand that switched shells mid-session would hand
  // this component another hook's state.
  const unread = useLiveChatUnread();
  if (mt5) return null;
  return (
    <nav className={cn(
      'pb-safe fixed inset-x-0 bottom-0 z-30 border-t md:hidden',
      mt5 ? 'border-[var(--mt5-border)] bg-[var(--mt5-surface)]' : 'border-border bg-surface',
    )}>
      <ul className={cn('mx-auto flex w-full items-stretch px-2 py-1.5', mt5 ? '' : 'max-w-app')}>
        {(isMarketer ? marketerItems : items).map(({ href, label, Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'mx-auto flex flex-col items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold tracking-wide transition',
                  mt5
                    ? (active ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-muted)] hover:text-[#ffffff]')
                    : (active ? 'bg-accent text-accent-fg shadow-md shadow-accent/40' : 'text-muted hover:text-fg'),
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
              </Link>
            </li>
          );
        })}
        {/* Chat lives in the bar on phones (BUGLOG #100: the floating button covered SELL). */}
        <li className="flex-1">
          <button type="button" onClick={() => setChat(true)} aria-label={`Chat${unread ? ` (${unread} new)` : ''}`}
            className={cn(
              'relative mx-auto flex w-full flex-col items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold tracking-wide transition',
              mt5 ? 'text-[var(--mt5-muted)] hover:text-[#ffffff]' : 'text-muted hover:text-fg',
            )}>
            <DIcon name="chat" className="h-5 w-5" />
            CHAT
            {unread ? <span className="absolute right-[22%] top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-down px-1 text-[9px] font-bold text-white">{unread}</span> : null}
          </button>
        </li>
      </ul>
    </nav>
  );
}

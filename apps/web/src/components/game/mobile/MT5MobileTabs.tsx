'use client';

import { MOBILE_TABS, useMobileTabStore, type MobileTab } from '@/lib/game/mobileTab';
import { cn } from '@/lib/cn';

/**
 * MetaTrader mobile's bottom tab bar: five tabs, and these five.
 *
 * Android's set, which is `Quotes · Charts · Trade · History · Messages` (iOS ends with Settings
 * instead and spells the second tab "Chart"). The reasoning for picking Android's is in
 * lib/game/mobileTab: this shell also has the drawer only Android has, and Settings lives in it.
 *
 * The icons are drawn from the descriptions in docs/mt5/04-mobile-app.md section 1, which were
 * taken off MetaQuotes' own current screenshots glyph by glyph:
 *
 *   Quotes    an up-arrow and a down-arrow side by side (Android's order is ↑↓, iOS's ↓↑)
 *   Charts    two vertical candlesticks
 *   Trade     a polyline with round nodes, and NO enclosing square (iOS's has one)
 *   History   a clock face with a counter-clockwise arrow
 *   Messages  two overlapping speech bubbles, with a red unread badge
 *
 * "Active tab: icon and label turn blue. Inactive: dark grey/near-black." MetaTrader's phone app is
 * a light theme, so near-black is its muted colour against white; this terminal is MetaTrader's own
 * dark scheme, so the inactive state is this window's muted foreground instead. Painting it
 * near-black on #0f1720 would have made four of the five tabs invisible.
 */
type IconProps = { className?: string };

function QuotesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M8 20V5M8 5L4.5 8.5M8 5l3.5 3.5" />
      <path d="M16 4v15M16 19l3.5-3.5M16 19l-3.5-3.5" />
    </svg>
  );
}

function ChartsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
      {/* Two candlesticks: a body with a wick out of each end, which is the glyph MetaQuotes uses. */}
      <path d="M8 3v3M8 18v3" />
      <rect x="5.5" y="6" width="5" height="12" rx="1" strokeWidth="2" />
      <path d="M16 5v2M16 15v4" />
      <rect x="13.5" y="7" width="5" height="8" rx="1" strokeWidth="2" />
    </svg>
  );
}

function TradeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {/* The polyline, then its nodes. No enclosing square: that is the iOS icon, not Android's. */}
      <path d="M4 16l5-5 4 3 7-8" />
      <circle cx="4" cy="16" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="9" cy="11" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="13" cy="14" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="6" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HistoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {/* Counter-clockwise: the arrowhead sits on the LEFT of the arc, which is what makes this a
          history icon rather than a refresh one. */}
      <path d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 004.8 7.6" />
      <path d="M3.2 3.6v4.2h4.2" />
      <path d="M12 7.5V12l3.2 2" />
    </svg>
  );
}

function MessagesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {/* Two overlapping bubbles. The back one is drawn first so the front one reads as nearer. */}
      <path d="M8.5 14.5H6.5l-2.5 2.2V8.2A2.2 2.2 0 016.2 6h8.1a2.2 2.2 0 012.2 2.2v1" />
      <path d="M20 19.8l-2.1-1.9h-5.4a2 2 0 01-2-2v-3.4a2 2 0 012-2h5.5a2 2 0 012 2v7.3z" />
    </svg>
  );
}

const ICONS: Record<MobileTab, (p: IconProps) => React.JSX.Element> = {
  quotes: QuotesIcon,
  charts: ChartsIcon,
  trade: TradeIcon,
  history: HistoryIcon,
  messages: MessagesIcon,
};

export function MT5MobileTabs({ unread = 0 }: { unread?: number }) {
  const tab = useMobileTabStore((s) => s.tab);
  const set = useMobileTabStore((s) => s.set);

  return (
    <nav
      aria-label="MetaTrader tabs"
      /**
       * In the flow, not fixed.
       *
       * The trade screen is a viewport-locked column (`h-dvh`, `overflow-hidden` on the shell), so
       * a bar in the flow is already pinned to the bottom of the screen and cannot be scrolled
       * away from. A `fixed` bar would have needed the screen above it to reserve its height by
       * hand, and that reservation getting out of step with the bar's real height is exactly how
       * the old layout came to clip its own content.
       */
      className="shrink-0 border-t border-[var(--mt5-border)] bg-[var(--mt5-surface)] pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex items-stretch">
        {MOBILE_TABS.map(({ id, label }) => {
          const Icon = ICONS[id];
          const active = tab === id;
          return (
            <li key={id} className="flex-1">
              <button
                type="button"
                onClick={() => set(id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // 56px is the Material bottom-bar height Android's own bar uses, and it keeps the
                  // whole target above the 48px minimum with the label inside it.
                  'relative flex h-14 w-full flex-col items-center justify-center gap-1 text-[10px] font-medium transition',
                  active ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-muted)]',
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
                {id === 'messages' && unread > 0 ? (
                  // "a red unread badge" — MetaTrader's own, on the Messages tab on Android.
                  <span
                    aria-label={`${unread} unread`}
                    className="absolute left-1/2 top-1.5 ml-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--mt5-red)] px-1 text-[9px] font-bold text-white"
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

'use client';

import { AuthButtons } from '@/components/auth/AuthButtons';
import { AccountSwitcher } from '@/components/wallet/AccountSwitcher';
import { Logo } from '@/components/layout/Logo';
import { MarketerLogoHotspot } from '@/components/marketer/MarketerHUD';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { useNavDrawer } from '@/lib/ui/drawer';
import { useFullScreenStore } from '@/lib/ui/fullscreen';
import { isTerminalRoute } from '@/lib/ui/terminalScreen';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export function TopBar() {
  const brand = useBrand();
  /**
   * MetaTrader's window title bar: a solid BLUE band, a hamburger at the left that opens the side
   * panel, the name, and the screen's own controls at the right. The hamburger is not decoration —
   * on a terminal brand it is the whole of the app's navigation, because the bottom nav is gone
   * (see MT5Drawer, and BottomNav).
   *
   * Scoped to candlestick brands, and never on a marketer screen, where a trading-terminal title bar
   * would undo the neutralisation. Every other shell keeps the standard header.
   */
  const terminal = useTerminalSkin();
  const toggleDrawer = useNavDrawer((s) => s.toggle);
  /**
   * Gone in MetaTrader's full-screen, which a phone turned sideways enters by itself.
   *
   * This bar is 49px, and on a 360px-tall landscape phone that is 14% of the screen given to a
   * logo. Hiding the tab bar alone left the chart 164px of 360; full-screen has to mean the app's
   * chrome, or it means very little. The chart's own bar carries the way back (see MT5MobileShell).
   */
  const fullScreen = useFullScreenStore((s) => s.on);
  /**
   * On a phone, the MetaTrader screen the route renders IS this bar.
   *
   * MetaTrader's phone has one bar across the top, and the hamburger is inside it: *"Top bar is
   * `☰ | Quotes | ＋ | ✎`"*, *"Android: `☰` | title "Trade" … | sort button | new-order button"*
   * (docs/mt5/04-mobile-app.md sections 2 and 4). Stacking this bar, the screen's own title band and
   * the account panel's header gave /account THREE full-width blue bars on a 360px phone.
   *
   * So below `lg` the screen's bar carries the hamburger (MT5TitleBar) and this one is not drawn.
   * Hidden in CSS rather than unmounted: it is the same tree at both widths, and a JS width check
   * would paint the bar and then take it away on mount. Above `lg` both bars stay, which is
   * MetaTrader's desktop — a window title bar with the screen's own bar beneath it.
   *
   * Not `useFullScreenStore`: that flag means MetaTrader's landscape full-screen chart, declared in
   * an effect by whatever is mounted. A route's chrome must be decided in the first paint, and the
   * two must be able to be true at once without either releasing the other's bar.
   */
  const pathname = usePathname();
  const screenOwnsBar = terminal && isTerminalRoute(pathname);
  if (fullScreen) return null;

  return (
    <header
      className={cn(
        'sticky top-0 z-30 border-b',
        terminal ? 'border-[var(--mt5-border)] bg-[var(--mt5-blue)]' : 'border-border bg-surface/90 backdrop-blur',
        screenOwnsBar && 'hidden lg:block',
      )}
    >
      <div
        className={cn(
          'flex w-full items-center',
          // Tighter on the terminal: the bar is chrome, and every row of a phone screen it does not
          // take is a row the chart does.
          terminal ? 'h-12 gap-2 px-2' : 'mx-auto h-14 max-w-app gap-1.5 px-3 sm:gap-2 sm:px-4',
        )}
      >
        {terminal ? (
          <button
            type="button"
            onClick={toggleDrawer}
            aria-label="Open menu"
            className="-ml-0.5 grid h-10 w-10 shrink-0 place-items-center rounded text-white transition hover:bg-white/20"
          >
            <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        ) : null}

        {/*
          The brand lockup STAYS. MetaTrader has no wordmark because MetaTrader is the brand; here the
          operator is, and a title bar that names nobody would be a worse screen, not a more faithful
          one. On the blue band it renders in white, as MetaTrader's own title text does.
        */}
        {/* `relative` so the marketer's covert entry can overlay the logo exactly (MarketerHUD).
            It used to be anchored to the screen's top-left corner, which is where the hamburger now
            is — so a marketer could not open the menu at all. */}
        <div className={cn('relative min-w-0', terminal && '[&_*]:!text-white')}>
          <Logo />
          <MarketerLogoHotspot />
        </div>

        <div className={cn('ml-auto flex items-center', terminal ? 'gap-1' : 'gap-1.5 sm:gap-2', terminal && 'text-white')}>
          {/*
            DEMO-3: the balance pill is the Real/Demo switcher (it used to open the Withdraw tab,
            which on a Demo account offered a way out of play money).
            On the terminal it is NOT here: MetaTrader's title bar carries the screen, not the
            money, and at 390px a hamburger plus a wordmark plus a dark balance pill plus an avatar
            truncated the brand name to "invest254....". The balance moved to the side panel's
            header, where MetaTrader puts it, and the Real/Demo switch is one tap further on the
            account panel the header links to.
          */}
          {terminal ? null : <AccountSwitcher />}
          <AuthButtons />
        </div>
      </div>
    </header>
  );
}

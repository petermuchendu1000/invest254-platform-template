'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { chartStyleOf, tradingViewTypeOf } from '@invest254/shared/chart';
import { cn } from '@/lib/cn';
import { TopBar } from '@/components/layout/TopBar';
import { BottomNav } from '@/components/layout/BottomNav';
import { DigitsTopBar } from '@/components/layout/DigitsTopBar';
import { DigitsBottomNav } from '@/components/layout/DigitsBottomNav';
import { PositionsSheet } from '@/components/game/digits/PositionsSheet';
import { TransactionHistoryModal } from '@/components/game/digits/TransactionHistoryModal';
import { HowToTradeModal } from '@/components/game/digits/HowToTradeModal';
import { LiveChatPanel, LiveChatLauncher } from '@/components/chat/LiveChatPanel';
import { AccountDialogs } from '@/components/account/AccountDialogs';
import { Footer } from '@/components/layout/Footer';
import { AuthModal } from '@/components/auth/AuthModal';
import { WalletModal } from '@/components/wallet/WalletModal';
import { SessionBootstrap } from '@/components/auth/SessionBootstrap';
import { NotificationBanners } from '@/components/notifications/NotificationBanners';
import { RegisterSW } from '@/components/RegisterSW';
import { MarketerHUD } from '@/components/marketer/MarketerHUD';
import { MT5Drawer } from '@/components/layout/MT5Drawer';
import { CandlestickTopBar } from '@/components/layout/CandlestickTopBar';
import { CandlestickNavSheet } from '@/components/layout/CandlestickNavSheet';
import { HowToModal } from '@/components/game/candlestick/HowToModal';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { isTerminalScreen, isTerminalRoute, terminalScreenTitle, isBrokerTerminalBrand } from '@/lib/ui/terminalScreen';
import { resolveTradeUi, useTradeUiOverride } from '@/lib/ui/tradeUi';
import { MT5Screen } from '@/components/mt5/kit';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const brand = useBrand();
  const { isMarketer } = useMarketerSkin();
  /** The same answer the screen resolves, from the same place — see lib/ui/tradeUi. */
  const tradeUi = resolveTradeUi(useTradeUiOverride(), brand.tradeUi);

  // The admin console + platform console provide their own chrome (sidebar). Suppress the player
  // top bar / bottom nav / footer there, but keep session bootstrap + SW.
  if (pathname?.startsWith('/admin') || pathname?.startsWith('/platform') || pathname?.startsWith('/console')) {
    return (
      <>
        {children}
        <SessionBootstrap />
        <RegisterSW />
      </>
    );
  }

  // The trade screen is an app-like, single-viewport surface: it must never
  // page-scroll on mobile and the chart must flex-fill the space between the
  // header and the trade console. We lock the frame to the viewport height and
  // drop the marketing footer + spacer here (legal lives in Profile/Legal).
  const isTrade = pathname === '/';

  // Digits-brand trade surface (trade_ui = 'digits'): the mock's app-like shell — a digits top bar
  // (hamburger nav drawer + wordmark + balance + Deposit) and a Live Chat / AI / Positions bottom
  // nav. Scoped to digits brands only; every other brand keeps the standard TopBar/BottomNav below.
  /**
   * Candlestick-brand trade surface (trade_ui = 'candlestick'): the mock's shell — its own header
   * and nothing else around the screen. The screen itself carries the rail and, on a phone, the tab
   * bar, so there is no bottom nav here: a second row of tabs under the mock's own four would be
   * two navigations stacked.
   *
   * Everything a control in that header opens is mounted here, exactly as the digits shell mounts
   * its own: the deposit and withdraw sheets (WalletModal), the auth modal, the nav sheet and the
   * account dialogs. The How to sheet is this screen's own.
   *
   * The menu is `CandlestickNavSheet`, NOT `MT5Drawer` — do not swap it back. MT5Drawer is the
   * BROKER product's navigation: a MetaTrader account card with a server name, the `--mt5-*`
   * palette, and rows reading Funds / Settings / Community. This screen is the line-graph shell's
   * audience, who are served by the classic `BottomNav`'s plain words, so its menu carries those
   * instead (Trade / Deposit / Withdraw / History / Profile, plus How to trade and the session
   * action) in this screen's own palette. See that file's header for why it is a sheet rather than
   * `BottomNav` — the screen's own four tabs are the only tab row this shell may have.
   */
  if (isTrade && tradeUi === 'candlestick') {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[#0a0f1c]">
        <CandlestickTopBar />
        <NotificationBanners />
        <main className="relative flex w-full min-h-0 flex-1 flex-col">{children}</main>
        <HowToModal />
        <AccountDialogs />
        <SessionBootstrap />
        <AuthModal />
        <WalletModal />
        <RegisterSW />
        <MarketerHUD />
        <CandlestickNavSheet />
      </div>
    );
  }

  if (isTrade && tradeUi === 'digits') {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <DigitsTopBar />
        <NotificationBanners />
        <main className="relative flex w-full min-h-0 flex-1 flex-col px-2 pb-[calc(5.25rem+env(safe-area-inset-bottom))] pt-2 sm:px-3 lg:p-0">
          {children}
        </main>
        <DigitsBottomNav />
        <PositionsSheet />
        <TransactionHistoryModal />
        <HowToTradeModal />
        <LiveChatPanel />
        <AccountDialogs />
        <SessionBootstrap />
        <AuthModal />
        <WalletModal />
        <RegisterSW />
        {/* The covert marketer entry as a corner hotspot. Only the digits shell needs it:
            every other shell gets it overlaid on the logo by TopBar, which the digits
            wordmark cannot carry because it is hidden outright on a narrow phone. */}
        <MarketerHUD />
        <MT5Drawer />
      </div>
    );
  }

  if (isTrade) {
    // A candlestick brand is a TERMINAL: on a wide screen it fills the viewport the way MetaTrader
    // does, rather than sitting in the centred reading column the rest of the site uses. Below `lg`
    // both are the same single mobile-first column.
    const terminal = isBrokerTerminalBrand(tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null);
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        {/**
          * MetaTrader's phone draws ONE top bar, and below `lg` this shell is MetaTrader's phone.
          *
          * The app bar sat above MT5MobileShell's own chrome, so every phone screen carried two
          * stacked bars: the brand's blue lockup and then MetaTrader's. That is 56px of a phone
          * screen spent on a second bar MetaTrader does not have, and it is the most visible way
          * the terminal stopped looking like the terminal.
          *
          * Hidden rather than unmounted, so nothing it carries is lost at a width where it IS
          * MetaTrader's bar: from `lg` up this is the desktop terminal, whose title bar is the app
          * bar. What the phone would otherwise lose is reached through the drawer, which is
          * MetaTrader's own answer to the same question -- the account, the balance, Funds,
          * Settings, Chat and the session action are all rows in it, and the covert marketer entry
          * moved onto its account card (MT5Drawer).
          */}
        {/* A wrapper rather than `display: contents` on the header itself: `contents` and the
            `hidden` that has to override it are the same property, and which one wins would come
            down to stylesheet order. A box that is simply not displayed cannot be ambiguous. */}
        <div className={cn('shrink-0', terminal ? 'hidden lg:block' : '')}>
          <TopBar />
        </div>
        <NotificationBanners />
        <main className={cn(
          'relative flex w-full min-h-0 flex-1 flex-col',
          // A terminal brand has no bottom nav (MT5Drawer replaces it), so nothing is reserved for
          // one — and the gutters tighten, because this is the screen the chart lives on.
          //
          // Below `lg` a terminal brand renders MetaTrader's PHONE app (MT5MobileShell): five tabs
          // with one full-screen view, which carries its own gutters, its own tab bar and its own
          // safe-area inset. Any padding here would be a frame around a screen that is meant to go
          // edge to edge, and the top padding alone was a visible band above MetaTrader's own chart
          // bar. The desktop gutters start at the same `lg` the phone shell stops at, so the two
          // cannot both apply.
          terminal
            ? 'px-0 pb-[env(safe-area-inset-bottom)] lg:px-3 lg:pb-4 lg:pt-2 xl:px-4'
            : 'mx-auto max-w-app px-3 pb-[calc(4.75rem+env(safe-area-inset-bottom))] pt-2 md:px-4 md:pb-4',
        )}>
          {children}
        </main>
        <BottomNav />
        <SessionBootstrap />
        <AuthModal />
        <WalletModal />
        <RegisterSW />
        <LiveChatLauncher />
        <LiveChatPanel />
        <AccountDialogs />
        <MT5Drawer />
      </div>
    );
  }

  // A MetaTrader screen off the trade surface (History today) is still a terminal screen: it fills
  // the window edge to edge, draws its own blue title bar flush under the app bar, and ends at the
  // toolbar — so no centred reading column, no page padding, and no marketing footer under it.
  if (isTerminalScreen(isBrokerTerminalBrand(tradeUi, tradingViewTypeOf(chartStyleOf(brand.chartStyle)) !== null), isMarketer) && isTerminalRoute(pathname)) {
    const shellTitle = terminalScreenTitle(pathname);
    return (
      /**
       * MetaTrader's palette for the WHOLE screen, applied once here.
       *
       * Every component in this app paints from `--pp-*`, so re-pointing those tokens on the
       * container is what puts a page on the terminal brand — see lib/ui/mt5Tokens. Doing it at the
       * shell rather than page by page is the only way this stays true: there are a dozen
       * player-facing routes and they were each either remembering to wrap themselves or quietly
       * rendering in the house style, with a blue MetaTrader bar sitting on top of it.
       *
       * It also squares the corners (`--pp-radius: 2px`), which is most of what made the shared
       * `Card`, `Button` and `Input` read as a consumer app inside a terminal.
       */
      <div className="flex min-h-dvh flex-col bg-[var(--mt5-surface)]" style={MT5_TOKENS}>
        {/* The same one-bar rule as the trade surface above, for the same reason: below `lg` this
            is MetaTrader's phone, and every screen here already carries a MetaTrader title bar --
            its own, or the one `MT5Screen` gives it -- with a way back in the place MetaTrader puts
            one. The brand's app bar above that was a second bar on a sub-screen that MetaTrader
            draws with one. From `lg` up it is the desktop terminal's title bar and stays. */}
        <div className="hidden shrink-0 lg:block">
          <TopBar />
        </div>
        <NotificationBanners />
        <main className="flex w-full flex-1 flex-col pb-[env(safe-area-inset-bottom)] md:pb-4">
          {/* A page that draws its own MetaTrader bar keeps it; one that does not is given one,
              with a way back and a reading column. Before this they were bare pages in a shell
              with no gutters, so the heading sat against the window edge with nothing above it. */}
          {shellTitle === null ? children : (
            <MT5Screen title={shellTitle}>
              <div className="mx-auto w-full max-w-app px-3 py-3 md:px-4">{children}</div>
            </MT5Screen>
          )}
        </main>
        <BottomNav />
        <SessionBootstrap />
        <AuthModal />
        <WalletModal />
        <RegisterSW />
        <LiveChatLauncher />
        <LiveChatPanel />
        <AccountDialogs />
        <MT5Drawer />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <NotificationBanners />
      <main className="mx-auto w-full max-w-app flex-1 px-4 py-4">{children}</main>
      <Footer />
      {/* Spacer so the fixed mobile BottomNav never covers footer content. */}
      <div aria-hidden className="h-20 md:hidden" />
      <BottomNav />
      <SessionBootstrap />
      <AuthModal />
      <WalletModal />
      <RegisterSW />
      <LiveChatLauncher />
      <LiveChatPanel />
        <AccountDialogs />
      <MT5Drawer />
    </div>
  );
}

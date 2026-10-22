'use client';

import { useEffect, useState } from 'react';
import { GameCurve } from '@/components/game/GameCurve';
import { MarketWatch } from '@/components/game/MarketWatch';
import { MT5History } from '@/components/history/MT5History';
import { MT5MobileOrder } from '@/components/game/mobile/MT5MobileOrder';
import { MT5TradeDialog } from '@/components/game/mobile/MT5TradeDialog';
import { MT5MobileTabs } from '@/components/game/mobile/MT5MobileTabs';
import { MT5MobileTrade } from '@/components/game/mobile/MT5MobileTrade';
import { MT5MobileMessages } from '@/components/game/mobile/MT5MobileMessages';
import { MT5OneClickPanel } from '@/components/game/mobile/MT5OneClickPanel';
import { useMobileTabStore, useRestoreMobileTab, type MobileTab } from '@/lib/game/mobileTab';
import { useOneClickStore, useRestoreOneClick } from '@/lib/game/oneClick';
import { useRestoreLevels } from '@/lib/game/levelsStore';
import { useOrderEntry } from '@/lib/game/useOrderEntry';
import { useNewOrderStore } from '@/lib/game/newOrder';
import { useIsLandscape } from '@/lib/ui/useIsPhone';
import { useDeclareFullScreen } from '@/lib/ui/fullscreen';

/**
 * MetaTrader's phone app, as a shell.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────────
 * The terminal's desktop layout — Market Watch docked left, chart and Toolbox in the middle, order
 * ticket docked right — was being rendered on a phone as one tall column. Measured at 360×800 the
 * chart got 168 of those 800 pixels, the order ticket took about 60% of the screen, and the page
 * did not scroll, so whatever did not fit was simply unreachable.
 *
 * MetaTrader's answer to a phone is not a narrower desktop. It is five tabs with ONE full-screen
 * view at a time, and that is what this is. The tab set, its labels and its order are Android's:
 * Quotes · Charts · Trade · History · Messages (docs/mt5/04-mobile-app.md section 1).
 *
 * ── One tree, not two ────────────────────────────────────────────────────────────────────────────
 * The phone shell and the desktop layout are chosen in JavaScript (`useIsPhone`), not with
 * `lg:hidden`, so only one of them is ever mounted. Rendering both and hiding one would mean two
 * charts, two quote subscriptions and two sets of chart state live at once — the thing the desktop
 * layout's own comment says it was built to avoid.
 *
 * ── Every destination still reachable ────────────────────────────────────────────────────────────
 * The five tabs cover MetaTrader's five. The app's own destinations that MetaTrader has no tab for
 * (deposit, account, legal, live chat) are in the drawer, which the chart's `☰` opens — the same
 * place a terminal brand has kept them since the app bar lost its bottom nav.
 */
export function MT5MobileShell() {
  const tab = useMobileTabStore((s) => s.tab);
  const setTab = useMobileTabStore((s) => s.set);
  useRestoreMobileTab();
  const panelShown = useOneClickStore((s) => s.shown);
  useRestoreOneClick();
  // The levels are restored here, at the shell, because the chart draws them whether or not the
  // trading dialog has been opened this session: MetaTrader's levels live on the chart.
  useRestoreLevels();
  const { stakeCents } = useOrderEntry();

  /**
   * MetaTrader's New Order screen, over whatever tab is showing.
   *
   * It is a screen rather than a tab because MetaTrader's is: it is pushed from the Trade screen's
   * `＋` and from the one-click panel when one-click firing is off, and it is dismissed back to
   * where it was opened from.
   *
   * Its ticket is `MT5MobileOrder`, which is MetaTrader's PHONE ticket rather than the desktop one
   * this screen used to carry. They place the same order — both read `useOrderEntry`, so the volume
   * set on the one-click panel is the volume this screen opens on — and they are laid out the way
   * MetaTrader lays each of them out, which is not the same way.
   */
  const [ticketOpen, setTicketOpen] = useState(false);
  /**
   * MetaTrader's `New Order` (F9), raised from the chart's own context menu.
   *
   * The chart cannot reach this screen's state, so the request is published (lib/game/newOrder) and
   * answered here, which is where this shell keeps MetaTrader's New Order screen. Watched as a
   * counter so a second request is answered too.
   */
  const newOrderRev = useNewOrderStore((s) => s.rev);
  useEffect(() => { if (newOrderRev > 0) setTicketOpen(true); }, [newOrderRev]);
  /**
   * MetaTrader's ADVANCED trading dialog, which is "used from the chart".
   *
   * The two are reached from different places in MetaTrader and that is copied: the chart's
   * one-click panel opens this sheet, the Trade screen's `+` opens the classic full-screen ticket,
   * and the classic ticket's top-right button switches to this one. Both place the same order
   * through `useOrderEntry`.
   */
  const [dialogOpen, setDialogOpen] = useState(false);

  /**
   * MetaTrader's landscape full-screen: "Rotate to landscape = full-screen mode, AUTOMATICALLY."
   *
   * Turning a phone sideways at a chart is a request for more chart, and MetaTrader reads it that
   * way without being asked twice. Measured at 800x360, the five-tab bar is 57px of 360 — 16% of
   * the screen, against 7% held upright — so the bar goes and the chart takes the room.
   *
   * ── Two deviations, both deliberate ──────────────────────────────────────────────────────────
   *
   * The CHART'S OWN top bar stays. MetaTrader's full-screen hides the app's chrome; this shell has
   * no radial menu and no iOS context menu, so that bar is the only way to reach the period strip,
   * the crosshair, the chart type and the one-click panel. Hiding it would make full-screen a mode
   * a trader could change nothing from.
   *
   * iOS's "toggle full-screen/normal by TAPPING THE CHART" is a button on that bar instead. A tap
   * on the plot is already the crosshair and the drawing tools here, so the same gesture would mean
   * two things at once, and the one it happened to mean would be whichever the chart read first.
   */
  const landscape = useIsLandscape();
  /** Full-screen is given back by the bar's own button, until the phone is turned upright again. */
  const [showChrome, setShowChrome] = useState(false);
  const fullScreen = landscape && !showChrome;
  // The app's title bar is above this route, so it is told rather than passed a prop.
  useDeclareFullScreen(fullScreen);
  // Rotating back to portrait is not a decision to keep the chrome hidden: each rotation starts
  // from MetaTrader's own answer for that orientation.
  useEffect(() => { setShowChrome(false); }, [landscape]);
  /**
   * Landscape is a chart gesture: a sideways phone shows the chart, and the tab it was on is still
   * there when it is turned back.
   *
   * Shown WITHOUT writing to the tab store. `setTab` persists (lib/game/mobileTab), so the old
   * version destroyed the trader's chosen tab on every rotation and on every resize of a desktop
   * window past the breakpoint: turn the phone sideways while reading your positions, turn it back,
   * and you were on the chart with no record that you had ever been anywhere else.
   */
  const shown: MobileTab = landscape ? 'charts' : tab;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--mt5-surface)]">
      <div className="relative min-h-0 flex-1">
        {/* Charts stays MOUNTED across tab switches, hidden rather than unmounted.
            A chart that is torn down every time the trader looks at their positions refetches its
            whole history on the way back, which on a phone is a second of blank screen each time.
            MetaTrader's own tabs do not do that. The other four are cheap, so they unmount. */}
        <div
          className={shown === 'charts' ? 'flex h-full min-h-0 flex-col' : 'hidden'}
          aria-hidden={shown === 'charts' ? undefined : true}
        >
          <div className="min-h-0 flex-1">
            {/* The stake behind the chart's draggable Stop Loss: what a contract at the volume
                currently set would risk. The levels themselves come from the shared store, so the
                chart and the trading dialog are two views of one pair. */}
            <GameCurve
              phone
              levelStakeCents={stakeCents}
              {...(landscape
                ? {
                    fullScreen,
                    /* The bar asks for a FULL-SCREEN state; this holds the opposite, so it is
                       inverted here rather than at the bar. Wired straight to the setter, the
                       "leave full screen" tap asked to hide the chrome that was already hidden and
                       the button did nothing at all. */
                    onFullScreen: (full: boolean) => setShowChrome(!full),
                  }
                : {})}
            />
          </div>
          {/* MetaTrader's one-click panel, in its "panel at the bottom" placement. The `▭` button on
              the chart's own top bar is what shows and hides it. */}
          {panelShown ? <MT5OneClickPanel onOpenTicket={() => setDialogOpen(true)} /> : null}
        </div>

        {shown === 'quotes' ? (
          <MarketWatch
            phone
            className="h-full"
            onChart={() => setTab('charts')}
            onNewOrder={() => setTicketOpen(true)}
          />
        ) : null}
        {shown === 'trade' ? (
          <MT5MobileTrade
            onNewOrder={() => setTicketOpen(true)}
            onChart={() => setTab('charts')}
          />
        ) : null}
        {shown === 'history' ? (
          /* `min-h-0` with the scroll on the INNER box, which is the idiom every other tab here
             uses. `h-full flex-col overflow-y-auto` wrapping a `flex-1` child pins the child to the
             scroller's own height, so the list had no room to overflow into and scrolled only by
             accident, through two `overflow: visible` boxes. */
          <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
            <MT5History embedded />
          </div>
        ) : null}
        {shown === 'messages' ? <MT5MobileMessages /> : null}
      </div>

      {/* Hidden in landscape, which is MetaTrader's full-screen. */}
      {fullScreen ? null : <MT5MobileTabs />}

      {ticketOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[var(--mt5-surface)]">
          <MT5MobileOrder
            onBack={() => setTicketOpen(false)}
            onAdvanced={() => { setTicketOpen(false); setDialogOpen(true); }}
          />
        </div>
      ) : null}

      {dialogOpen ? <MT5TradeDialog onDismiss={() => setDialogOpen(false)} /> : null}
    </div>
  );
}

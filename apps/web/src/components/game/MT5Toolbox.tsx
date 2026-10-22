'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { valueOfRate } from '@invest254/shared/candles';
import { accountSummary, accountStripFields, mtAmount, lotsOfStake } from '@invest254/shared/account';
import { useGameSocket, useGameSocketApi, type NewsItemDto, type DayAnchor } from '@/lib/game/GameSocketProvider';
import { useWallet, useWalletFigures, useTransactions } from '@/lib/wallet/hooks';
import { useDisplayMoney } from '@/lib/money';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useSession } from '@/lib/auth/session';
import { useMyNotifications } from '@/lib/notifications/hooks';
import { useJournal, useExperts, logJournal, type JournalEntry } from '@/lib/game/journal';
import { ARTICLES, ARTICLE_CATEGORIES, articlesNewestFirst, type Article, type ArticleCategory } from '@/lib/terminal/articles';
import { markArticleRead, useReadArticles } from '@/lib/terminal/articlesRead';
import { companyPage } from '@/lib/terminal/company';
import { mt5ServerName } from '@/lib/brand/mt5Server';
import { GROUP_LABELS, INDICATOR_GROUPS, MT5_INDICATOR_COUNT, VOLUME_GROUP_NOTE, type IndicatorGroup } from '@/lib/chart/indicatorCatalog';
import { toggleIndicator, useEnabledIndicators } from '@/lib/chart/indicatorsStore';
import {
  ALERT_CONDITIONS, ALERT_DEFAULTS, conditionLabel, useAlertsStore, useAlertWatch,
  type AlertCondition, type AlertDraft, type AlertQuote, type PriceAlert,
} from '@/lib/game/alerts';
import { useLevelsStore, useRestoreLevels } from '@/lib/game/levelsStore';
import { levelPrice, isContinuousBrand } from '@/lib/game/levelWatch';
import { useToast } from '@/lib/toast/ToastProvider';
import { usePositions } from '@/lib/positions/hooks';
import type { PositionDto, TransactionDto } from '@/lib/api/types';
import {
  DESKTOP_PERIODS, changeText, dealRows, historyStrip, orderRows, periodRange, positionRows,
  priceChangePct, priceText, stamp,
  type DealRow, type OrderRow, type PeriodKey, type PositionRow as ClosedRow, type Range,
} from '@/lib/history/mt5history';
import { ticketLabel, type ActivePosition, type PendingOrderDto } from '@/lib/game/betting';
import { PENDING_LABELS } from '@invest254/shared/pending';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { LiveBadge } from '@/components/ui/LiveBadge';
import { cn } from '@/lib/cn';
import { PaneSplitter, usePanelHeight } from '@/components/game/PaneSplitter';
import {
  PLATFORM_COLUMNS, TOOLBOX_COLUMNS, visibleToolboxTabs, type ToolboxTab,
} from '@/lib/game/toolboxTabs';
import { exposureRows } from '@invest254/shared/account';
import {
  calendarBetween, calendarRange, calendarFigure, CALENDAR_CURRENCIES, CALENDAR_PERIODS,
  type CalendarPeriod, type CalendarPriority,
} from '@invest254/shared/calendar';
import { MIN_PANEL_PX } from '@/lib/chart/paneSplit';
import { MT5PositionMenu } from '@/components/game/MT5PositionMenu';
import { MT5ClosePosition } from '@/components/game/MT5ClosePosition';
import { MT5ModifyPosition } from '@/components/game/MT5ModifyPosition';

/**
 * MetaTrader's Toolbox.
 *
 * Every tab carries real data. Where MetaTrader shows something this product genuinely cannot do,
 * the control is present and visibly disabled with the reason, rather than drawn as if it worked:
 *
 *   Trade    the open contract, its live P/L, and an editable take-profit
 *   History  settled contracts from the account's own history
 *   News     a live newswire the engine polls from public RSS feeds
 *   Mailbox  the account's notifications, the same ones the banner system raises
 *   Alerts   price alerts, armed against the live price and fired by the open terminal
 *   Journal  this session's real socket events — connect, auth, orders, server errors
 *
 * The account figures come from `accountSummary` in the shared package, which documents how MT5's
 * margin-broker vocabulary maps onto fixed-stake contracts and is unit-tested there. The floating
 * result is the engine's own live P/L — the number it will settle on — so this panel is a read-only
 * view that cannot disagree with an outcome.
 *
 * Tabs sit along the BOTTOM edge, where MetaTrader puts them.
 */

type Tab = ToolboxTab;

export function MT5Toolbox() {
  const { positions, pendingOrders, status, earlyCloseEnabled, spread, setLevels: pushLevels } = useGameSocket();
  const brand = useBrand();
  /**
   * Whether the engine acts on the S/L and T/P levels at all: a brand with a price axis, pool mode
   * off. `earlyCloseEnabled` alone is not it. See `isContinuousBrand` in lib/game/levelWatch.ts.
   */
  const continuous = isContinuousBrand({ chartStyle: brand.chartStyle, earlyCloseEnabled });
  const { getLastTick, getMarket, sell, cancelPending } = useGameSocketApi();
  const { data: wallet } = useWallet();
  const money = useDisplayMoney();
  const token = useSession((s) => s.token);
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('trade');

  /**
   * The tab strip. Company rides on whether THIS brand publishes a company page, which is
   * MetaTrader's own rule for the one tab it hides: "This tab is hidden if the web page is disabled
   * by the broker." A brand with no licence line and no support channel publishes nothing, so it
   * gets eleven tabs; one that does gets twelve.
   */
  // MetaTrader's own server string, the same one the account strip and the Funds screen print.
  const figures = useWalletFigures();
  const server = mt5ServerName(brand, figures.demo ? 'demo' : 'real');
  const company = useMemo(() => companyPage(brand, { server }), [brand, server]);
  /** The Articles tab's own count, which MetaTrader draws as a subscript on the tab. */
  const readArticles = useReadArticles();
  const unreadArticles = ARTICLES.length - readArticles.size;
  const tabs = useMemo(() => visibleToolboxTabs({ company: company.published }), [company.published]);
  // A brand change can take the active tab away under the trader. Fall back to Trade rather than
  // leaving the panel on a tab that is no longer in the strip.
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab('trade');
  }, [tabs, tab]);

  /**
   * MetaTrader's two Toolbox shortcuts, and it has no others.
   *
   *   Ctrl+T     "Open/close the 'Toolbox' window."
   *   Ctrl+F9    "Open the 'Trade' tab in the 'Toolbox' window and switch the control focus to it."
   *
   * No other tab has one. Neither fires while a field has focus, so a dialog's own text boxes keep
   * their editing keys.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'F9' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setTab('trade');
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The live row is driven by the tick stream, which does not re-render React on its own.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);

  const market = getMarket();
  const symbol = market?.instrument.symbol ?? 'XAUUSD';
  const digits = market?.instrument.digits ?? 2;
  /**
   * Volume prints to the SYMBOL's volume digits, which is what the order ticket offers
   * (09-toolbox.md 300, rows at 313-318). These cells printed two places whatever the symbol's step
   * was, so a position the ticket opened at 0.025 lots appeared in its own row as 0.03.
   */
  const volumeDigits = useVolumeDigits(symbol);
  const lots = (stakeCents: number) => lotsOfStake(stakeCents, volumeDigits);

  const priceOfRate = useCallback((rate: number): number | null => {
    const m = getMarket();
    return m ? m.anchor.base + m.instrument.scale * (valueOfRate(rate) - m.anchor.openValue) : null;
  }, [getMarket]);
  const livePrice = useCallback((): number | null => {
    const t = getLastTick();
    return t ? priceOfRate(t.rate) : null;
  }, [getLastTick, priceOfRate]);
  const px = (rate: number | null | undefined): string => {
    if (rate === null || rate === undefined) return '-';
    const p = priceOfRate(rate);
    return p === null ? '-' : p.toFixed(digits);
  };
  /**
   * The quote an alert is checked against: the same price the chart draws, and the two sides around
   * it by the spread the engine charges, so a `Bid >` alert fires at the bid a sell would fill at.
   * The arithmetic is the order ticket's own (`useOrderEntry.bidAsk`).
   */
  const liveQuote = useCallback((): AlertQuote => {
    const last = livePrice();
    const scale = getMarket()?.instrument.scale ?? null;
    if (last === null || spread === null || scale === null) return { last, bid: null, ask: null };
    return { last, bid: last - spread.sell * scale, ask: last + spread.buy * scale };
  }, [livePrice, getMarket, spread]);
  // Alerts fire against that quote, and against the clock for `Time =`.
  useAlertWatch(liveQuote, symbol, (a, price) => {
    toast.push({
      tone: 'info',
      title: `${a.symbol} alert`,
      description: a.condition === 'time='
        ? `${conditionLabel(a.condition)} ${a.timeHHMM}`
        : `${conditionLabel(a.condition)} ${a.price}${price === null ? '' : `, now ${price.toFixed(digits)}`}`,
    });
  });

  /**
   * EVERY open position, which is what MetaTrader's account figures are computed over.
   *
   * An optimistic open has no engine id yet; its stake is already committed, so it counts. A
   * position being closed does not: its money is on its way back.
   *
   * Margin, Free Margin and Margin Level only mean anything across several positions, and they were
   * being computed over one because that is all the client could hold. The sums are the whole point
   * of the strip.
   */
  const openPositions = positions.filter((p) => p.phase !== 'settling');
  const live = openPositions[openPositions.length - 1] ?? null;
  const floatingCents = openPositions.reduce((n, p) => n + p.livePnlCents, 0);
  const summary = accountSummary({
    walletCents: (wallet?.real ?? 0) + (wallet?.bonus ?? 0),
    openStakeCents: openPositions.reduce((n, p) => n + p.stakeCents, 0),
    floatingPnlCents: floatingCents,
  });
  /**
   * The strip in MetaTrader's own format: its labels, its ordering, its space thousands separator,
   * and the currency code once after the balance.
   *
   * The figures are converted to the brand's display unit first, because the shared formatter is
   * about MetaTrader's typography and knows nothing about this platform's currencies.
   */
  const strip = accountStripFields({
    balance: money.toDisplay(summary.balanceCents),
    equity: money.toDisplay(summary.equityCents),
    margin: money.toDisplay(summary.marginCents),
    freeMargin: money.toDisplay(summary.freeMarginCents),
    marginLevelPct: summary.marginLevelPct,
    currency: money.currency,
  });

  // ── Take profit ────────────────────────────────────────────────────────────────────────────────
  // The target lives in the shared store because MetaTrader carries T/P on the ticket AND lets you
  // modify it on an open position; both surfaces read and write the one value.
  /**
   * The SAME levels the ticket and the chart use, so this row modifies one thing.
   *
   * It held a target floating PROFIT in cents before, from its own store, which no other surface
   * could see and the chart could not draw. The watcher that acted on it was armed HERE, inside the
   * desktop Toolbox, so on a phone a target could be set and nothing would ever fire it; the level
   * watcher is armed in TradeSurface instead, which is the one parent both shells hang off.
   */
  const levels = useLevelsStore((st) => st.levels);
  const setLevels = useLevelsStore((st) => st.set);
  const levelRef = useLevelsStore((st) => st.ref);
  useRestoreLevels();
  // `livePrice` is already a callback on this component, so the value is read through it.
  const nowPrice = livePrice();
  const anchor = levelRef ?? nowPrice;
  /**
   * The S/L and T/P columns show the ENGINE's levels for the open position, not the ticket's.
   *
   * These read `levelPrice(levels, ...)`, which is the working copy a trader drags around BEFORE an
   * order exists. Once a position is open that copy is no longer what will fire: the engine holds
   * the levels and settles on them. A Toolbox row printing the ticket's numbers would show a stop
   * that does not exist, and the two would drift apart the moment the ticket was touched again.
   *
   * Falls back to the ticket's copy only when nothing is open, which is when that is the only
   * meaning the row can have.
   */
  const slPrice = live?.slPrice ?? (live ? null : levelPrice(levels, anchor, 'sl', digits));
  const tpPrice = live?.tpPrice ?? (live ? null : levelPrice(levels, anchor, 'tp', digits));
  /**
   * One point at a time, which is what MetaTrader's own "− value +" on this row steps by.
   *
   * On an OPEN position this is Modify position, so it goes to the engine: stepping it only in the
   * local store would move a number on screen and leave the stop that actually fires where it was.
   */
  const stepTpOf = (pos: ActivePosition, dir: 1 | -1) => {
    const point = 1 / 10 ** digits;
    if (pos.phase !== 'open' || !pos.positionId) return;
    const base = pos.tpPrice ?? nowPrice;
    if (base === null) return;
    // Modify position, on THIS position: the engine holds the levels, so stepping it only in the
    // local store would move a number on screen and leave the stop that actually fires where it was.
    pushLevels(pos.slPrice, Number((base + dir * point).toFixed(digits)), pos.positionId);
  };
  /** The TICKET's target, for when nothing is open: the working copy a trader drags before ordering. */
  const stepTicketTp = (dir: 1 | -1) => {
    if (anchor === null) return;
    const cur = levels.tpPoints;
    setLevels({ ...levels, tpPoints: cur === null ? dir * 100 : cur + dir }, nowPrice);
  };


  // MetaTrader's Toolbox is a SIZED pane with a splitter on its top edge; the chart above simply
  // takes what is left. Keeping the size on the pane rather than on the chart is why a drag can
  // never leave a hole: there is exactly one flexible pane in the column.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panel = usePanelHeight();
  const grabPanel = useCallback((clientY: number) => {
    panel.begin(clientY, panelRef.current?.getBoundingClientRect().height ?? MIN_PANEL_PX);
  }, [panel]);

  // MetaTrader reaches the Close position form from the Trade tab's own row, through the position
  // context menu. Opening the form from a button on the ticket was our invention; this is the route
  // the terminal actually has.
  /**
   * Which position a form is open on, as well as which form.
   *
   * With many positions "the menu" is not enough: closing one row's position from another row's
   * confirmation is the kind of mistake a terminal must make impossible. The id travels with the
   * sheet, and the row it was opened from is looked up by it.
   */
  const [sheet, setSheet] = useState<null | { kind: 'menu' | 'close' | 'modify'; positionId: string | null }>(null);
  /** The position a form is acting on, re-read from the live list so it stays current while open. */
  const sheetPos = sheet === null
    ? null
    : positions.find((p) => p.positionId === sheet.positionId) ?? null;

  const notifications = useMyNotifications();
  const journal = useJournal();
  const alerts = useAlertsStore((s) => s.alerts);

  return (
    <div className="flex shrink-0 flex-col overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] text-[#ffffff]">
      {/* The account line is the toggle, and the only place these figures appear. Collapsed it is a
          single scrolling row so the chart keeps its height on a phone; open, it wraps to
          MetaTrader's full five. The chevron sits outside the scrolling area, or it rides off. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Hide account details' : 'Show account details'}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={cn(
            'min-w-0 flex-1 gap-x-5 gap-y-1',
            open
              /**
               * WRAPPING, not a fixed column count.
               *
               * A five-column grid sized its cells by the container and the figures by their text,
               * and each figure is `whitespace-nowrap shrink-0`, so "Free Margin KES 442.91" simply
               * ran over the top of "Margin Level" and rendered as "442.91ARGIN LEVEL". Wrapping
               * lets each figure keep its own width and drop to a second line when the bar runs out,
               * which cannot overlap at any width.
               */
              ? 'flex flex-wrap items-center'
              : 'flex items-center overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
          {/* MetaTrader's own five fields, in its own order, labels and number format — read off its
              screenshots in docs/mt5/09-toolbox.md section 4 rather than written from memory, which
              is how "Free margin" and "Margin level" ended up miscased here before.

              Collapsed, the row is ONE line on a phone. Carrying all five pushed Free Margin off the
              edge mid-word, which reads as broken rather than as scrollable; the two that only
              matter with a position open appear when the panel does. */}
          {strip.map((f, i) => (
            i === 2 || i === 3
              ? (open ? <Figure key={f.label} label={f.label} value={f.value} /> : null)
              : (
                <Figure
                  key={f.label}
                  label={f.label}
                  value={f.value}
                  // Equity carries the floating tone, which is the one figure that moves with a live
                  // position. MetaTrader colours the strip's trailing total the same way.
                  tone={i === 1 && floatingCents !== 0 ? (floatingCents > 0 ? 'up' : 'down') : undefined}
                />
              )
          ))}
        </span>
        <span className="flex shrink-0 items-center gap-2 pl-1">
          {/* MetaTrader ends the strip with the total floating P/L, right-aligned and with NO label.
              It is the only figure there that is not an account total, which is why it sits apart
              from the five rather than among them. Absent with nothing open, as MetaTrader's is. */}
          {live ? (
            <span className={cn('font-mono text-[12px] font-semibold tabular-nums', floatingCents > 0 ? 'text-[var(--mt5-blue)]' : floatingCents < 0 ? 'text-[var(--mt5-red)]' : 'text-[#ffffff]')}>
              {mtAmount(money.toDisplay(floatingCents))}
            </span>
          ) : null}
          {openPositions.length ? <span className="rounded bg-[var(--mt5-blue)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--mt5-blue)]">{openPositions.length} open</span> : null}
          <LiveBadge status={status} showLabel={false} variant="terminal" />
          <span className={cn('text-[var(--mt5-muted)] transition', open && 'rotate-180')} aria-hidden>▾</span>
        </span>
      </button>

      {open ? (
        <>
          {/* On a phone the panel is a SHEET over the screen, not an inline block: docked inline it
              squeezed the chart down to a sliver, which is the opposite of what a terminal should do
              with its chart. From `sm` up there is room to dock it, so it docks, as MetaTrader does.
              The backdrop is mobile-only and dismisses on tap. */}
          <button
            type="button"
            aria-label="Close account details"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-black/60 sm:hidden"
          />
          <div
            ref={panelRef}
            className="fixed inset-x-1 bottom-[calc(0.25rem+env(safe-area-inset-bottom))] z-40 flex max-h-[68vh] flex-col overflow-hidden rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] shadow-2xl sm:static sm:z-auto sm:max-h-none sm:rounded-none sm:border-0 sm:border-t sm:shadow-none"
            style={panel.px === null ? undefined : { height: panel.px, maxHeight: 'none' }}
          >
          {/* The splitter. Drag up for more Toolbox, down for more chart; double-click hands the
              size back to the layout. On a phone the pane is bottom-anchored, so it grows upward
              under the finger, which is the same gesture as the desktop drag. */}
          <PaneSplitter onGrab={grabPanel} onMove={panel.move} onRelease={panel.end} onReset={panel.reset} />
          <div
            className="min-h-0 flex-1 overflow-auto sm:border-t sm:border-[var(--mt5-border)]"
            // Unsized, the pane keeps the height it always had. Once a trader has dragged it, the
            // pane itself carries the height and the scroller just fills it.
            style={panel.px === null ? { maxHeight: 'min(46vh, 22rem)' } : undefined}
          >
            {/* MetaTrader shows a position as a two-line entry on a phone and as a wide table on a
                desktop, because ten columns cannot be read on a 430px screen. Both are rendered from
                the same values, rather than the table being squeezed.

                The swap used to happen at `sm`, as if the viewport were the constraint. It is not:
                this pane is only the CHART column, with Market Watch docked to its left and the
                ticket to its right, so a 1024px laptop gives it 446px, which is the 430px phone
                case under another name. The ten columns measured 720px there and the `Profit`
                header, the one column a trader is actually watching and the one carrying the
                × close control, sat 274px past the right edge of the pane (at 1152 165px, at 1280
                126px, at 1366 36px; 1440 is the first width at which it lands inside). The pane
                scrolls, so none of it was clipped, but a column you have to go and find is not on
                screen. Nothing can be done to the table itself here: ten columns of prices cannot
                be truncated into 446px and still be read, and MetaTrader truncates a column rather
                than dropping one (`Currency` drawn as `Curr…`, docs/mt5/09-toolbox.md:841), so the
                order below stays exactly its order (docs/mt5/09-toolbox.md:258).

                That 446px was the real defect and it is fixed where it was caused, in
                `TradeSurface`: this panel is now docked across the whole window as MetaTrader's is
                ("at the bottom of the main window", docs/mt5/09-toolbox.md:119) rather than nested
                inside the chart column, so the pane is the window's width and the grid's own
                720-733px of content fits from 1024 up. The `sm` swap below is therefore back to
                being about the PHONE, which is what MetaTrader's two-line entry is for, instead of
                hiding the grid from every laptop. */}
            {tab === 'trade' ? (
              openPositions.length || pendingOrders.length ? (
                <>
                  {/* MetaTrader's phone entry: one two-line row per position. */}
                  {openPositions.map((pos) => (
                    <PositionRow
                      key={pos.clientId}
                      className="sm:hidden"
                      onOpenMenu={() => setSheet({ kind: 'menu', positionId: pos.positionId })}
                      symbol={symbol}
                      direction={pos.direction}
                      lots={lots(pos.stakeCents)}
                      from={px(pos.entryRate)}
                      to={px(getLastTick()?.rate ?? null)}
                      profit={money.mt(pos.livePnlCents)}
                      profitCents={pos.livePnlCents}
                      note={continuous && pos.tpPrice !== null ? `T/P ${pos.tpPrice.toFixed(digits)}` : `Max loss ${money.fmt(pos.stakeCents)}`}
                    />
                  ))}
                  <div className="hidden sm:block">
                    <Table head={['Symbol', 'Ticket', 'Time', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Price', 'Profit']}>
                      {/* One row per open position, which is what MetaTrader's Trade tab is: "open
                          positions above the account summary strip ... in a single shared column
                          grid" (docs/mt5/09-toolbox.md 250). This drew exactly one row, because the
                          client could only hold one position. */}
                      {openPositions.map((pos) => (
                        <TradeGridRow
                          key={pos.clientId}
                          pos={pos}
                          symbol={symbol}
                          digits={digits}
                          continuous={continuous}
                          earlyCloseEnabled={earlyCloseEnabled}
                          nowRate={getLastTick()?.rate ?? null}
                          px={px}
                          lots={lots}
                          money={money}
                          onOpenMenu={() => setSheet({ kind: 'menu', positionId: pos.positionId })}
                          onClose={() => { if (pos.positionId) sell(pos.positionId); }}
                          onStepTp={(dir) => stepTpOf(pos, dir)}
                        />
                      ))}
                      {/**
                       * The pending orders, BELOW the positions, in the same grid.
                       *
                       * MetaTrader's own shape: "open positions above the account summary strip,
                       * pending orders below it, in a single shared column grid"
                       * (docs/mt5/09-toolbox.md 249). There is no second table and no second
                       * header, and what tells the two kinds apart is the `Type` cell, which reads
                       * `buy limit` rather than `buy` — which is exactly how MetaTrader tells them
                       * apart too (09-toolbox.md 296: the UI renders `buy`, `sell`, `buy limit`,
                       * `sell limit`).
                       */}
                      {pendingOrders.map((order) => (
                        <PendingGridRow
                          key={order.id}
                          order={order}
                          digits={digits}
                          nowRate={getLastTick()?.rate ?? null}
                          px={px}
                          lots={lots}
                          onCancel={() => cancelPending(order.id)}
                        />
                      ))}
                    </Table>
                  </div>
                  {/* The phone's own entry for an order waiting on its level. The two-line
                      position row above it has no column for a trigger, so this states what the
                      order is in its own words rather than borrowing that shape. */}
                  {pendingOrders.map((order) => (
                    <PendingPhoneRow
                      key={order.id}
                      order={order}
                      digits={digits}
                      lots={lots}
                      onCancel={() => cancelPending(order.id)}
                    />
                  ))}
                </>
              ) : (
                <Empty>No open positions.</Empty>
              )
            ) : null}

            {tab === 'history' ? (
              <HistoryTab symbol={symbol} digits={digits} lots={lots} amount={money.mt} token={token} />
            ) : null}

            {tab === 'news' ? <NewsTab active={open} /> : null}

            {tab === 'mailbox' ? (
              !token ? (
                <Empty>Sign in to read your messages.</Empty>
              ) : (notifications.data?.items?.length ?? 0) > 0 ? (
                <ul className="divide-y divide-[var(--mt5-border)]/60">
                  {(notifications.data?.items ?? []).map((n) => (
                    <li key={n.id} className="px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', n.level === 'error' ? 'bg-[var(--mt5-red)]' : n.level === 'warning' ? 'bg-[#f0b90b]' : n.level === 'success' ? 'bg-[var(--mt5-green)]' : 'bg-[var(--mt5-blue)]')} />
                        <span className="text-[11px] font-semibold text-white">{n.title}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--mt5-muted)]">{stamp(n.createdAtMs)}</span>
                      </div>
                      <p className="mt-0.5 pl-3.5 text-[11px] leading-snug text-[var(--mt5-muted)]">{n.body}</p>
                    </li>
                  ))}
                </ul>
              ) : notifications.isLoading ? (
                /* "No messages." used to be printed while the fetch was still in flight, and again
                   identically when it failed — so an outage looked like an empty mailbox. The News
                   tab in this same file has always made all three distinct; this matches it. */
                <Empty>Loading messages…</Empty>
              ) : notifications.isError ? (
                <Empty>Mailbox unavailable. Retrying…</Empty>
              ) : (
                <Empty>No messages.</Empty>
              )
            ) : null}

            {tab === 'alerts' ? <AlertsTab symbol={symbol} digits={digits} livePrice={livePrice} alerts={alerts} /> : null}

            {/* MetaTrader's Economic Calendar, over generated releases. See `CalendarTab`. */}
            {tab === 'calendar' ? <CalendarTab /> : null}

            {/* Exposure: real numbers, computed from the contracts that are open. Its fourth column
                is headed with the deposit currency's own code, as MetaTrader heads it. */}
            {tab === 'exposure' ? (
              <ExposureTab
                symbol={symbol}
                live={live}
                currency={money.currency}
                fmt={(cents) => money.mt(cents)}
              />
            ) : null}

            {/* The broker's own article library, in MetaTrader's `Name | Category | Date` grid. */}
            {tab === 'articles' ? <ArticlesTab /> : null}

            {/* MetaTrader's program library is MQL5's; this terminal's is its own 38 indicators, and
                this tab applies them to the chart the way Code Base downloads a program. */}
            {tab === 'codebase' ? <CodeBaseTab /> : null}

            {/* The Experts journal: what the programs on the chart did. See `logExperts`. */}
            {tab === 'experts' ? <ExpertsTab /> : null}

            {/* The broker's own page. Drawn only when this brand publishes one, which is also why
                the tab itself is in the strip; MetaTrader hides it otherwise. */}
            {tab === 'company' ? <CompanyTab page={company} /> : null}

            {/* The platform's own log. Drawn by the same component as Experts, because MetaTrader
                draws its two logs identically and states one set of columns for both. */}
            {tab === 'journal' ? (
              <LogTab entries={journal} empty="Journal is empty." />
            ) : null}
          </div>

          {/* MetaTrader puts the Toolbox tabs along the BOTTOM edge of the panel, and there are
              eleven or twelve of them drawn (Company appears only for a brand that publishes a
              company page, which is MetaTrader's own rule). Eleven cannot share
              a 390px phone evenly — "Code Base" alone would not fit in a thirty-pixel slot — so the
              strip SCROLLS rather than crushing the labels, which is what the period row above the
              chart already does with twenty-one periods.
              A count rides as a superscript, as MetaTrader's red subscript count does.

              A LAPTOP is the same problem, which is why nothing here stretches the tabs any more.
              `sm:flex-1` used to hand all eleven an equal share of the bar, and because the chart
              column is only part of the window the share was too small to hold the label: measured
              at 1024, eight of the eleven were cut (Code Base 23px, Exposure 16px, Calendar 14px,
              Mailbox 7px, Articles 6px, Experts 6px, History 4px, Journal 3px, the strip reading
              "MailboxCalendaAlerts Article Code BExpertJourna"), and again at exactly 1280, where
              the `xl:` step widens Market Watch and the ticket and takes 80px back off this column.
              Equal shares also killed the scroll: a flex item that has already been shrunk to fit
              leaves the scroller nothing to scroll. MetaTrader never stretches them: its Toolbox
              tabs are "flat labels separated by thin vertical rules" (docs/mt5/09-toolbox.md:140),
              each its own width, and a panel tab strip with no room for them all grows
              `◀ ▶` scroll arrows at its right end (docs/mt5/10-market-watch.md:96). */}
          <div className="flex items-stretch overflow-x-auto border-t border-[var(--mt5-border)] bg-[var(--mt5-raised)] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => {
              // MetaTrader puts a count on a tab that has something waiting, and it puts one on
              // Articles too: `Articles₇` on its own screenshot is the UNREAD count.
              const count = t.id === 'mailbox'
                ? (notifications.data?.items?.length ?? 0)
                : t.id === 'alerts' ? alerts.length
                : t.id === 'articles' ? unreadArticles
                : 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-pressed={tab === t.id}
                  className={cn(
                    'shrink-0 whitespace-nowrap px-2 py-1.5 text-[10.5px] font-semibold leading-tight transition',
                    tab === t.id ? 'bg-[var(--mt5-border)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
                  )}
                >
                  {t.label}
                  {count > 0 ? (
                    <sup className={cn('ml-0.5 text-[9px]', t.id === 'mailbox' ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-muted)]')}>{count}</sup>
                  ) : null}
                </button>
              );
            })}
          </div>
          </div>
        </>
      ) : null}

      {/* MetaTrader's position menu and the two forms it leads to. Rendered once, outside the
          collapsible pane, so dismissing the panel does not strand an open form. */}
      {sheetPos && sheet?.kind === 'menu' ? (
        <MT5PositionMenu
          title={`${symbol}, ${sheetPos.direction} ${lots(sheetPos.stakeCents)}`}
          subtitle={`#${ticketLabel(sheetPos)} at ${px(sheetPos.entryRate)}`}
          onDismiss={() => setSheet(null)}
          items={[
            {
              id: 'close',
              label: 'Close position',
              onPick: () => setSheet({ kind: 'close', positionId: sheetPos.positionId }),
              disabled: !earlyCloseEnabled || !sheetPos.sellable || sheetPos.phase !== 'open',
              note: !earlyCloseEnabled
                ? 'This brand settles every contract at expiry.'
                : !sheetPos.sellable
                  ? 'This contract settles at expiry and cannot be closed at a loss.'
                  : undefined,
            },
            { id: 'modify', label: 'Modify position', onPick: () => setSheet({ kind: 'modify', positionId: sheetPos.positionId }) },
            {
              id: 'chart',
              label: 'Chart',
              onPick: () => { setSheet(null); setOpen(false); },
              note: 'Collapses this panel so the chart fills the screen.',
            },
          ]}
        />
      ) : null}

      {sheetPos && sheet?.kind === 'close' ? (
        <MT5ClosePosition
          pos={sheetPos}
          symbol={symbol}
          digits={digits}
          price={livePrice()}
          openPrice={sheetPos.entryRate === null ? null : priceOfRate(sheetPos.entryRate)}
          busy={sheetPos.phase === 'settling'}
          onDismiss={() => setSheet(null)}
          // THIS position, named explicitly. With several open, a close that meant "the newest"
          // would shut the wrong trade from a confirmation naming another.
          onConfirm={() => { if (sheetPos.positionId) sell(sheetPos.positionId); setSheet(null); }}
        />
      ) : null}

      {sheetPos && sheet?.kind === 'modify' ? (
        <MT5ModifyPosition
          pos={sheetPos}
          symbol={symbol}
          digits={digits}
          openPrice={sheetPos.entryRate === null ? null : priceOfRate(sheetPos.entryRate)}
          canTakeProfit={earlyCloseEnabled}
          onDismiss={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}

/** Live newswire. Fetched when the tab is first shown, then refreshed on a slow timer. */
function NewsTab({ active }: { active: boolean }) {
  const { requestNews } = useGameSocketApi();
  const { status } = useGameSocket();
  const [items, setItems] = useState<NewsItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keyed on the connection as well as the tab: a request raised while the socket is down is
  // rejected, and without this the tab would sit on its error until the next two-minute tick.
  useEffect(() => {
    if (!active || status !== 'open') return;
    let cancelled = false;
    const load = () => {
      requestNews(40)
        .then((r) => { if (!cancelled) { setItems(r.items); setError(null); } })
        .catch((e: Error) => { if (!cancelled) setError(e.message); });
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [active, status, requestNews]);

  if (error && !items) return <Empty>Newswire unavailable ({error}).</Empty>;
  if (!items) return <Empty>Loading news…</Empty>;
  if (items.length === 0) return <Empty>No news.</Empty>;
  return (
    <ul className="divide-y divide-[var(--mt5-border)]/60">
      {items.map((n) => (
        <li key={n.id}>
          {/* Opened in a new tab, and `noreferrer` so a third-party page is not told where the
              player came from. The text itself is rendered as text — never as markup. */}
          <a href={n.url} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 hover:bg-[var(--mt5-border)]/40">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[10px] text-[var(--mt5-muted)]">{stamp(n.publishedAtMs)}</span>
              <span className="shrink-0 rounded bg-[var(--mt5-border)] px-1 text-[10px] text-[var(--mt5-muted)]">{n.source}</span>
              <span className="min-w-0 text-[11px] font-semibold leading-snug text-white">{n.title}</span>
            </div>
            {n.summary ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--mt5-muted)]">{n.summary}</p> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * MetaTrader's Alerts tab and its Alert Editor.
 *
 * The grid is MetaTrader's own, verbatim and in order — `Symbol | Condition | Counter | Limit |
 * Timeout | Expiration | Event` (docs/mt5/09-toolbox.md 899-901), which is what
 * `TOOLBOX_COLUMNS.alerts` already held while this tab drew an inline form and four columns of its
 * own. The gutter carries MetaTrader's yellow bell for an enabled alert and its red crossed circle
 * for a disabled one (:910), and every row is created, modified, deleted and enabled from the
 * context menu with the accelerators MetaTrader lists (:912-921) — they are wired, not drawn.
 *
 * THE CONDITION LIST IS THREE, NOT NINE, AND THE TAB SAYS WHY. MetaTrader offers
 * `Bid < Bid > Ask < Ask > Last < Last > Volume < Volume > Time =` (:933-935). This platform quotes
 * one price per symbol, and docs/mt5/10-market-watch.md 417-419 is explicit about what that means:
 * a one-price platform "must delete `Bid`, `Ask` and `Spread` outright rather than fold them",
 * keeping the `Last` family. Drawing six price conditions over one number would offer a trader
 * three ways to say the same thing and two that cannot be true. Volume goes for a different reason
 * — the feed carries no volume to compare — and `Time =` stays, because it never needed a price.
 * See lib/game/alerts, which is where the rule lives and where the watcher applies it.
 *
 * The Action list keeps MetaTrader's four and offers the one this terminal can honestly perform,
 * with the other three visibly disabled and carrying their reason, which is how the rest of this
 * panel treats a control the platform cannot back.
 */
function AlertsTab({ symbol, digits, livePrice, alerts }: {
  symbol: string; digits: number; livePrice: () => number | null; alerts: PriceAlert[];
}) {
  const { add, update, remove, toggle, rearm } = useAlertsStore();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** `null` = closed; `{ id: null }` = Create; `{ id }` = Modify on that row. */
  const [editing, setEditing] = useState<{ id: string | null; draft: AlertDraft } | null>(null);

  const blank = (): AlertDraft => ({
    enabled: true,
    symbol,
    condition: 'last>',
    price: Number((livePrice() ?? 0).toFixed(digits)),
    timeHHMM: '',
    limit: ALERT_DEFAULTS.limit,
    timeoutS: ALERT_DEFAULTS.timeoutS,
    expiresAtMs: null,
  });
  const draftOf = (a: PriceAlert): AlertDraft => ({
    enabled: a.enabled, symbol: a.symbol, condition: a.condition, price: a.price,
    timeHHMM: a.timeHHMM, limit: a.limit, timeoutS: a.timeoutS, expiresAtMs: a.expiresAtMs,
  });
  const current = alerts.find((a) => a.id === selected) ?? null;

  const create = () => { setMenu(null); setEditing({ id: null, draft: blank() }); };
  const modify = () => { if (current) { setMenu(null); setEditing({ id: current.id, draft: draftOf(current) }); } };
  const drop = () => { if (current) { setMenu(null); remove(current.id); setSelected(null); } };
  const enable = () => { if (current) { setMenu(null); toggle(current.id); } };

  /**
   * MetaTrader's four accelerators, acting on the selected row (09-toolbox.md 914-917). They are
   * bound to this tab rather than to the window, so they cannot fire while a trader is typing into
   * the order ticket, and the panel's own Ctrl+T / Ctrl+F9 keep working.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
    if (e.key === 'Insert') { e.preventDefault(); create(); }
    else if (e.key === 'Enter' && current) { e.preventDefault(); modify(); }
    else if (e.key === 'Delete' && current) { e.preventDefault(); drop(); }
    else if (e.key === ' ' && current) { e.preventDefault(); enable(); }
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      className="outline-none"
      data-alerts-tab=""
    >
      <Table head={[...(TOOLBOX_COLUMNS.alerts ?? [])]}>
        {alerts.map((a) => (
          <tr
            key={a.id}
            onClick={() => setSelected(a.id)}
            onDoubleClick={() => { setSelected(a.id); setEditing({ id: a.id, draft: draftOf(a) }); }}
            className={cn('cursor-pointer border-t border-[var(--mt5-border)]/60', selected === a.id ? 'bg-[var(--mt5-border)]' : 'hover:bg-[var(--mt5-raised)]')}
          >
            <Td first>
              <span className="flex items-center gap-1.5">
                <AlertBell on={a.enabled} />
                {a.symbol}
              </span>
            </Td>
            <Td>{conditionLabel(a.condition)} {a.condition === 'time=' ? a.timeHHMM : a.price.toFixed(digits)}</Td>
            <Td>{a.counter}</Td>
            <Td>{a.limit}</Td>
            {/* MetaTrader prints the timeout with its unit in the cell: "10 sec" (09-toolbox.md 906). */}
            <Td>{a.timeoutS} sec</Td>
            {/* Blank when an alert never expires, which is how MetaTrader's own rows read. */}
            <Td>{a.expiresAtMs === null ? '' : stamp(a.expiresAtMs)}</Td>
            {/* `Event` is the action that will be performed. MetaTrader's rows name a sound file or
                a mail subject there; this terminal can only raise its own notification, so that is
                what the cell says rather than naming a file that does not exist. */}
            <Td>Notification</Td>
          </tr>
        ))}
      </Table>

      {alerts.length === 0 ? <Empty>No alerts. Right-click to create one.</Empty> : null}

      {/* MetaTrader runs alerts on its server, so they fire with the app closed. These live in this
          browser, so they can only fire while the terminal is open — said plainly. */}
      <ToolboxFooter>
        <span>Alerts fire while this terminal is open.</span>
        <span>Checked against {symbol}, the open chart&apos;s symbol.</span>
        {current?.counter ? (
          <button type="button" onClick={() => rearm(current.id)} className="text-[var(--mt5-blue)] hover:underline">
            Re-arm {current.symbol}
          </button>
        ) : null}
      </ToolboxFooter>

      {menu ? (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-[70] cursor-default" />
          <div
            role="menu"
            data-alerts-menu=""
            className="fixed z-[71] w-48 overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[12px] shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {/* Verbatim, with MetaTrader's accelerators and no ellipses (09-toolbox.md 912-922).
                Three of the four need a selected row, and are disabled without one rather than
                silently doing nothing. */}
            <AlertMenuItem label="Create" accel="Insert" onPick={create} />
            <AlertMenuItem label="Modify" accel="Enter" onPick={modify} disabled={!current} />
            <AlertMenuItem label="Delete" accel="Delete" onPick={drop} disabled={!current} />
            <AlertMenuItem label="Enable" accel="Space" onPick={enable} disabled={!current} checked={current?.enabled ?? false} />
          </div>
        </>
      ) : null}

      {editing ? (
        <AlertEditor
          draft={editing.draft}
          digits={digits}
          onChange={(d) => setEditing({ id: editing.id, draft: d })}
          onTest={(d) => {
            toast.push({
              tone: 'info',
              title: `${d.symbol} alert`,
              description: `${conditionLabel(d.condition)} ${d.condition === 'time=' ? d.timeHHMM : d.price}`,
            });
            logJournal('info', 'Alert', `${d.symbol} alert test ${conditionLabel(d.condition)} ${d.condition === 'time=' ? d.timeHHMM : d.price}`);
          }}
          onCancel={() => setEditing(null)}
          onOk={(d) => {
            if (editing.id === null) add(d); else update(editing.id, d);
            logJournal('info', 'Alert', `${d.symbol} alert ${editing.id === null ? 'created' : 'modified'}: ${conditionLabel(d.condition)} ${d.condition === 'time=' ? d.timeHHMM : d.price}`);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** MetaTrader's gutter glyphs: a yellow bell while armed, a red crossed circle when disabled. */
function AlertBell({ on }: { on: boolean }) {
  return on ? (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-label="Enabled" role="img" className="shrink-0 text-[#f0b90b]" fill="currentColor">
      <path d="M8 1.5a1 1 0 0 1 1 1v.3a3.8 3.8 0 0 1 2.8 3.7v2.3l1 1.6H3.2l1-1.6V6.5A3.8 3.8 0 0 1 7 2.8v-.3a1 1 0 0 1 1-1Zm0 13a1.8 1.8 0 0 1-1.7-1.3h3.4A1.8 1.8 0 0 1 8 14.5Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-label="Disabled" role="img" className="shrink-0 text-[var(--mt5-red)]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="8" cy="8" r="6" />
      <path d="M4 12 12 4" />
    </svg>
  );
}

function AlertMenuItem({ label, accel, onPick, disabled, checked }: {
  label: string; accel: string; onPick: () => void; disabled?: boolean; checked?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      disabled={disabled ?? false}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white hover:bg-[var(--mt5-border)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="w-3 shrink-0 text-[var(--mt5-blue-link)]" aria-hidden>{checked ? '✓' : ''}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] text-[var(--mt5-muted)]">{accel}</span>
    </button>
  );
}

/** A `datetime-local` value for an instant, and back. The control reads the local clock. */
const dtLocal = (ms: number | null): string =>
  ms === null ? '' : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * MetaTrader's `Alert Editor` — its title, its nine fields in its order, and its three buttons
 * `OK` `Test` `Cancel` with OK focused (docs/mt5/09-toolbox.md 924-927).
 *
 * `Action:` and `Source:` are the two fields this terminal cannot fully back, so they are present
 * and visibly disabled with the reason on each option, rather than drawn as if they worked:
 * MetaTrader's Sound and File actions reach the terminal's own Sounds folder and local files, and
 * Mail goes through the terminal's SMTP settings, none of which a browser tab has. The one action
 * it can perform it performs for real, and `Test` performs it now.
 */
function AlertEditor({ draft, digits, onChange, onOk, onTest, onCancel }: {
  draft: AlertDraft;
  digits: number;
  onChange: (d: AlertDraft) => void;
  onOk: (d: AlertDraft) => void;
  onTest: (d: AlertDraft) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const timeCondition = draft.condition === 'time=';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Alert Editor"
      className="fixed inset-0 z-[80] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <form
        onSubmit={(e) => { e.preventDefault(); onOk(draft); }}
        className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-auto sm:max-w-[420px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="text-[15px] font-semibold leading-tight">Alert Editor</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5 text-[12px]">
          <label className="mb-2 flex items-center gap-2">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.target.checked })} />
            <span>Enable</span>
          </label>

          <Field label="Action:">
            <select
              value="notification"
              onChange={() => { /* the three others are disabled options; nothing to select */ }}
              className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            >
              <option value="notification">Notification</option>
              <option value="sound" disabled>Sound (no sound files on this platform)</option>
              <option value="file" disabled>File (a browser cannot run one)</option>
              <option value="mail" disabled>Mail (this terminal has no mail server)</option>
            </select>
          </Field>

          <Field label="Expiration:">
            <input
              type="datetime-local"
              aria-label="Expiration"
              value={dtLocal(draft.expiresAtMs)}
              onChange={(e) => onChange({ ...draft, expiresAtMs: e.target.value ? new Date(e.target.value).getTime() : null })}
              className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            />
          </Field>

          {/* One symbol, because the watcher runs against the open chart's price: an alert on
              anything else would sit in the list and never fire. */}
          <Field label="Symbol:">
            <input
              value={draft.symbol}
              readOnly
              aria-label="Symbol"
              title="Alerts are checked against the open chart's symbol."
              className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-1.5 py-1 text-[var(--mt5-muted)] outline-none"
            />
          </Field>

          <Field label="Condition:">
            <select
              value={draft.condition}
              aria-label="Condition"
              onChange={(e) => onChange({ ...draft, condition: e.target.value as AlertCondition })}
              className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            >
              {ALERT_CONDITIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <p className="mb-2 text-[10px] leading-snug text-[var(--mt5-muted)]">
            MetaTrader also offers Bid and Ask conditions. This platform quotes one price per symbol,
            so there is no bid, no ask and no spread to compare, and Volume is not published at all.
          </p>

          <Field label="Value:">
            {timeCondition ? (
              <input
                value={draft.timeHHMM}
                aria-label="Value"
                placeholder="15:00"
                onChange={(e) => onChange({ ...draft, timeHHMM: e.target.value })}
                className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
              />
            ) : (
              <input
                value={String(draft.price)}
                aria-label="Value"
                inputMode="decimal"
                onChange={(e) => onChange({ ...draft, price: Number(e.target.value) })}
                className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
              />
            )}
          </Field>
          {timeCondition ? (
            // MetaTrader's own wording for this field: "Specify the local computer time in the
            // format "HH:MM"" (09-toolbox.md 937-938). It is the one field on the tab that is not
            // in the server's time zone.
            <p className="mb-2 text-[10px] leading-snug text-[var(--mt5-muted)]">Local computer time, HH:MM.</p>
          ) : (
            <p className="mb-2 text-[10px] leading-snug text-[var(--mt5-muted)]">Price to {digits} decimal places.</p>
          )}

          <Field label="Source:">
            <span className="flex gap-1">
              <input
                value=""
                readOnly
                aria-label="Source"
                title="MetaTrader browses for a sound file or a mail template here; a browser tab has neither."
                className="w-full rounded border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-1.5 py-1 text-[var(--mt5-muted)] outline-none"
              />
              <button type="button" disabled title="No file to browse for on this platform." className="shrink-0 rounded border border-[var(--mt5-border)] px-2 text-[var(--mt5-muted)] disabled:cursor-not-allowed disabled:opacity-40">...</button>
            </span>
          </Field>

          <Field label="Timeout:">
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                aria-label="Timeout"
                value={draft.timeoutS}
                onChange={(e) => onChange({ ...draft, timeoutS: Math.max(1, Number(e.target.value) || 1) })}
                className="w-24 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
              />
              <span className="text-[var(--mt5-muted)]">sec</span>
            </span>
          </Field>

          <Field label="Maximum iterations:">
            <input
              type="number"
              min={1}
              aria-label="Maximum iterations"
              value={draft.limit}
              onChange={(e) => onChange({ ...draft, limit: Math.max(1, Number(e.target.value) || 1) })}
              className="w-24 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--mt5-border)] px-3 py-2.5">
          <button type="submit" autoFocus className="rounded bg-[var(--mt5-blue)] px-3 py-1 text-[12px] font-semibold text-white">OK</button>
          <button type="button" onClick={() => onTest(draft)} className="rounded border border-[var(--mt5-border)] px-3 py-1 text-[12px] text-white">Test</button>
          <button type="button" onClick={onCancel} className="rounded border border-[var(--mt5-border)] px-3 py-1 text-[12px] text-[var(--mt5-muted)]">Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** One labelled row of the Alert Editor: MetaTrader's label on the left, its control on the right. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-2">
      <span className="w-32 shrink-0 text-[var(--mt5-muted)]">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/**
 * MetaTrader's mobile position entry: "SYMBOL, side volume" over "entry → current", with the result
 * on the right. The side and the result carry the colour — blue for buy and for profit, red for sell
 * and for loss — which is MetaTrader's pairing throughout.
 */
function PositionRow({
  symbol, direction, lots, from, to, profit, profitCents, note, className, onOpenMenu,
}: {
  symbol: string; direction: string; lots: string; from: string; to: string;
  profit: string; profitCents: number; note: string | null; className?: string;
  /** Present on a LIVE position only: MetaTrader opens the position menu from this row. */
  onOpenMenu?: (() => void) | undefined;
}) {
  const buy = direction === 'buy';
  const Tag = onOpenMenu ? 'button' : 'div';
  return (
    <Tag
      {...(onOpenMenu ? { type: 'button' as const, onClick: onOpenMenu, 'aria-label': `Position menu for ${symbol} ${direction} ${lots}` } : {})}
      className={cn(
        'flex w-full items-start justify-between gap-2 border-b border-[var(--mt5-border)]/60 px-3 py-2 text-left',
        onOpenMenu && 'transition hover:bg-[var(--mt5-raised)]',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-white">
          {symbol},{' '}
          <span className={buy ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]'}>{direction} {lots}</span>
        </div>
        <div className="font-mono text-[11px] text-[var(--mt5-muted)]">{from} → {to}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('font-mono text-[12px] font-semibold tabular-nums', profitCents > 0 ? 'text-[var(--mt5-blue)]' : profitCents < 0 ? 'text-[var(--mt5-red)]' : 'text-[#ffffff]')}>{profit}</div>
        {note ? <div className="font-mono text-[10px] text-[var(--mt5-muted)]">{note}</div> : null}
      </div>
    </Tag>
  );
}

/**
 * A pending order in the Trade grid, in MetaTrader's shared ten columns.
 *
 * What goes where, and why each cell reads as it does (docs/mt5/09-toolbox.md 280-300):
 *
 *   Ticket    MetaTrader's `Order` number for a pending order rather than a position ticket. These
 *             orders have an id and no ticket number, so the id's first characters stand in, which
 *             is the same stand-in `ticketLabel` makes for a position awaiting its number.
 *   Time      when the order was ARMED. MetaTrader's `YYYY.MM.DD HH:MM:SS`, server time.
 *   Type      `buy limit`, `sell stop` and so on, lowercase, which is how MetaTrader renders it and
 *             the only thing in the grid that tells a pending row from a position row.
 *   Volume    `requested / filled`, verbatim: *"volume requested in the pending order, and volume
 *             covered by the deal"*, e.g. `0.01 / 0`. Nothing is filled while it waits, so `/ 0`.
 *   Price     the TRIGGER, which is this order's own price, then the market's in the ninth column.
 *   Profit    MetaTrader puts the order's `State` in the last column for a pending row, because a
 *             waiting order has no profit. `placed` is MetaTrader's own word for one that is armed.
 */
function PendingGridRow({
  order, digits, nowRate, px, lots, onCancel,
}: {
  order: PendingOrderDto;
  digits: number;
  nowRate: number | null;
  px: (rate: number | null) => string;
  lots: (stakeCents: number) => string;
  onCancel: () => void;
}) {
  const buy = order.kind === 'buyLimit' || order.kind === 'buyStop';
  return (
    <tr data-pending-order={order.id} className="border-t border-[var(--mt5-border)]/60 hover:bg-[var(--mt5-raised)]">
      <Td first>{order.symbol}</Td>
      <Td>{order.id.slice(0, 8)}</Td>
      <Td>{stamp(order.createdAtMs)}</Td>
      <Td className={buy ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]'}>{PENDING_LABELS[order.kind].toLowerCase()}</Td>
      <Td>{lots(order.stakeCents)} / 0</Td>
      <Td>{order.triggerPrice.toFixed(digits)}</Td>
      <Td><span className="text-[var(--mt5-muted)]">{order.slPrice === null ? '' : order.slPrice.toFixed(digits)}</span></Td>
      <Td><span className="text-[var(--mt5-muted)]">{order.tpPrice === null ? '' : order.tpPrice.toFixed(digits)}</span></Td>
      <Td>{px(nowRate)}</Td>
      <Td>
        <span className="flex items-center justify-end gap-2">
          <span className="text-[var(--mt5-muted)]">placed</span>
          {/* MetaTrader deletes a pending order from its own row. Nothing is debited while an order
              waits, so there is nothing to settle: it simply stops existing. */}
          <button
            type="button"
            onClick={onCancel}
            aria-label="Delete order"
            title="Delete this order. Nothing has been staked, so there is nothing to settle."
            className="rounded-sm border border-[var(--mt5-border)] px-1.5 text-[11px] font-normal text-[var(--mt5-muted)] transition hover:border-[var(--mt5-red)] hover:text-[var(--mt5-red)]"
          >
            ×
          </button>
        </span>
      </Td>
    </tr>
  );
}

/** The same order on a phone, where there is no grid: what it is, at what level, and a delete. */
function PendingPhoneRow({
  order, digits, lots, onCancel,
}: {
  order: PendingOrderDto;
  digits: number;
  lots: (stakeCents: number) => string;
  onCancel: () => void;
}) {
  const buy = order.kind === 'buyLimit' || order.kind === 'buyStop';
  return (
    <div
      data-pending-order={order.id}
      className="flex w-full items-start justify-between gap-2 border-b border-[var(--mt5-border)]/60 px-3 py-2 sm:hidden"
    >
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-white">
          {order.symbol},{' '}
          <span className={buy ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]'}>
            {PENDING_LABELS[order.kind].toLowerCase()} {lots(order.stakeCents)}
          </span>
        </div>
        <div className="font-mono text-[11px] text-[var(--mt5-muted)]">at {order.triggerPrice.toFixed(digits)}</div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Delete order"
        className="shrink-0 rounded-sm border border-[var(--mt5-border)] px-2 py-1 text-[11px] text-[var(--mt5-muted)] transition hover:border-[var(--mt5-red)] hover:text-[var(--mt5-red)]"
      >
        Delete
      </button>
    </div>
  );
}

function Figure({ label, value, tone, className }: { label: string; value: string; tone?: 'up' | 'down' | undefined; className?: string | undefined }) {
  return (
    <span className={cn('flex shrink-0 items-baseline gap-1.5 whitespace-nowrap', className)}>
      {/* No `uppercase`: MetaTrader's own casing is part of the label ("Free Margin:", not "FREE
          MARGIN"), and forcing it here would throw away the thing the screenshots were read for. */}
      <span className="text-[10px] tracking-wide text-[var(--mt5-muted)]">{label}</span>
      {/* Equity carries this tone when the floating P/L is non-zero, so it is money, not a price:
          MetaTrader's blue for a profit, red for a loss. */}
      <span className={cn('font-mono text-[12px] font-semibold tabular-nums', tone === 'up' ? 'text-[var(--mt5-blue)]' : tone === 'down' ? 'text-[var(--mt5-red)]' : 'text-[#ffffff]')}>{value}</span>
    </span>
  );
}

/**
 * MetaTrader's grid alignment: `Symbol` left, everything else right, HEADER INCLUDED.
 *
 * docs/mt5/09-toolbox.md 266-268 reads it off the screenshots: "`Symbol` is left-aligned … every
 * column from `Ticket` rightwards is right-aligned, including its header", and :269 puts `Profit`
 * rightmost. It is not decoration. These columns are tickets, volumes, prices and money, and a
 * column of right-aligned figures lines its decimal points up so the eye can compare rows; left
 * aligning them is most of why this read as a web table rather than a terminal grid.
 *
 * The first column is the one exception because it holds a NAME, and names read from the left.
 */
function Table({ head, children, left = [0], grow }: {
  head: string[];
  children: React.ReactNode;
  /**
   * Which columns are LEFT-aligned, headers and cells alike.
   *
   * MetaTrader right-aligns a grid "from `Ticket` rightwards, including its header"
   * (09-toolbox.md 268), which makes the first column the only left one on the Trade tab. A grid
   * whose middle column is a NAME rather than a figure needs one more: the Calendar's `Event` is
   * prose, and right-aligning its header while its cells read left left a gap down the middle with
   * the header floating off the end of it.
   */
  left?: readonly number[];
  /**
   * Which column absorbs the slack.
   *
   * A grid of figures wants every column hugging its content, which is the default here. A grid
   * whose rows carry PROSE does not: an article title, an indicator name or a log message is the
   * column a trader is reading, and leaving the table to share the width evenly truncates it at a
   * third of the panel while the date column floats in 600px of nothing. `width: 100%` on one
   * header is the table-layout way to say "this one takes what is left"; the cell still needs
   * `max-w-0` to be allowed to truncate below its content.
   */
  grow?: number;
}) {
  return (
    <table className="w-full border-collapse text-right font-mono text-[11px] tabular-nums">
      <thead>
        <tr className="text-[var(--mt5-muted)]">
          {head.map((h, i) => (
            <th
              key={`${h}:${i}`}
              className={cn('whitespace-nowrap px-2 py-1 font-normal', left.includes(i) && 'text-left', grow === i && 'w-full')}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** A cell. `first` carries the symbol, so it keeps the left alignment names need. */
function Td({ children, className, first }: { children: React.ReactNode; className?: string; first?: boolean }) {
  return <td className={cn('whitespace-nowrap px-2 py-1', first && 'text-left', className)}>{children}</td>;
}

/**
 * The status line under a tab's grid: what the grid is showing, and what the filters have done to
 * it. MetaTrader puts the same kind of summary under its own panels.
 *
 * `pr-20` is not decoration. The support bubble is fixed to the bottom-right corner of the window
 * and floats over this panel, so without it the right-most item is drawn underneath the bubble.
 */
function ToolboxFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--mt5-border)] py-1.5 pl-3 pr-20 text-[10px] text-[var(--mt5-muted)]">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-center text-[11px] leading-snug text-[var(--mt5-muted)]">{children}</div>;
}

/**
 * MetaTrader's History tab.
 *
 * The grid is MetaTrader's own, verbatim and in its order — `Time | Symbol | Deal | Type |
 * Direction | Volume | Price | S / L | T / P | Commission | Profit | Change` (docs/mt5/09-toolbox.md
 * 610-616), which is also what `TOOLBOX_COLUMNS.history` already held while this tab drew eight
 * columns of its own with an invented `Close` among them. Time is leftmost and carries the sort
 * triangle (:618).
 *
 * The rows are the ones the /history screen already derives: `orderRows`, `dealRows` and
 * `positionRows` in lib/history/mt5history, which is where the three representations and their
 * arithmetic are documented and unit-tested. Nothing about history is computed twice.
 *
 * FOUR REPRESENTATIONS, ONE COLUMN SET. MetaTrader publishes a default visible set for Deals only
 * (:610, and :620-623 records that even that is not stable across builds), and its `Orders & Deals`
 * mode is "a tree view of all trading operations" (:665) — one grid holding both record types. So
 * all four modes render into the one documented column set, and a cell a representation has no
 * field for is left EMPTY rather than filled with something invented.
 *
 * Cells this platform cannot fill, and why:
 *
 *   S / L, T / P   The API returns no levels for a settled contract: the engine records the open,
 *                  the close and the result, and nothing else. MetaTrader draws an unset level as a
 *                  blank cell (:336-338), which is what the Trade tab above does too, so the empty
 *                  cell here says exactly what is true.
 *   Direction      "direction of the deal relative to the current position" (:631) — a DEAL field.
 *                  An order is a request and a position is a round trip; neither has one, so the
 *                  cell is empty in those two modes rather than repeating the Type.
 *   Commission     Blank on an order (nothing is charged for a request) and on a balance operation;
 *                  `0.00` on a deal, which is not a placeholder but this platform's real figure —
 *                  the house margin is inside the payout rather than charged per trade, which is
 *                  the same fact `moneySummary` documents.
 *   Change         Blank wherever no profit is locked in: an entry deal, an order, a deposit. On an
 *                  exit it is the asset price's own move over the round trip (:636) — see
 *                  `priceChangePct`, which is why a winning sell can print a negative Change.
 *   Deal           MetaTrader's deal ticket. One contract here is one engine record with one
 *                  ticket (see `positionTicket`), so the request, the two executions and the round
 *                  trip all carry the same number. That is why the Russian build's extra `Order`
 *                  column (:620-622) is not drawn beside it: it would repeat this one.
 *
 * The position's CLOSE price is not dropped either: `Price` is the open price, as it is in
 * MetaTrader's own grids and in the Trade tab above, and the close is the `out` deal's own Price in
 * Deals mode — the same records seen the other way round (:662-664).
 */
type HistoryMode = 'positions' | 'deals' | 'orders' | 'ordersdeals';

/** The four modes, in the order the context menu lists them (09-toolbox.md 648-655). */
const HISTORY_MODES: ReadonlyArray<{ key: HistoryMode; label: string }> = [
  { key: 'positions', label: 'Positions' },
  { key: 'deals', label: 'Deals' },
  { key: 'orders', label: 'Orders' },
  { key: 'ordersdeals', label: 'Orders & Deals' },
];

/** One row of the grid, whichever representation produced it. */
interface GridRow {
  id: string;
  timeMs: number;
  symbol: string;
  ticket: string;
  type: string;
  side: 'buy' | 'sell' | null;
  direction: string;
  volume: string;
  price: string;
  commission: string;
  profitCents: number | null;
  changePct: number | null;
  /** Orders & Deals is a tree: a deal hangs under the request that produced it. */
  child: boolean;
}

const dealGrid = (r: DealRow, digits: number): GridRow => ({
  id: r.id,
  timeMs: r.atMs,
  // A balance operation has no instrument: MetaTrader blanks the Symbol cell and puts the
  // operation's name in Type (09-toolbox.md 643-644).
  symbol: r.kind === 'balance' ? '' : r.symbol,
  ticket: r.ticket,
  type: r.side ?? r.label ?? '',
  side: r.side,
  direction: r.entry ?? '',
  volume: r.lots ?? '',
  price: r.lots === null ? '' : priceText(r.price, digits),
  commission: r.kind === 'trade' ? '0.00' : '',
  // "For entry trades the zero profit is shown" (09-toolbox.md 635): an `in` deal prints 0.00.
  profitCents: r.entry === 'in' ? 0 : r.amountCents,
  changePct: r.entry === 'out' ? priceChangePct(r.openPrice, r.price) : null,
  child: false,
});

const orderGrid = (r: OrderRow, digits: number): GridRow => ({
  id: r.id,
  timeMs: r.atMs,
  symbol: r.symbol,
  ticket: r.ticket,
  // A cancelled request types as "canceled buy" / "canceled sell" and its result is zeroed
  // (09-toolbox.md 632), which is how MetaTrader states a cancellation inside this column set
  // rather than through a State column the set does not have.
  type: r.state === 'CANCELED' ? `canceled ${r.side}` : r.side,
  side: r.side,
  direction: '',
  volume: r.lots,
  price: r.state === 'CANCELED' ? '' : priceText(r.price, digits),
  commission: '',
  profitCents: null,
  changePct: null,
  child: false,
});

const positionGrid = (r: ClosedRow, digits: number): GridRow => ({
  id: r.id,
  timeMs: r.atMs,
  symbol: r.kind === 'balance' ? '' : r.symbol,
  ticket: r.ticket,
  type: r.side ?? r.label ?? '',
  side: r.side,
  direction: '',
  volume: r.lots ?? '',
  price: r.lots === null ? '' : priceText(r.entryPrice, digits),
  commission: r.kind === 'trade' ? '0.00' : '',
  profitCents: r.amountCents,
  changePct: r.kind === 'trade' ? priceChangePct(r.entryPrice, r.exitPrice) : null,
  child: false,
});

function HistoryTab({ symbol, digits, lots, amount, token }: {
  symbol: string;
  digits: number;
  lots: (stakeCents: number) => string;
  /** MetaTrader's bare grid money: no currency code anywhere on this tab (09-toolbox.md 729). */
  amount: (cents: number) => string;
  token: string | null;
}) {
  // Deals, because MetaTrader opens on Deals — it is the one mode its menu ticks (09-toolbox.md 658).
  const [mode, setMode] = useState<HistoryMode>('deals');
  // All History: the period block publishes no tick (:669-674), so this is a choice, and it is the
  // one preset that cannot hide a record from a trader who came here to find one.
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  // Ascending, which is the direction of the triangle on the Time header (09-toolbox.md 615, 618).
  const [ascending, setAscending] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const range: Range = useMemo(
    () => periodRange(period, Date.now(), {
      ...(custom.from ? { fromMs: new Date(`${custom.from}T00:00:00`).getTime() } : {}),
      ...(custom.to ? { toMs: new Date(`${custom.to}T00:00:00`).getTime() + 86_400_000 } : {}),
    }),
    [period, custom.from, custom.to],
  );

  const positionsQ = usePositions('all');
  const transactionsQ = useTransactions();
  const positions: PositionDto[] = useMemo(
    () => (positionsQ.data?.pages ?? []).flatMap((p) => p.items),
    [positionsQ.data],
  );
  const transactions: TransactionDto[] = useMemo(
    () => (transactionsQ.data?.pages ?? []).flatMap((p) => p.items),
    [transactionsQ.data],
  );
  // Both feeds are newest-first and cursor-paged, so a period filter that only ever saw the first
  // page would under-report its own window. Same loop as the /history screen's.
  useAutoPage(positionsQ, positions.at(-1)?.openedAt, range.fromMs);
  useAutoPage(transactionsQ, transactions.at(-1)?.ts, range.fromMs);

  const orders = useMemo(() => orderRows(positions, range, symbol, lots), [positions, range, symbol, lots]);
  const deals = useMemo(() => dealRows(positions, transactions, range, symbol, lots), [positions, transactions, range, symbol, lots]);
  const closed = useMemo(() => positionRows(positions, transactions, range, symbol, lots), [positions, transactions, range, symbol, lots]);

  /**
   * The grid, sorted on the Time column it draws.
   *
   * `sortRows` keys on the ROUND TRIP's open and close times, which is what the mobile screen's
   * sort menu offers; the Time cell here is the record's own stamp, so an entry deal would sort by
   * its position's close time and land away from the time printed beside it.
   */
  const grid: GridRow[] = useMemo(() => {
    const dir = ascending ? 1 : -1;
    const byTime = <T extends { timeMs: number }>(rows: T[]): T[] => rows.sort((a, b) => dir * (a.timeMs - b.timeMs));
    if (mode === 'orders') return byTime(orders.map((r) => orderGrid(r, digits)));
    if (mode === 'positions') return byTime(closed.map((r) => positionGrid(r, digits)));
    if (mode === 'deals') return byTime(deals.map((r) => dealGrid(r, digits)));
    /**
     * Orders & Deals: "a tree view of all trading operations showing how the trade requests were
     * processed" (09-toolbox.md 665). Every request here is filled the instant it is placed, so the
     * tree is always exactly one level deep and never worth collapsing; it is drawn expanded, with
     * each execution indented under the request that produced it. A deposit has no request above
     * it, so it stands at the top level where MetaTrader's tree also leaves it.
     */
    const byTicket = new Map<string, DealRow[]>();
    for (const d of deals) {
      if (d.kind === 'balance') continue;
      const list = byTicket.get(d.ticket);
      if (list) list.push(d); else byTicket.set(d.ticket, [d]);
    }
    const groups: Array<{ at: number; rows: GridRow[] }> = orders.map((o) => ({
      at: o.atMs,
      rows: [
        orderGrid(o, digits),
        ...(byTicket.get(o.ticket) ?? [])
          .slice()
          .sort((a, b) => a.atMs - b.atMs)
          .map((d) => ({ ...dealGrid(d, digits), child: true })),
      ],
    }));
    for (const d of deals) if (d.kind === 'balance') groups.push({ at: d.atMs, rows: [dealGrid(d, digits)] });
    return groups.sort((a, b) => dir * (a.at - b.at)).flatMap((g) => g.rows);
  }, [mode, ascending, orders, deals, closed, digits]);

  /**
   * The summary strip is the ACCOUNT's history over the period, not the current mode's rows, which
   * is why it is computed from the deals in every mode: the deals are the money that moved.
   *
   * Its Profit and the Profit column's own total are two different quantities and are allowed to
   * disagree — they disagree in MetaTrader's own screenshot too (09-toolbox.md 732-733, flagged
   * there as unexplained): the strip is the account's result, the total is the sum of the cells
   * above it, which in Deals mode also carries every deposit and withdrawal.
   */
  const strip = historyStrip(deals);
  const profitTotal = grid.reduce((n, r) => n + (r.profitCents ?? 0), 0);
  const head = [...(TOOLBOX_COLUMNS.history ?? [])];

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  if (!token) return <Empty>Sign in to see your trade history.</Empty>;

  return (
    <div onContextMenu={openMenu} data-history-mode={mode}>
      {/* MetaTrader shows history as a wide grid on a desktop and as two-line entries on a phone.
          Twelve columns cannot be read at 390px, which is what the Trade tab above says about ten. */}
      <div className="sm:hidden">
        {grid.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-2 border-b border-[var(--mt5-border)]/60 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-white">
                {r.symbol ? `${r.symbol}, ` : ''}
                <span className={r.side === 'buy' ? 'text-[var(--mt5-blue)]' : r.side === 'sell' ? 'text-[var(--mt5-red)]' : ''}>
                  {r.type} {r.volume}
                </span>
                {r.direction ? <span className="text-[var(--mt5-muted)]"> {r.direction}</span> : null}
              </div>
              <div className="font-mono text-[11px] text-[var(--mt5-muted)]">{stamp(r.timeMs)} {r.price}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className={cn('font-mono text-[12px] font-semibold tabular-nums', toneClass(r.profitCents))}>
                {r.profitCents === null ? '' : amount(r.profitCents)}
              </div>
              <div className={cn('font-mono text-[10px]', toneClass(r.changePct))}>{changeText(r.changePct)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden sm:block">
        <Table head={head}>
          {grid.map((r) => (
            <tr key={r.id} className="border-t border-[var(--mt5-border)]/60">
              <Td first className={r.child ? 'pl-6' : ''}>{stamp(r.timeMs)}</Td>
              <Td>{r.symbol}</Td>
              <Td>{r.ticket}</Td>
              <Td className={r.side === 'buy' ? 'text-[var(--mt5-blue)]' : r.side === 'sell' ? 'text-[var(--mt5-red)]' : ''}>{r.type}</Td>
              <Td>{r.direction}</Td>
              <Td>{r.volume}</Td>
              <Td>{r.price}</Td>
              {/* S / L and T / P: no level is recorded against a settled contract, and an unset
                  level is a blank cell in MetaTrader (09-toolbox.md 336-338). */}
              <Td>{''}</Td>
              <Td>{''}</Td>
              <Td>{r.commission}</Td>
              <Td className={cn('font-semibold', toneClass(r.profitCents))}>
                {r.profitCents === null ? '' : amount(r.profitCents)}
              </Td>
              {/* Blue for positive and red for negative, as MetaTrader colours this column
                  (09-toolbox.md 636). */}
              <Td className={toneClass(r.changePct)}>{changeText(r.changePct)}</Td>
            </tr>
          ))}
          {/* MetaTrader's summary strip, with its two right-aligned column totals sitting under
              Commission and Profit and nothing under Change (09-toolbox.md 722-733). Drawn as the
              grid's last row so the two totals land under their own columns, which is the whole
              point of putting them on the strip. No currency code anywhere on this line, "not even
              after Balance" (:729). */}
          <tr className="border-t border-[var(--mt5-border)] bg-[var(--mt5-raised)]">
            <td colSpan={9} className="whitespace-nowrap px-2 py-1 text-left text-[11px]" data-history-strip="">
              <span className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                <StripField label="Profit:" value={amount(strip.profitCents)} />
                <StripField label="Credit:" value={amount(strip.creditCents)} />
                <StripField label="Deposit:" value={amount(strip.depositCents)} />
                <StripField label="Withdrawal:" value={amount(strip.withdrawalCents)} />
                <StripField label="Balance:" value={amount(strip.balanceCents)} />
              </span>
            </td>
            <td className="whitespace-nowrap px-2 py-1 font-semibold">{amount(0)}</td>
            <td className={cn('whitespace-nowrap px-2 py-1 font-semibold', toneClass(profitTotal))}>{amount(profitTotal)}</td>
            <td />
          </tr>
        </Table>
      </div>

      {grid.length === 0 ? (
        <Empty>
          {positionsQ.isLoading || transactionsQ.isLoading
            ? 'Loading history…'
            : `No ${mode === 'orders' ? 'orders' : mode === 'positions' ? 'positions' : 'deals'} in this period.`}
        </Empty>
      ) : null}

      {/* The whole switch lives in the context menu: "There is no toolbar, no segmented control and
          no dropdown" (09-toolbox.md 657). The two blocks drawn are the two this platform can act
          on. MetaTrader's menu carries five more — New Order, Symbols ▸ and Volumes ▸, Report ▸ and
          Show on Charts ▸, Register as Signal — which are a second order ticket, a filter over one
          quoted instrument, a lots/units toggle for a platform that has no units, an HTML report
          generator and MQL5 signal registration; none of them exists here, and a menu item that
          does nothing is worse than an absent one. */}
      {menu ? (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-[70] cursor-default" />
          <div
            role="menu"
            data-history-menu=""
            className="fixed z-[71] w-52 overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[12px] shadow-2xl"
            style={{ left: Math.min(menu.x, 1200), top: menu.y }}
          >
            {HISTORY_MODES.map((m) => (
              <MenuItem key={m.key} checked={mode === m.key} label={m.label} onPick={() => { setMode(m.key); setMenu(null); }} />
            ))}
            <div className="my-1 border-t border-[var(--mt5-border)]" />
            {DESKTOP_PERIODS.map((p) => (
              <MenuItem
                key={p.key}
                checked={period === p.key}
                label={p.label}
                // The gear MetaTrader puts on Custom Period, which is the only item that opens
                // anything (09-toolbox.md 673-676).
                glyph={p.key === 'custom' ? '⚙' : undefined}
                onPick={() => { setPeriod(p.key); if (p.key !== 'custom') setMenu(null); }}
              />
            ))}
            {period === 'custom' ? (
              <div className="flex flex-col gap-1.5 border-t border-[var(--mt5-border)] px-3 py-2">
                <label className="flex items-center gap-2 text-[11px] text-[var(--mt5-muted)]">
                  From
                  <input
                    type="date"
                    aria-label="Custom period from"
                    value={custom.from}
                    onChange={(e) => setCustom({ ...custom, from: e.target.value })}
                    className="flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
                  />
                </label>
                <label className="flex items-center gap-2 text-[11px] text-[var(--mt5-muted)]">
                  To
                  <input
                    type="date"
                    aria-label="Custom period to"
                    value={custom.to}
                    onChange={(e) => setCustom({ ...custom, to: e.target.value })}
                    className="flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
                  />
                </label>
                <button type="button" onClick={() => setMenu(null)} className="self-end rounded bg-[var(--mt5-blue)] px-2 py-0.5 text-[11px] font-semibold text-white">Apply</button>
              </div>
            ) : null}
            <div className="my-1 border-t border-[var(--mt5-border)]" />
            <MenuItem
              checked={false}
              label={ascending ? 'Sort: Time ▲' : 'Sort: Time ▼'}
              onPick={() => { setAscending((v) => !v); setMenu(null); }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Blue up, red down, nothing at zero — MetaTrader's pairing, and never green (09-toolbox.md 646). */
const toneClass = (n: number | null): string =>
  n === null || n === 0 ? '' : n > 0 ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]';

function StripField({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-[var(--mt5-muted)]">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function MenuItem({ checked, label, glyph, onPick }: {
  checked: boolean; label: string; glyph?: string | undefined; onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white hover:bg-[var(--mt5-border)]"
    >
      <span className="w-3 shrink-0 text-[var(--mt5-blue-link)]" aria-hidden>{checked ? '✓' : glyph ?? ''}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/**
 * Pull older pages until the loaded tail reaches past the start of the period, then stop.
 *
 * The same loop the /history screen runs, and deliberately a copy: it is eight lines of react-query
 * paging shape that would have to become a module of its own to be shared, and the two screens page
 * the same two feeds for the same reason.
 */
function useAutoPage(
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; data?: { pages: unknown[] } | undefined },
  oldestMs: number | undefined,
  fromMs: number,
): void {
  const pages = q.data?.pages.length ?? 0;
  const needMore = q.hasNextPage && !q.isFetchingNextPage && pages < 20
    && (oldestMs === undefined || oldestMs >= fromMs);
  useEffect(() => {
    if (needMore) void q.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needMore]);
}

/**
 * MetaTrader's Exposure tab.
 *
 * Its columns are MetaTrader's: `Assets`, `Volume`, `Rate`, the deposit currency's own code, and
 * `Graph`. Two of them are worth a word:
 *
 *   Assets  is the INSTRUMENT here, not a money figure. MetaQuotes uses the same word for both a
 *           column header and a money field elsewhere on the same screen, and never flags it.
 *   Graph   a bar from a centre zero: "long positions are displayed with blue bars and short
 *           positions are displayed with red ones".
 *
 * The arithmetic is `exposureRows` in the shared package, which is unit-tested there: a buy and a
 * sell of equal size on one symbol are flat in volume and NOT flat in money, because both stakes
 * are still at risk.
 */
function ExposureTab({ symbol, live, currency, fmt }: {
  symbol: string;
  live: { direction: 'buy' | 'sell'; stakeCents: number } | null | undefined;
  currency: string;
  fmt: (cents: number) => string;
}) {
  const rows = exposureRows(
    live ? [{ symbol, direction: live.direction, stakeCents: live.stakeCents }] : [],
  );
  if (rows.length === 0) return <Empty>No open positions, so nothing is exposed.</Empty>;
  const headers = [...(TOOLBOX_COLUMNS.exposure ?? [])];
  headers[3] = currency;
  return (
    <table className="w-full table-fixed border-collapse text-[11px]">
      <thead className="bg-[var(--mt5-raised)] text-[var(--mt5-muted)]">
        <tr>
          {headers.map((h, i) => (
            <th key={i} scope="col" className="border-b border-[var(--mt5-border)] px-2 py-1.5 text-left font-semibold">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const long = r.netLots >= 0;
          return (
            <tr key={r.symbol} className="border-b border-[var(--mt5-border)]">
              <td className="truncate px-2 py-1.5 font-semibold">{r.symbol}</td>
              <td className="truncate px-2 py-1.5 font-mono tabular-nums">{r.netLots.toFixed(2)}</td>
              {/* Rate is 1 because a contract is staked and settled in the deposit currency: there
                  is no conversion to make, and printing an invented FX rate would be worse. */}
              <td className="truncate px-2 py-1.5 font-mono tabular-nums text-[var(--mt5-muted)]">1.00</td>
              <td className="truncate px-2 py-1.5 font-mono tabular-nums">{fmt(r.valueCents)}</td>
              <td className="px-2 py-1.5">
                {/* A bar from a centre zero: blue for long, red for short, as MetaTrader draws it. */}
                <span className="flex h-2 w-full items-center" aria-label={`${long ? 'Long' : 'Short'} ${(r.share * 100).toFixed(0)}%`}>
                  <span className="flex h-2 flex-1 justify-end">
                    {long ? null : <span className="h-2 rounded-l-sm" style={{ width: `${r.share * 100}%`, background: '#f23645' }} />}
                  </span>
                  <span aria-hidden className="h-3 w-px bg-[var(--mt5-border)]" />
                  <span className="flex h-2 flex-1">
                    {long ? <span className="h-2 rounded-r-sm" style={{ width: `${r.share * 100}%`, background: '#3183ff' }} /> : null}
                  </span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One open position, as MetaTrader's Trade tab draws one.
 *
 * Columns, in MetaTrader's order (docs/mt5/09-toolbox.md 258):
 * `Symbol | Ticket | Time | Type | Volume | Price | S / L | T / P | Price | Profit`.
 *
 * Extracted from the single hard-coded row this grid used to contain. It was written for the one
 * position the client could hold, so everything it showed came from a `live` captured in the
 * Toolbox's own scope; a grid of positions needs each row to speak only about its own.
 */
function TradeGridRow({
  pos, symbol, digits, continuous, earlyCloseEnabled, nowRate, px, lots, money,
  onOpenMenu, onClose, onStepTp,
}: {
  pos: ActivePosition;
  symbol: string;
  digits: number;
  continuous: boolean;
  earlyCloseEnabled: boolean;
  nowRate: number | null;
  px: (rate: number | null) => string;
  lots: (stakeCents: number) => string;
  money: ReturnType<typeof useDisplayMoney>;
  onOpenMenu: () => void;
  onClose: () => void;
  onStepTp: (dir: 1 | -1) => void;
}) {
  /**
   * The ENGINE's levels for THIS position, never the ticket's working copy.
   *
   * Once a position is open the copy a trader drags around on the ticket is no longer what will
   * fire: the engine holds the levels and settles on them. With several positions open the ticket's
   * copy cannot stand in for any of them, so a row shows its own or shows nothing.
   */
  const slPrice = pos.slPrice;
  const tpPrice = pos.tpPrice;
  return (
    <tr
      className="cursor-pointer border-t border-[var(--mt5-border)]/60 hover:bg-[var(--mt5-raised)]"
      onClick={onOpenMenu}
      title="Open the position menu"
    >
      <Td first>{symbol}</Td>
      <Td>{ticketLabel(pos)}</Td>
      {/* MetaTrader's Time column: `YYYY.MM.DD HH:MM` plus the seconds its own rendered values
          carry, in the broker's server time (09-toolbox.md 289-291). */}
      <Td>{pos.expiresAtMs ? stamp(pos.expiresAtMs - pos.durationS * 1000) : '-'}</Td>
      <Td className={pos.direction === 'buy' ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]'}>{pos.direction}</Td>
      <Td>{lots(pos.stakeCents)}</Td>
      <Td>{px(pos.entryRate)}</Td>
      <Td>
        {/* MetaTrader's S/L column: the LEVEL, as a price. An UNSET level leaves the cell BLANK and
            draws no cross (09-toolbox.md 336-338, "the cell is blank and no × is drawn"). */}
        <span
          className="text-[var(--mt5-muted)]"
          title={continuous
            ? 'The stop closes this position at its price, for what it is worth there. Stops processing is performed on the broker side.'
            : 'This contract settles a loss at expiry, so the stop cannot fire. The level is the trader’s.'}
        >
          {slPrice === null ? '' : slPrice.toFixed(digits)}
        </span>
      </Td>
      <Td>
        {/* MetaTrader's T/P column, stepped in the instrument's own points. Unset, it is blank for
            the same reason the S/L cell is. The steppers do not open the menu the row click does. */}
        {continuous ? (
          <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => onStepTp(-1)} className="px-1 text-[var(--mt5-muted)] hover:text-white disabled:opacity-40" aria-label="Lower take profit">−</button>
            <span className="min-w-16 text-center">{tpPrice === null ? '' : tpPrice.toFixed(digits)}</span>
            <button type="button" onClick={() => onStepTp(1)} className="px-1 text-[var(--mt5-muted)] hover:text-white" aria-label="Raise take profit">+</button>
          </span>
        ) : (
          // A target that can never fire is not a setting, it is a decoration.
          <span className="text-[var(--mt5-muted)]" title="This brand settles every contract at expiry, so a target cannot close it early.">
            at expiry
          </span>
        )}
      </Td>
      <Td>{px(nowRate)}</Td>
      <Td className={cn('font-semibold', pos.livePnlCents > 0 ? 'text-[var(--mt5-blue)]' : pos.livePnlCents < 0 ? 'text-[var(--mt5-red)]' : '')}>
        <span className="flex items-center justify-end gap-2">
          {money.mt(pos.livePnlCents)}
          {/* MetaTrader closes a position from its row with a small ×. Shown only where the engine
              will honour a manual close, and it closes THIS row's position. */}
          {earlyCloseEnabled ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              disabled={pos.phase !== 'open' || !pos.sellable || !pos.positionId}
              aria-label="Close position"
              title={pos.sellable ? 'Close this position at the current price' : 'This contract settles at expiry'}
              className="rounded-sm border border-[var(--mt5-border)] px-1.5 text-[11px] font-normal text-[var(--mt5-muted)] transition hover:border-[var(--mt5-red)] hover:text-[var(--mt5-red)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ×
            </button>
          ) : null}
        </span>
      </Td>
    </tr>
  );
}

/**
 * MetaTrader's Economic Calendar.
 *
 * Specified in full at docs/mt5/09-toolbox.md 831-882 and built to that:
 *
 *   Columns  `Time | Currency | Event | Priority | Period | Actual | Forecast | Previous`
 *   Priority a blue fan, three levels, "a dot alone / dot + one arc / dot + two arcs", verified at
 *            10x. MetaQuotes never names the levels, so neither does this.
 *   Colour   verbatim: "If this value is less than the predicted one, the indicator is highlighted
 *            in red. If the current value is larger, the indicator is shown in blue." The
 *            screenshot tints the WHOLE ROW, and the pixels win over the prose.
 *   Figures  a comma thousands separator and NO space before `%`, which is the opposite of the
 *            account strip's spacing. Both are MetaQuotes'.
 *   Period   "By default, the calendar displays current week events, including past and upcoming
 *            events. Use the context menu to switch to another period."
 *   Filters  "by priority / by the currency of the country for which the indicator is published".
 *
 * The releases come from `calendarBetween`, which generates real indicators on their real
 * recurrence from a seed. Why generated rather than fetched is argued in packages/shared/calendar.
 */
function CalendarTab() {
  /**
   * Its own clock, at minute resolution and only while the tab is mounted.
   *
   * A calendar has to move: a release that was upcoming a minute ago has printed now, and the row
   * gains its Actual and its tint without the trader doing anything. Minute resolution because the
   * Time column is written to the minute, so anything finer would re-render for nothing.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [period, setPeriod] = useState<CalendarPeriod>('thisWeek');
  /** MetaTrader filters by priority and by currency, both from the context menu. */
  const [minPriority, setMinPriority] = useState<CalendarPriority>(1);
  const [currency, setCurrency] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number }>(null);

  const { fromMs, toMs } = calendarRange(period, nowMs);
  const all = useMemo(() => calendarBetween(fromMs, toMs, nowMs), [fromMs, toMs, nowMs]);
  const rows = all.filter((e) => e.priority >= minPriority && (currency === null || e.currency === currency));

  return (
    <div
      data-calendar-tab=""
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {/* Time and Event read left; every figure column reads right, as MetaTrader's grids do. */}
      <Table head={[...(TOOLBOX_COLUMNS.calendar ?? [])]} left={[0, 2]} grow={2}>
        {rows.map((e) => {
          /**
           * The row tint, on MetaTrader's own rule. Only a PUBLISHED reading can be compared, so a
           * release still to come is never tinted; that is the difference between "no surprise" and
           * "no number yet".
           */
          const surprise = e.actual === null || e.forecast === null ? 0 : e.actual - e.forecast;
          return (
            <tr
              key={e.id}
              className={cn(
                'border-t border-[var(--mt5-border)]/60',
                surprise < 0 ? 'bg-[var(--mt5-red)]/10' : surprise > 0 ? 'bg-[var(--mt5-blue)]/10' : '',
              )}
            >
              <Td first>{stamp(e.atMs)}</Td>
              <Td>{e.currency}</Td>
              <Td className="text-left">{e.event}</Td>
              <Td><span className="flex justify-end"><PriorityFan level={e.priority} /></span></Td>
              <Td className="text-[var(--mt5-muted)]">{e.period}</Td>
              <Td className={cn('font-semibold', surprise < 0 ? 'text-[var(--mt5-red)]' : surprise > 0 ? 'text-[var(--mt5-blue)]' : 'text-white')}>
                {calendarFigure(e.actual, e.unit, e.decimals)}
              </Td>
              <Td className="text-[var(--mt5-muted)]">{calendarFigure(e.forecast, e.unit, e.decimals)}</Td>
              <Td className="text-[var(--mt5-muted)]">{calendarFigure(e.previous, e.unit, e.decimals)}</Td>
            </tr>
          );
        })}
      </Table>

      {rows.length === 0 ? (
        <Empty>
          No releases in this period{currency === null ? '' : ` for ${currency}`}. Right-click to
          change the period or the filters.
        </Empty>
      ) : null}

      <ToolboxFooter>
        <span>{CALENDAR_PERIODS.find((p) => p.key === period)?.label}</span>
        <span>{rows.length} of {all.length} events</span>
        {currency === null ? null : <span>Currency: {currency}</span>}
        {minPriority > 1 ? <span>Priority {minPriority}+</span> : null}
        <span className="ml-auto">Times are the broker&apos;s server time, UTC.</span>
      </ToolboxFooter>

      {menu ? (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-[70] cursor-default" />
          <div
            role="menu"
            data-calendar-menu=""
            className="fixed z-[71] max-h-[70vh] w-56 overflow-y-auto rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[12px] shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {CALENDAR_PERIODS.map((p) => (
              <MenuItem key={p.key} checked={period === p.key} label={p.label} onPick={() => { setPeriod(p.key); setMenu(null); }} />
            ))}
            <div className="my-1 border-t border-[var(--mt5-border)]" />
            {/* "filter events in the list ... by priority". The three levels are the fan's. */}
            {([1, 2, 3] as const).map((lv) => (
              <MenuItem
                key={`p${lv}`}
                checked={minPriority === lv}
                label={lv === 1 ? 'All priorities' : `Priority ${lv} and above`}
                onPick={() => { setMinPriority(lv); setMenu(null); }}
              />
            ))}
            <div className="my-1 border-t border-[var(--mt5-border)]" />
            <MenuItem checked={currency === null} label="All currencies" onPick={() => { setCurrency(null); setMenu(null); }} />
            {CALENDAR_CURRENCIES.map((c) => (
              <MenuItem key={c} checked={currency === c} label={c} onPick={() => { setCurrency(c); setMenu(null); }} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * MetaTrader's importance marker: a blue fan, read off `fundamental_calendar_event.png` at 10x.
 *
 * "a dot alone" / "dot + one arc" / "dot + two arcs" (09-toolbox.md 844-851). Drawn rather than
 * lettered because that is what MetaTrader draws, and because three glyphs scan far faster down a
 * column than three words would.
 */
function PriorityFan({ level }: { level: CalendarPriority }) {
  const on = '#3183ff';
  const off = '#3b4756';
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label={`Priority ${level}`} data-priority={level}>
      {/* The dot is always lit: every release has at least the lowest importance. */}
      <circle cx="3.5" cy="12.5" r="1.6" fill={on} />
      <path d="M3.5 8.4a4.1 4.1 0 014.1 4.1" fill="none" stroke={level >= 2 ? on : off} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3.5 4.3a8.2 8.2 0 018.2 8.2" fill="none" stroke={level >= 3 ? on : off} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** MetaTrader's date column format, `YYYY.MM.DD`, read off `en/articles.png`. */
const mtDate = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
};

/**
 * MetaTrader's Articles tab, over the broker's own library.
 *
 * MetaTrader reads MQL5.community here, which is MetaQuotes' own service and not something a broker
 * has. What a broker DOES publish is market analysis and trader education, so that is the shelf:
 * ten pieces written about the instruments this platform quotes and the mechanics it actually
 * implements (see lib/terminal/articles.ts, which explains why the content lives beside the code).
 *
 * The grid is MetaTrader's, verbatim: `Name | Category | Date ▽`, name leftmost, date rightmost and
 * right-aligned with the sort triangle, rendered `YYYY.MM.DD`, and a page icon in the gutter
 * (09-toolbox.md 7.5). Its context menu carries `View  Enter`, `Refresh`, a `Categories ▸` submenu
 * and the `Category R` / `Auto Arrange A` / `Grid G` toggles; `View` is what a click does here, and
 * the category filter is the submenu's. Refresh is not drawn: this library is compiled into the
 * app, so there is nothing to re-fetch and a control that did nothing would be the placeholder this
 * tab exists to remove.
 */
function ArticlesTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  /** The `Categories ▸` filter. Every category starts checked, as MetaTrader's submenu shows them. */
  const [hidden, setHidden] = useState<ReadonlySet<ArticleCategory>>(() => new Set());
  const [menu, setMenu] = useState<null | { x: number; y: number }>(null);
  const read = useReadArticles();

  const all = useMemo(() => articlesNewestFirst(), []);
  const rows = all.filter((a) => !hidden.has(a.category));
  const open = openId === null ? null : (all.find((a) => a.id === openId) ?? null);

  const view = (a: Article): void => { setOpenId(a.id); markArticleRead(a.id); };

  if (open !== null) return <ArticleReader article={open} onBack={() => setOpenId(null)} />;

  const toggleCategory = (c: ArticleCategory): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div
      data-articles-tab=""
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {/* `Date` is the sorted column, so it carries the triangle MetaTrader draws on it. */}
      <Table head={['Name', 'Category', 'Date ▽']} left={[0, 1]} grow={0}>
        {rows.map((a) => {
          const unread = !read.has(a.id);
          return (
            <tr
              key={a.id}
              className="cursor-pointer border-t border-[var(--mt5-border)]/60 hover:bg-[var(--mt5-border)]/40"
              onClick={() => view(a)}
              onDoubleClick={() => view(a)}
            >
              <Td first className="max-w-0">
                <span className="flex items-center gap-1.5">
                  <PageIcon unread={unread} />
                  {/* MetaTrader truncates a column rather than wrapping it or dropping it. */}
                  <span className={cn('min-w-0 truncate', unread ? 'font-semibold text-white' : 'text-[#c8d2de]')}>
                    {a.name}
                  </span>
                </span>
              </Td>
              <Td className="text-left text-[var(--mt5-muted)]">{a.category}</Td>
              <Td className="text-[var(--mt5-muted)]">{mtDate(a.atMs)}</Td>
            </tr>
          );
        })}
      </Table>

      {rows.length === 0 ? (
        <Empty>Every category is unchecked. Right-click to pick the ones to list.</Empty>
      ) : null}

      <ToolboxFooter>
        <span>{rows.length} of {all.length} articles</span>
        <span>{all.length - read.size} unread</span>
        {/* No "published by": the publisher is this platform, and the Company tab is where the
            broker's own details belong. */}
        <span className="ml-auto">Click an article to read it.</span>
      </ToolboxFooter>

      {menu ? (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-[70] cursor-default" />
          <div
            role="menu"
            data-articles-menu=""
            className="fixed z-[71] max-h-[70vh] w-52 overflow-y-auto rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[12px] shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem checked={false} label="Select All" onPick={() => { setHidden(new Set()); setMenu(null); }} />
            <MenuItem checked={false} label="Unselect All" onPick={() => { setHidden(new Set(ARTICLE_CATEGORIES)); setMenu(null); }} />
            <div className="my-1 border-t border-[var(--mt5-border)]" />
            {ARTICLE_CATEGORIES.map((c) => (
              <MenuItem key={c} checked={!hidden.has(c)} label={c} onPick={() => { toggleCategory(c); setMenu(null); }} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The page glyph MetaTrader puts in the Articles gutter. Filled while the article is unread. */
function PageIcon({ unread }: { unread: boolean }) {
  return (
    <svg viewBox="0 0 12 14" className="h-3 w-2.5 shrink-0" role="img" aria-label={unread ? 'Unread' : 'Read'}>
      <path
        d="M1 1h6l4 4v8H1z"
        fill={unread ? '#3183ff' : 'none'}
        stroke={unread ? '#3183ff' : '#8fa2b8'}
        strokeWidth="1"
      />
    </svg>
  );
}

/**
 * The reading pane. MetaTrader's `View` (Enter) opens the article inside the platform rather than
 * in a browser, which is the whole point of the tab, so the body is drawn here in the panel.
 */
function ArticleReader({ article, onBack }: { article: Article; onBack: () => void }) {
  return (
    <div data-article-reader={article.id} className="px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 text-[11px] font-semibold text-[var(--mt5-blue-link)] hover:underline"
      >
        ← Articles
      </button>
      <h3 className="text-[13px] font-semibold leading-snug text-white">{article.name}</h3>
      <p className="mt-0.5 font-mono text-[10px] text-[var(--mt5-muted)]">
        {article.category} · {mtDate(article.atMs)}
      </p>
      {/* `max-w-[70ch]`: a 1440px panel would otherwise set prose to 170 characters a line, which is
          twice what anyone reads comfortably. */}
      <div className="mt-2 max-w-[70ch] space-y-2 text-[11.5px] leading-relaxed text-[#c8d2de]">
        {article.body.map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </div>
  );
}

/**
 * MetaTrader's Code Base tab, over this terminal's own program library.
 *
 * MetaTrader's Code Base is MQL5's free source library: *"you can access a huge code base of free
 * applications for automated trading… When you download the code, it is automatically compiled,
 * after which a ready-to-use application is created"*, and its one documented hot key is
 * ***"D — Download the selected application"*** (09-toolbox.md 7.6). None of that transfers: there
 * is no MQL5 account behind this platform, and a compiled MQL5 binary has no meaning in a browser.
 *
 * What DOES transfer is the thing the tab is for — a library of programs the terminal can run, with
 * a control that puts one to work. This terminal ships 38 of them: MetaTrader's own built-in
 * indicators, in its own four Navigator groups, under its own names (lib/chart/indicatorCatalog).
 * So this is that library, and the download is an APPLY: clicking a row switches the indicator onto
 * the chart, through the same store the chart's own Indicators menu writes to, and the row shows
 * `✓` while it is applied.
 *
 * The seven that read traded volume are listed and disabled with the reason, exactly as they are in
 * the chart's menu: a synthetic price curve reports no volume, and omitting them would hide the gap
 * while feeding them an invented volume would draw a confident line that means nothing.
 *
 * The columns are this platform's own and are declared as such in `PLATFORM_COLUMNS`; MetaQuotes
 * has never rendered this grid, so there is nothing of its to copy.
 */
function CodeBaseTab() {
  const applied = useEnabledIndicators();
  const [group, setGroup] = useState<IndicatorGroup | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number }>(null);

  const rows = useMemo(
    () => INDICATOR_GROUPS.flatMap((g) => (group === null || g.group === group ? g.items : [])),
    [group],
  );
  const appliedCount = INDICATOR_GROUPS.reduce(
    (n, g) => n + g.items.filter((i) => applied.has(i.id)).length, 0,
  );

  return (
    <div
      data-codebase-tab=""
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      <Table head={[...(PLATFORM_COLUMNS.codebase ?? [])]} left={[0, 2, 3]} grow={0}>
        {rows.map((def) => {
          const on = applied.has(def.id);
          const blocked = def.unavailable !== undefined;
          return (
            <tr
              key={def.id}
              title={def.unavailable}
              aria-disabled={blocked || undefined}
              data-applied={on || undefined}
              className={cn(
                'border-t border-[var(--mt5-border)]/60',
                blocked ? 'opacity-45' : 'cursor-pointer hover:bg-[var(--mt5-border)]/40',
              )}
              onClick={() => { if (!blocked) toggleIndicator(def.id); }}
            >
              <Td first className="max-w-0">
                <span className="flex items-center gap-1.5">
                  {/* The applied marker sits in the gutter, where MetaTrader's grids put a state
                      glyph, so the column of names stays a column of names. */}
                  <span className={cn('w-2.5 shrink-0 text-[10px]', on ? 'text-[var(--mt5-blue-link)]' : 'text-transparent')} aria-hidden>✓</span>
                  <span className={cn('min-w-0 truncate', on ? 'font-semibold text-white' : 'text-[#c8d2de]')}>{def.name}</span>
                </span>
              </Td>
              <Td className="text-[var(--mt5-muted)]">{def.params}</Td>
              <Td className="text-left text-[var(--mt5-muted)]">{GROUP_LABELS[def.group]}</Td>
              <Td className="text-left text-[var(--mt5-muted)]">
                {def.pane === 'price' ? 'Main chart' : 'Separate window'}
              </Td>
            </tr>
          );
        })}
      </Table>

      <ToolboxFooter>
        <span>{rows.length} of {MT5_INDICATOR_COUNT} programs</span>
        <span>{appliedCount} applied to the chart</span>
        {group === null ? null : <span>Group: {GROUP_LABELS[group]}</span>}
        <span className="ml-auto">Click a row to apply it to the chart, or again to remove it.</span>
      </ToolboxFooter>
      <p className="border-t border-[var(--mt5-border)] px-3 py-1.5 text-[10px] leading-snug text-[var(--mt5-muted)]">
        {VOLUME_GROUP_NOTE}
      </p>

      {menu ? (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-[70] cursor-default" />
          <div
            role="menu"
            data-codebase-menu=""
            className="fixed z-[71] w-52 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[12px] shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem checked={group === null} label="All groups" onPick={() => { setGroup(null); setMenu(null); }} />
            {INDICATOR_GROUPS.map((g) => (
              <MenuItem key={g.group} checked={group === g.group} label={g.label} onPick={() => { setGroup(g.group); setMenu(null); }} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * MetaTrader's two logs, which it draws identically.
 *
 * `Time | Source | Message` are the only Toolbox columns the help states outright, and it states
 * them for the Journal: *"Time — the date and time of the event… Source — event type: Network,
 * Alert, HistoryBase, Experts, the name of a separate Expert Advisor or indicator…; Message —
 * description of the event."* (09-toolbox.md 7.8.) The Experts tab is documented as the same kind
 * of log and never rendered, so it borrows them rather than inventing a shape.
 *
 * Newest first. All three columns read left: these are a clock, a name and a sentence, and none of
 * them is a figure to line up a decimal point in.
 */
function LogTab({ entries, empty }: { entries: readonly JournalEntry[]; empty: React.ReactNode }) {
  if (entries.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table head={[...(TOOLBOX_COLUMNS.journal ?? [])]} left={[0, 1, 2]} grow={2}>
      {entries.slice().reverse().map((e) => (
        <tr key={e.id} className="border-t border-[var(--mt5-border)]/40">
          <Td first className="text-[var(--mt5-muted)]">{stamp(e.atMs)}</Td>
          <Td className="text-left text-[var(--mt5-muted)]/70">{e.tag}</Td>
          <Td className={cn(
            'whitespace-normal text-left',
            e.level === 'error' ? 'text-[var(--mt5-red)]'
              : e.level === 'warn' ? 'text-[#f0b90b]'
              : e.level === 'ok' ? 'text-[var(--mt5-green)]' : 'text-[var(--mt5-muted)]',
          )}>
            {e.text}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * MetaTrader's Experts tab: what the programs attached to the chart did.
 *
 * *"Experts Journal… contains information about the running indicators and Expert Advisor,
 * including opening/closing of positions, modification of orders, Expert Advisor alerts and
 * comments"* (09-toolbox.md 7.7). This platform runs no Expert Advisors, and it is not going to
 * pretend otherwise — but it does run INDICATORS, which is the other half of that sentence, and
 * they genuinely initialise when the chart opens with them attached, get applied and get removed.
 * Each writes a line (see `logExperts`), so the tab carries real events from this session.
 *
 * It is empty until an indicator is switched on, which is also when MetaTrader's is empty: a log
 * with nothing in it is not a placeholder, and the empty state says what fills it rather than
 * apologising for a feed that does not exist.
 */
function ExpertsTab() {
  const experts = useExperts();
  return (
    <LogTab
      entries={experts}
      empty={
        <>
          No programs have logged anything this session.
          <br />
          This log records what the programs on the chart do. Apply an indicator, from the Code Base
          tab or the chart&apos;s own Indicators menu, and it reports here.
        </>
      }
    />
  );
}

/**
 * MetaTrader's Company tab: the broker's own page.
 *
 * *"A broker may choose to show a useful web resource here, for example a support website. Any link
 * added here opens in a separate web browser window. This tab is hidden if the web page is disabled
 * by the broker."* (09-toolbox.md 7.9.) Not a grid, and no screenshot of it exists, so what is
 * drawn is the substance: this brand's identity, its licence, the currency it settles in, its
 * support channels and the pages it publishes. Every one of those comes off the `sites` row the
 * whole app is skinned from, so a second brand on this deployment shows its own.
 *
 * Every link opens in a separate window, as MetaTrader says they do.
 */
function CompanyTab({ page }: { page: ReturnType<typeof companyPage> }) {
  return (
    <div data-company-tab="" className="space-y-3 px-3 py-3 text-[11.5px] leading-relaxed">
      <div>
        <h3 className="text-[14px] font-semibold text-white">{page.title}</h3>
        {page.licence === null ? null : (
          <p className="mt-0.5 max-w-[70ch] text-[var(--mt5-muted)]">{page.licence}</p>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
        {page.fields.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-[var(--mt5-muted)]">{f.label}</dt>
            <dd className="text-white">{f.value}</dd>
          </div>
        ))}
      </dl>

      {page.support.length > 0 ? (
        <section>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">Support</h4>
          <ul className="space-y-1">
            {page.support.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-[var(--mt5-blue-link)] hover:underline"
                >
                  {l.label}
                </a>
                <span className="ml-2 text-[var(--mt5-muted)]">{l.note}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">Published pages</h4>
        <ul className="space-y-1">
          {page.resources.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noreferrer" className="text-[var(--mt5-blue-link)] hover:underline">
                {l.label}
              </a>
              <span className="ml-2 text-[var(--mt5-muted)]">{l.note}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

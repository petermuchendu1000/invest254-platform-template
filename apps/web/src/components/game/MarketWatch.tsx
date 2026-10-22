'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Candle } from '@invest254/shared/candles';
import { LOT_STAKE_CENTS } from '@invest254/shared/account';
import { effectiveVolume, volumeSpecOf, volumeDigitsOf } from '@invest254/shared/symbols';
import {
  useGameSocket, useGameSocketApi, type SymbolRow,
} from '@/lib/game/GameSocketProvider';
import { useDisplayMoney } from '@/lib/money';
import { MT5Price } from '@/components/game/MT5Price';
import { logJournal } from '@/lib/game/journal';
import {
  quoteTone, QUOTE_TONE_COLOUR, gutterGlyph, GUTTER_GLYPH, GUTTER_COLOUR,
  positionMark, POSITION_MARK_COLOUR, type PositionMark,
} from '@/lib/game/quoteTone';
import { useStakeLimits } from '@/lib/game/useStakeLimits';
import {
  MT5Specification, MT5MarketWatchMenu, marketWatchMenu,
} from '@/components/game/MT5Specification';
import { MT5SymbolsDialog } from '@/components/game/MT5SymbolsDialog';
import { useSymbolSetStore, MAX_WATCHED } from '@/lib/game/symbolSet';
import { useChartSymbolStore, chartOverride, CHART_SYMBOL_DND } from '@/lib/game/chartSymbol';
import { detailRows, sessionSoFar } from '@/lib/game/symbolDetails';
import { MT5MobileQuoteMenu } from '@/components/game/mobile/MT5MobileQuoteMenu';
import {
  MT5SwipeRow, SwipePlusIcon, SwipeChartIcon, type SwipeCommand,
} from '@/components/game/mobile/MT5SwipeRow';
import { useQuotesViewStore, useRestoreQuotesView } from '@/lib/game/quotesView';
import {
  QUOTE_COLUMNS, spreadPoints, useQuoteColumnsStore, useRestoreQuoteColumns,
} from '@/lib/game/quoteColumns';
import { DURATION_OPTIONS, durationLabel } from '@/components/game/MT5OrderTicket';
import { MT5OneClickTrading } from '@/components/game/MT5OneClickTrading';
import { MT5TicksChart } from '@/components/game/MT5TicksChart';
import { LiveBadge } from '@/components/ui/LiveBadge';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Market Watch — the symbol list and its detail, docked left on a desktop terminal.
 *
 * The list is the trader's own set, as MetaTrader's is: the brand offers a catalogue of ninety-odd
 * instruments and the window shows the dozen the trader picked, curated through the Symbols dialog
 * (Ctrl+U) and the context menu's Hide / Hide All / Show All. The set is stored per device; see
 * lib/game/symbolSet.
 *
 * MetaTrader quotes BID and ASK here, and so does this window. It did not use to: this panel
 * printed one `Last` price under a comment saying a bid and an ask around a non-existent spread
 * would claim a trader buys at one and sells at the other when they do not. The engine now
 * publishes the spread it has always charged (`gameConfig.spread`), so the two sides are the
 * honest rendering and the single price is the one that would mislead. Both are derived from the
 * same quote by the same arithmetic the order ticket uses, so no surface can disagree with
 * another. The detail tab carries the session's real open/high/low/close from the same candle feed
 * the chart draws.
 *
 * Hidden below `lg`, where there is no room for it — the phone layout puts the quote in the price
 * strip above the chart instead, which is what MetaTrader's own mobile app does.
 */

/**
 * MetaTrader's four Market Watch tabs, along the bottom edge in this order. Its own Hot Keys page
 * names all four verbatim when describing Space/Tab, which is the second source for the set.
 */
type Tab = 'symbols' | 'details' | 'trading' | 'ticks';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'symbols', label: 'Symbols' },
  { id: 'details', label: 'Details' },
  { id: 'trading', label: 'Trading' },
  { id: 'ticks', label: 'Ticks' },
];

export function MarketWatch({ className, phone = false, onChart, onNewOrder }: {
  className?: string;
  phone?: boolean;
  /** Phone only: leave the Quotes tab for the chart, which is where `Chart` goes. */
  onChart?: (() => void) | undefined;
  /** Phone only: open the New Order screen, which is where `New order` goes. */
  onNewOrder?: (() => void) | undefined;
}) {
  const { getMarket, requestCandles, requestSymbols, getSymbolQuote, getSymbolTicks, getSettledSymbol } = useGameSocketApi();
  const { status, spread, positions } = useGameSocket();
  const money = useDisplayMoney();
  const [tab, setTab] = useState<Tab>('symbols');
  /** MetaTrader reaches the Specification dialog from the Market Watch context menu. */
  const [menu, setMenu] = useState<{ x: number; y: number; symbol: string | null } | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  /** MetaTrader's `Grid` toggle, which draws or hides the row separators. */
  const [grid, setGrid] = useState(true);
  const limits = useStakeLimits();

  const watched = useSymbolSetStore((s) => s.watched);
  const hide = useSymbolSetStore((s) => s.hide);
  const hideAll = useSymbolSetStore((s) => s.hideAll);
  const showAll = useSymbolSetStore((s) => s.showAll);
  const sortList = useSymbolSetStore((s) => s.sort);
  const replace = useSymbolSetStore((s) => s.replace);
  const charted = useChartSymbolStore((s) => s.symbol);
  const setCharted = useChartSymbolStore((s) => s.set);

  /** The brand's whole catalogue, which the Symbols dialog shows as MetaTrader's group tree. */
  const [catalogue, setCatalogue] = useState<readonly SymbolRow[]>([]);
  const [defaultSymbol, setDefaultSymbol] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'open') return;
    let cancelled = false;
    requestSymbols()
      .then((r) => { if (!cancelled) { setCatalogue(r.symbols); setDefaultSymbol(r.defaultSymbol); } })
      // Worth saying rather than swallowing: without the catalogue the list falls back to the
      // stored names alone, and the Journal is where this app explains itself.
      .catch((e: Error) => { if (!cancelled) logJournal('warn', 'Quotes', `symbol list unavailable (${e.message})`); });
    return () => { cancelled = true; };
  }, [requestSymbols, status]);

  const bySymbol = useMemo(() => new Map(catalogue.map((r) => [r.symbol, r])), [catalogue]);

  /**
   * The rows actually shown: the trader's set, filtered against what the brand currently offers.
   *
   * Filtered rather than trusted, because the set outlives the catalogue. A stored symbol the brand
   * has stopped offering would otherwise sit in the window for ever, never quoting and never
   * explaining itself.
   */
  const visible = useMemo(
    () => (catalogue.length === 0 ? [...watched] : watched.filter((s) => bySymbol.has(s))),
    [watched, bySymbol, catalogue.length],
  );

  /**
   * The phone's open-position marker: which row wears MetaTrader's corner triangle, and its colour.
   *
   * ONE row can wear it, and that is the model rather than a shortcut. A position on this platform
   * is opened against the brand's price axis — the engine's `Position` (apps/engine/src/game.ts 26)
   * records no symbol at all, and the socket refuses an order placed while the chart is on any other
   * instrument (`priceAxisSymbol`, game.ts 287; `tradeDisabled` in lib/game/useOrderEntry). So every
   * open position is on the settled symbol, necessarily, and marking any other row would be stating
   * something the engine cannot mean.
   *
   * `defaultSymbol` rather than `getSettledSymbol()`: both are the same value from the same reply,
   * but this one is React state, so the marker appears when the catalogue lands instead of waiting
   * for an unrelated re-render. Null until then, which draws no triangle — the honest rendering of
   * "not known yet", since the alternative is marking a row that may not be the right one.
   *
   * A settling position still counts as exposure, which is the rule MT5MobileTrade's own floating
   * total uses (line 66), so the marker and the Trade screen can never disagree about whether the
   * trader has something open.
   */
  const marked = useMemo(() => {
    const live = positions.filter((p) => p.phase !== 'settling');
    if (live.length === 0 || defaultSymbol === null) return null;
    const floatingCents = live.reduce((sum, p) => sum + p.livePnlCents, 0);
    return { symbol: defaultSymbol, mark: positionMark(floatingCents) };
  }, [positions, defaultSymbol]);

  // Which symbols the engine quotes is decided in one place for the whole screen (see
  // lib/game/chartSymbol's useQuoteSubscription), because the subscription is a set per socket and
  // two components sending their own would take turns clobbering each other.

  /** The row the Details tab and the Specification dialog describe. */
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The phone's own two pieces of Quotes state: which row's context menu is open, and MetaTrader's
   * Advanced/Simple view mode. Neither exists on a desktop, where the menu is positioned at the
   * pointer and every row is the full grid.
   */
  const [sheet, setSheet] = useState<string | null>(null);
  const view = useQuotesViewStore((st) => st.view);
  const toggleView = useQuotesViewStore((st) => st.toggle);
  useRestoreQuotesView();
  /** Which of MetaTrader's optional columns this device draws. See lib/game/quoteColumns. */
  useRestoreQuoteColumns();
  const columns = useQuoteColumnsStore((st) => st.on);
  const toggleColumn = useQuoteColumnsStore((st) => st.toggle);
  const active = selected !== null && visible.includes(selected)
    ? selected
    : visible.includes(defaultSymbol ?? '') ? defaultSymbol! : visible[0] ?? defaultSymbol ?? 'XAUUSD';

  /**
   * Ctrl+M, verbatim from MetaQuotes' hot-keys page: "Open/close the 'Market Watch' window." This
   * panel is docked rather than floating, so the shortcut moves focus to it by selecting its first
   * tab instead of toggling a window that cannot be closed. Ctrl+U opens the Symbols dialog, which
   * is the same page's shortcut for it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); setTab('symbols'); }
      if (e.key === 'u' || e.key === 'U') { e.preventDefault(); setSymbolsOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** The selected symbol's closed hourly bars, from which today's session is computed. */
  const [hours, setHours] = useState<{ symbol: string; bars: Candle[] } | null>(null);
  const [, force] = useState(0);

  // Quote updates come off the tick stream, which does not re-render React on its own.
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 300);
    return () => clearInterval(id);
  }, []);

  /**
   * The selected symbol's closed HOURLY bars, from which today's session open, high and low are
   * computed (see `sessionSoFar`).
   *
   * It used to ask for the latest closed DAILY bar, which before midnight is yesterday's: the panel
   * showed one day's session open beside a Daily Change measured against another day's close. Every
   * number was true and the set of them was not. The engine never serves an unfinished bar, so
   * today's daily bar does not exist to ask for; hours plus the live price are the honest source.
   *
   * For the SELECTED symbol only. Fetching them for every row would ask the engine to build twenty
   * day chains to print three numbers each, and only one symbol's detail is on screen at a time.
   *
   * Refetched whenever the connection comes back, not only on a timer: a request made while the
   * socket is down is rejected, and waiting out the interval left the panel showing dashes for a
   * minute after every reconnect. (Found by reading this app's own Journal tab, which logged
   * "session figures unavailable (NOT_CONNECTED)" right after a reconnect.)
   */
  useEffect(() => {
    if (status !== 'open') return;
    let cancelled = false;
    const load = () => {
      // 26 covers a full UTC day plus the slack for whichever hour is forming.
      requestCandles('H1', 26, undefined, active)
        .then((r) => { if (!cancelled) setHours({ symbol: active, bars: r.bars }); })
        .catch((e: Error) => { if (!cancelled) logJournal('warn', 'Quotes', `session figures unavailable (${e.message})`); });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [requestCandles, status, active]);

  const market = getMarket();
  const quoteOf = useCallback((symbol: string) => {
    const q = getSymbolQuote(symbol);
    if (q) return q;
    // Before a per-symbol quote has landed, the brand's own market axis still prices the DEFAULT
    // symbol, so that one row is never blank while the others fill in.
    if (market && market.instrument.symbol === symbol) {
      // No day range either: that comes with the symbol's own quote, and MetaTrader shows no
      // `L:`/`H:` on a row it has not quoted yet rather than two dashes.
      return {
        instrument: market.instrument, price: null, up: null, changedAt: null, t: null,
        anchor: market.anchor, dayHigh: null, dayLow: null,
      };
    }
    return null;
  }, [getSymbolQuote, market]);

  const digitsOf = (symbol: string) => bySymbol.get(symbol)?.digits ?? market?.instrument.digits ?? 2;
  const activeDigits = digitsOf(active);
  /**
   * The ACTIVE symbol's own volume spec, narrowed by the brand's money limits.
   *
   * MetaTrader's Specification dialog is per symbol, so selecting an index has to change these
   * three rows. They were the brand's single range with a hard-coded 0.01 step, which made every
   * instrument in the book claim the same volumes.
   */
  const activeVolume = effectiveVolume(
    volumeSpecOf(active),
    limits.minCents / LOT_STAKE_CENTS,
    limits.maxCents === undefined ? null : limits.maxCents / LOT_STAKE_CENTS,
  );
  const activeHours = hours !== null && hours.symbol === active ? hours.bars : null;
  /**
   * The Details tab's rows, in MetaTrader's own order and under its own labels. The whole list,
   * including which rows are absent and why, is argued in lib/game/symbolDetails.
   */
  const activeQuote = quoteOf(active);
  /**
   * The selected symbol's two sides, by the brand's published spread. The same arithmetic the rows
   * above, the One Click panels and the order ticket use, so the Details tab and the Specification
   * dialog cannot quote a Bid the grid disagrees with.
   */
  const activeSides = activeQuote && activeQuote.price !== null && spread
    ? {
        bid: activeQuote.price - spread.sell * activeQuote.instrument.scale,
        ask: activeQuote.price + spread.buy * activeQuote.instrument.scale,
      }
    : null;

  const details = detailRows({
    digits: activeDigits,
    // MetaTrader's `Face Value`: the contract's nominal value, which here is the fixed sum one lot
    // stakes. Bare, like every other figure in the list (docs/mt5/09-toolbox.md 429).
    faceValue: money.mt(LOT_STAKE_CENTS),
    last: activeQuote?.price ?? null,
    sides: activeSides,
    session: activeHours && activeQuote
      ? sessionSoFar(activeHours, activeQuote.anchor.tradeDate, activeQuote.price)
      : null,
    // The day's base IS the previous session's close: the axis is re-anchored every UTC midnight by
    // carrying that close forward, so MetaTrader's Daily Change definition lands on it exactly.
    previousClose: activeQuote?.anchor.base ?? null,
  });
  const activeToneInput = { up: activeQuote?.up ?? null, changedAt: activeQuote?.changedAt ?? null, now: Date.now() };
  const activeTone = quoteTone(activeToneInput);
  const glyphOfActive = gutterGlyph(activeToneInput);
  const describe = (symbol: string) => bySymbol.get(symbol)?.description ?? '';

  /**
   * MetaTrader's `Chart Window`: open the clicked symbol's chart.
   *
   * Switching back to the brand's own symbol stores null rather than its name, so a brand changing
   * its instrument does not strand the device on the old one.
   */
  const chartSymbol = chartOverride(charted, getSettledSymbol() ?? defaultSymbol) ?? getSettledSymbol() ?? defaultSymbol;
  const openChart = useCallback((symbol: string) => {
    // The engine's own `defaultSymbol` first, then this window's copy of it. Before either has
    // arrived `settled` is null and this would store the brand's OWN symbol as if it were another
    // instrument; `chartOverride` normalises that away on every read, so a mis-timed click can no
    // longer refuse to trade the symbol it just charted.
    const settled = getSettledSymbol() ?? defaultSymbol;
    setCharted(symbol === settled ? null : symbol);
  }, [setCharted, defaultSymbol, getSettledSymbol]);

  const menuItems = marketWatchMenu({
    onSpecification: () => setSpecOpen(true),
    ...(menu?.symbol && menu.symbol !== chartSymbol ? { onChartWindow: () => openChart(menu.symbol!) } : {}),
    ...(catalogue.length > 0 ? { onSymbols: () => setSymbolsOpen(true) } : {}),
    ...(menu?.symbol ? { onHide: () => hide(menu.symbol!) } : {}),
    ...(visible.length > 0 ? { onHideAll: hideAll, onSort: sortList } : {}),
    // `Show All` fills the window up to the cap. MetaTrader shows everything; this feed quotes a
    // bounded number at once, so it shows as many as it can and the dialog says how many that is.
    ...(catalogue.length > 0 && visible.length < Math.min(MAX_WATCHED, catalogue.length)
      ? { onShowAll: () => showAll(catalogue.slice(0, MAX_WATCHED).map((r) => r.symbol)) }
      : {}),
    grid: { on: grid, toggle: () => setGrid((g) => !g) },
    ...(tab === 'ticks' ? {} : { onTickChart: () => setTab('ticks') }),
    columns: {
      items: QUOTE_COLUMNS.map((c) => ({
        label: c.label,
        on: columns.includes(c.id),
        toggle: () => toggleColumn(c.id),
      })),
    },
  });

  return (
    <aside className={cn(
      'flex flex-col overflow-hidden bg-[var(--mt5-surface)] text-[#ffffff]',
      // On a phone this IS the Quotes tab, filling the screen, so it has no card edge to draw.
      // MetaTrader's desktop panes are FLUSH: a 1px rule and a square corner, not a floating card.
      // This drew a 14px radius, which is the app shell's own card edge on a MetaTrader-coloured box.
      phone ? '' : 'rounded-sm border border-[var(--mt5-border)]',
      className,
    )}>
      {/* On a phone, a tab other than Symbols is a SCREEN pushed over the list, so its bar is a back
          chevron and the screen's name — there is no tab strip down there to get back with. */}
      {phone && tab !== 'symbols' ? (
        <div className="flex items-center gap-1 border-b border-[var(--mt5-border)] px-1 py-2">
          <button
            type="button"
            onClick={() => setTab('symbols')}
            aria-label="Back to quotes"
            className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <span className="text-[14px] font-semibold text-white">
            {tab === 'details' ? 'Market statistics' : TABS.find((t) => t.id === tab)?.label}
          </span>
        </div>
      ) : (
      <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2">
        {/* The window is "Market Watch" on a desktop and the tab is "Quotes" on a phone, and those
            are MetaTrader's own two names for it. The phone bar is `☰ | Quotes | ＋ | ✎`; the
            hamburger lives on the chart screen's bar in this shell and the pencil's job (hide,
            reorder) is the row context menu, so the `＋` is what is carried over. */}
        <span className={cn('font-semibold text-[var(--mt5-muted)]', phone ? 'text-[14px] text-white' : 'text-[11px] uppercase tracking-wide')}>
          {phone ? 'Quotes' : 'Market Watch'}
        </span>
        <span className="ml-auto" />
        {/* On a DESKTOP there is no add button up here: MetaTrader puts its `+` at the BOTTOM of the
            list, on the add row with the shown/available counter, and nowhere else. */}
        {phone ? (
          <button
            type="button"
            onClick={() => setSymbolsOpen(true)}
            aria-label="Add symbol"
            className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-5 w-5" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        ) : null}
        <LiveBadge status={status} showLabel={false} variant="terminal" />
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === 'symbols' ? (
          visible.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] leading-snug text-[var(--mt5-muted)]">
              No symbols shown.
              <button type="button" onClick={() => setSymbolsOpen(true)} className="ml-1 text-[var(--mt5-blue)] underline">
                Add some
              </button>
              .
            </div>
          ) : (
            /* MetaTrader's Quotes rows: the symbol on the left, its quote on the right in its own
               typography, coloured by the direction of that symbol's last price change.

               MetaTrader shows BID and ASK here. There is no spread on these instruments — a
               contract settles on one seeded price — so one quote is printed rather than two numbers
               implying the player buys at one and sells at the other. For the same reason the Spread
               column MetaTrader puts under the symbol is absent instead of showing a made-up figure. */
            <div data-quote-list="">
              {visible.map((symbol) => {
                const q = quoteOf(symbol);
                const digits = digitsOf(symbol);
                const toneInput = { up: q?.up ?? null, changedAt: q?.changedAt ?? null, now: Date.now() };
                const tone = quoteTone(toneInput);
                const colour = tone === null ? '#ffffff' : QUOTE_TONE_COLOUR[tone];
                const glyph = gutterGlyph(toneInput);
                const open = q?.anchor.base ?? null;
                const price = q?.price ?? null;
                /**
                 * The daily change, in points and in per cent, derived from ONE figure.
                 *
                 * They used to be computed independently and could disagree about the sign: a row
                 * whose price was a hair under its open printed "+0" beside "-0.00%", because the
                 * points figure rounded to zero and took the positive branch while the percent kept
                 * its sign through `toFixed`. Rounding first and reading the sign off the rounded
                 * points fixes both halves at once.
                 */
                const points = price !== null && open !== null
                  ? Math.round((price - open) * 10 ** digits)
                  : null;
                /**
                 * MetaTrader's two sides, around the quote, by the spread the engine charges.
                 *
                 * Identical arithmetic to the order ticket's (`useOrderEntry.bidAsk`) and the One
                 * Click panel's: a price is `base + scale * value` and the cost is in curve-value
                 * units, so the offset in price terms is `cost * scale`. Null where the brand
                 * publishes no spread, which is what a line brand does; then the grid is the single
                 * price it always was.
                 */
                const scale = q?.instrument.scale ?? null;
                const sides = price !== null && spread !== null && scale !== null
                  ? { bid: price - spread.sell * scale, ask: price + spread.buy * scale }
                  : price === null ? null : { bid: price, ask: price };
                /** The spread MetaTrader's own column prints: the gap in the symbol's points. */
                const points_ = spreadPoints(sides?.bid ?? null, sides?.ask ?? null, digits);
                const changePct = price !== null && open
                  ? (points === 0 ? 0 : ((price - open) / open) * 100)
                  : null;
                /**
                 * iOS documents swipe-left on a Quotes row: "Swipe left on the symbol line to open
                 * the quick commands menu" → TWO icons, new trade operation and open chart, and
                 * "dragging further left jumps straight to the chart"
                 * (docs/mt5/04-mobile-app.md section 2).
                 *
                 * Two, not the Trade row's six, because that is what MetaTrader puts here; and
                 * taken from the iOS help because Android's Quotes page documents only the tap
                 * menu and no swipe. The tap menu is still the full six items, so the swipe is an
                 * accelerator for the two commands a trader actually repeats, which is what it is
                 * on MetaTrader too.
                 *
                 * `New order` carries the same rule as the menu item: MetaTrader HIDES it while
                 * disconnected rather than disabling it, and this brand settles one symbol, so a
                 * row for another says so instead of opening a ticket it cannot fill.
                 */
                const swipe: readonly SwipeCommand[] = [
                  ...(status === 'open'
                    ? [{
                        label: 'New order',
                        icon: SwipePlusIcon,
                        ...(symbol === defaultSymbol
                          ? { onPick: () => { openChart(symbol); onNewOrder?.(); } }
                          : { unavailable: `This brand settles ${defaultSymbol ?? 'one symbol'} only, so an order cannot be placed on ${symbol}.` }),
                      } satisfies SwipeCommand]
                    : []),
                  { label: 'Chart', icon: SwipeChartIcon, onPick: () => { openChart(symbol); onChart?.(); } },
                ];
                const row = (
                  <button
                    key={symbol}
                    type="button"
                    data-quote-row={symbol}
                    aria-pressed={symbol === active}
                    /**
                     * A click SELECTS, and that is all it does.
                     *
                     * It used to switch to the Details tab as well, which took the list off screen
                     * the moment a row was touched: MetaTrader's Symbols tab stays on the list and
                     * Details is a tab the trader chooses. It also made the double-click below
                     * impossible, because the first of its two clicks unmounted the row.
                     */
                    onClick={() => {
                      setSelected(symbol);
                      // "To open the context menu, tap on the ... line in the list" — Android's own
                      // gesture, and the only one a phone has: there is no right-click to reach the
                      // desktop menu with, and no second pane for a selection to drive.
                      if (phone) setSheet(symbol);
                    }}
                    /**
                     * Drag a symbol onto the chart to chart it. MetaQuotes, verbatim: "A symbol
                     * chart can be opened by dragging it to the chart viewing area using a mouse
                     * (Drag'n'Drop)."
                     */
                    /**
                     * Desktop only, and that is not a tidy-up: a native HTML5 drag on a phone row
                     * CANCELS the pointer gesture that starts it, so the row's swipe-left quick
                     * commands could never open. MetaTrader's phone has no drag-to-chart either --
                     * the comment below says as much -- so the attribute was only ever doing harm
                     * there.
                     */
                    draggable={!phone}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(CHART_SYMBOL_DND, symbol);
                      e.dataTransfer.setData('text/plain', symbol);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    /**
                     * Double-click charts it too, and that is a DEVIATION worth naming.
                     *
                     * MetaTrader's double-click "opens a new position opening window". This
                     * terminal's order ticket is permanently docked, so there is no window for it
                     * to open, and dropping the gesture entirely would leave a phone — which has
                     * neither a right-click nor a drag — with no way to change the chart at all.
                     * So it does what the drag does.
                     */
                    onDoubleClick={() => openChart(symbol)}
                    onContextMenu={(e) => { e.preventDefault(); setSelected(symbol); setMenu({ x: e.clientX, y: e.clientY, symbol }); }}
                    className={cn(
                      'w-full text-left transition hover:bg-[var(--mt5-raised)]',
                      // `relative` is the phone's open-position triangle: it hangs in the row's own
                      // top-left corner, outside the flex flow, so it cannot shift the text.
                      phone
                        ? (view === 'simple' ? 'relative flex items-center gap-2 px-3 py-3' : 'relative flex items-start gap-2 px-3 py-2')
                        // Tighter than the phone row's: six columns share a docked panel that is
                        // 286px wide at 1440, and the two price columns are the ones that must not
                        // be squeezed. MetaTrader drops columns off the right edge at this width;
                        // the breakpoints below do the same, deliberately rather than by clipping.
                        : 'flex items-center gap-1.5 px-2 py-1.5',
                      grid ? 'border-b border-[var(--mt5-border)]/60' : '',
                      symbol === active ? 'bg-[var(--mt5-raised)]' : '',
                    )}
                  >
                    {phone && view === 'simple' ? (
                      /* MetaTrader Android's reduced row, verbatim: "In the simple view mode only
                         the Bid and Ask prices are shown." Which is now literally what it shows. */
                      <>
                        <PositionCorner mark={marked?.symbol === symbol ? marked.mark : null} />
                        <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-white">{symbol}</span>
                        <span className="flex shrink-0 items-baseline gap-2 text-right">
                          {sides === null ? (
                            <span className="font-mono text-[11px] text-[#4a5666]">waiting</span>
                          ) : (
                            <>
                              <MT5Price value={sides.bid} digits={digits} className="text-[13px]" style={{ color: colour }} />
                              <MT5Price value={sides.ask} digits={digits} className="text-[13px]" style={{ color: colour }} />
                            </>
                          )}
                        </span>
                      </>
                    ) : phone ? (
                      /**
                       * MetaTrader's PHONE quote row, which is a different row from the desktop
                       * grid rather than the same one narrowed (docs/mt5/04-mobile-app.md section 2,
                       * read off `android/en/quotes.png`). Two columns, three lines on the left:
                       *
                       *     ◢(corner triangle)
                       *     +151  0.14%                      1.08 07⁶
                       *     EURUSD
                       *     15:09:42  ⌶ 0
                       *
                       * There is NO tick-direction glyph in a gutter here, and that is a difference
                       * from the desktop grid rather than an omission: the phone row's top-left
                       * corner carries the open-position triangle instead (see `PositionCorner`),
                       * and the symbol starts at the row's own padding edge. The green-and-red arrow
                       * this row used to print was the DESKTOP Market Watch's, sampled from the
                       * desktop screenshot, reused on a screen MetaTrader never puts it on.
                       *
                       * Line 1 is the daily change: the POINTS figure grey and never colour-coded,
                       * the percent blue when positive and red when negative. That split is
                       * measured, not guessed, and it is the detail this row is most easily got
                       * wrong on. Line 2 is the symbol, bold and the largest text in the row. Line 3
                       * is the last quote's time, then the I-beam spread glyph and the spread.
                       *
                       * ON THE RIGHT MetaTrader prints Bid and Ask side by side with `L:` and `H:`
                       * beneath them, and so does this. Both sides come from one quote and the
                       * brand's published spread, by the same arithmetic the order ticket uses, and
                       * the spread on line 3 is that gap in the symbol's own points rather than the
                       * `0` this row used to print.
                       *
                       * `L:`/`H:` ride the quote, because the engine is the only side that can know
                       * them: it holds the day, and a phone deriving them would have to fetch a day
                       * of bars per watched symbol to print two numbers each.
                       */
                      <>
                        <PositionCorner mark={marked?.symbol === symbol ? marked.mark : null} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-1.5 font-mono text-[10px] tabular-nums">
                            <span className="text-[#969696]">
                              {points === null ? '' : `${points > 0 ? '+' : ''}${points}`}
                            </span>
                            <span style={{ color: changePct === null || points === 0 ? '#969696' : changePct > 0 ? '#3183ff' : '#f23645' }}>
                              {changePct === null ? '' : `${changePct.toFixed(2)}%`}
                            </span>
                          </span>
                          <span className="block truncate text-[15px] font-bold leading-tight text-white">{symbol}</span>
                          <span className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-[var(--mt5-muted)]">
                            <span>{q?.t ? clockOf(q.t) : ''}</span>
                            {/* The I-beam MetaTrader draws beside the spread: two short verticals
                                joined by a rule. Drawn, not typed — U+2336 is absent from most
                                Android system fonts and renders as a box. */}
                            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="h-2.5 w-2.5" aria-hidden>
                              <path d="M3 2h6M3 10h6M6 2v8" />
                            </svg>
                            <span>{points_ === null ? '' : points_}</span>
                          </span>
                        </span>
                        <span className="shrink-0 pt-0.5 text-right">
                          {sides === null ? (
                            <span className="font-mono text-[11px] text-[#4a5666]">waiting</span>
                          ) : (
                            <span className="flex items-baseline justify-end gap-2">
                              <MT5Price value={sides.bid} digits={digits} className="text-[13px]" style={{ color: colour }} />
                              <MT5Price value={sides.ask} digits={digits} className="text-[13px]" style={{ color: colour }} />
                            </span>
                          )}
                          {/* MetaTrader's second right-hand line: `L: <day low>` under the Bid and
                              `H: <day high>` under the Ask. There is one price here rather than two,
                              so the pair sits under it together.

                              They are the session's extremes SO FAR, which the engine computes and
                              sends on the quote: this curve is deterministic for the whole day the
                              moment its seed is known, so a client folding the day's bars would
                              print a high the price has not reached yet. Absent, not dashed, until
                              the first quote carrying them lands. */}
                          {q?.dayLow !== null && q?.dayLow !== undefined && q.dayHigh !== null ? (
                            <span className="flex justify-end gap-2 pt-0.5 font-mono text-[10px] leading-none text-[var(--mt5-muted)] tabular-nums">
                              {/* A flex gap rather than two spaces in the text: HTML collapses
                                  runs of whitespace, so the pair would have read as one. */}
                              <span>L: {q.dayLow.toFixed(digits)}</span>
                              <span>H: {q.dayHigh.toFixed(digits)}</span>
                            </span>
                          ) : null}
                        </span>
                      </>
                    ) : (
                    <>
                    {/* MetaTrader's gutter glyph: a thin green arrow, a thin red arrow, or a grey
                        dot where the price has not moved. It sits INSIDE the Symbol column rather
                        than in a column of its own, which is why there is no header above it.

                        It replaced a blue bar marking the charted symbol. That bar was an invention:
                        MetaTrader's Market Watch does not mark which symbol the chart is on, because
                        the chart's own title says so. */}
                    <span aria-hidden className="w-3 shrink-0 text-center text-[10px] leading-none" style={{ color: GUTTER_COLOUR[glyph] }}>
                      {GUTTER_GLYPH[glyph]}
                    </span>
                    <span className="w-[50px] shrink-0 truncate text-[11px] font-bold text-white">{symbol}</span>
                    {/* MetaTrader's own column order: Bid, Ask, Spread, Time, Daily Change. Which
                        of them are drawn is the context menu's `Columns` submenu, and `Symbol` is
                        not among them because MetaTrader offers no way to hide it.

                        The breakpoints are MEASURED, not chosen: this panel is 240px at `lg` and
                        288px at `xl`, which leaves 222px and 270px inside its padding. Symbol, Bid
                        and Ask need 188px of that, so they are always drawn; Spread and Daily
                        Change bring it to 268px and appear at `xl`; Time brings it to 320px and
                        needs the 344px panel that arrives at `2xl`. MetaTrader drops a column off
                        the right edge of a narrow window rather than cutting one in half, and that
                        is what these are. Every column is a FIXED width for the same reason: a
                        flex-shared price column pushes the row past the panel instead of letting a
                        later column drop.

                        A price that has not landed reads "waiting" rather than a dash: the row is
                        subscribed and its first quote is on its way, because a symbol's price chain
                        takes a moment to build the first time it is asked for. */}
                    {columns.includes('bid') ? (
                      <span className="w-[58px] shrink-0 text-right">
                        {sides === null
                          ? <span className="font-mono text-[10px] text-[#4a5666]">waiting</span>
                          : <MT5Price value={sides.bid} digits={digits} className="text-[11px]" style={{ color: colour }} />}
                      </span>
                    ) : null}
                    {columns.includes('ask') ? (
                      <span className="w-[58px] shrink-0 text-right">
                        {sides === null
                          ? <span className="font-mono text-[10px] text-[#4a5666]">waiting</span>
                          : <MT5Price value={sides.ask} digits={digits} className="text-[11px]" style={{ color: colour }} />}
                      </span>
                    ) : null}
                    {/* Spread in the symbol's own POINTS, which is the unit MetaTrader's column
                        uses: its EURUSD row reads `0`, not `0.00001`. */}
                    {columns.includes('spread') ? (
                      <span className="hidden w-[26px] shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--mt5-muted)] xl:inline">
                        {points_ === null ? '' : points_}
                      </span>
                    ) : null}
                    {/* Time: "the last quote arrival time", in MetaTrader's own column order, which
                        puts it after the prices and before Daily Change. MetaTrader drops columns
                        off the right edge when the window is narrow; this panel does the same with
                        a breakpoint rather than by clipping. */}
                    {columns.includes('time') ? (
                      <span className="hidden w-[46px] shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--mt5-muted)] 2xl:inline">
                        {q?.t ? clockOf(q.t) : ''}
                      </span>
                    ) : null}
                    {/* Daily Change, last, as a signed percentage with NO space before the sign.
                        The account summary strip writes "1 076.68 %" WITH a space; MetaQuotes is
                        inconsistent between the two panels and both are copied as found. */}
                    {columns.includes('change') ? (
                      <span className="hidden w-[42px] shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--mt5-muted)] xl:inline">
                        {changePct === null ? '' : `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`}
                      </span>
                    ) : null}
                    </>
                    )}
                  </button>
                );
                return phone ? (
                  <MT5SwipeRow key={symbol} label={symbol} commands={swipe}>{row}</MT5SwipeRow>
                ) : row;
              })}
              {/* MetaTrader's add row, verbatim: "To quickly add a symbol in the Market Watch, click
                  + below the list and enter the name of the symbol." Its counter, right-aligned on
                  the same row, is "the current number of symbols in the Market Watch and the total
                  number of available symbols".

                  MetaTrader turns the row itself into an inline field with an autocomplete list;
                  this opens the Symbols dialog, which is the same search over the same catalogue in
                  a window a phone can use. */}
              {/* MetaTrader's add row is a DESKTOP control: its phone app puts the `+` in the top
                  bar, which this panel already does, so the row would be the same action twice. */}
              {phone ? null : (
              <button
                type="button"
                data-quote-add=""
                onClick={() => setSymbolsOpen(true)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] transition hover:bg-[var(--mt5-raised)]"
              >
                <span aria-hidden className="w-3 shrink-0 text-center text-[11px] leading-none text-[var(--mt5-green)]">+</span>
                <span className="flex-1 truncate text-[var(--mt5-muted)]">click to add...</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--mt5-muted)]">
                  {visible.length} / {catalogue.length || visible.length}
                </span>
              </button>
              )}
            </div>
          )
        ) : tab === 'trading' ? (
          /* MetaTrader's One Click Trading, one panel per symbol in the Symbols tab's own list. */
          <MT5OneClickTrading
            symbols={visible}
            quoteOf={quoteOf}
            digitsOf={digitsOf}
            settledSymbol={market?.instrument.symbol ?? null}
          />
        ) : tab === 'ticks' ? (
          /* MetaTrader draws the tick chart of the symbol SELECTED in the Symbols tab. The tick
             series this terminal has is the charted symbol's, which selecting a row sets, so the
             two are the same symbol by construction. */
          <div className="h-full min-h-[200px] w-full">
            <MT5TicksChart
              symbol={active}
              getTicks={() => getSymbolTicks(active)}
              digits={activeDigits}
              spread={spread}
              scale={activeQuote?.instrument.scale ?? market?.instrument.scale ?? null}
            />
          </div>
        ) : (
          <div className="text-[11px]">
            {/* MetaTrader's blue header line: the symbol, then its description. The Specification
                dialog carries the same line. */}
            <div className="bg-[var(--mt5-blue)] px-3 py-1 text-[11px] font-semibold text-white">
              {active}{describe(active) === '' ? '' : `, ${describe(active)}`}
            </div>
            {/* Not a grid: two columns, label left and value right-aligned, with the same
                three-state glyph the Symbols tab puts in its gutter. MetaTrader alternates its row
                backgrounds #FFFFFF / #EBEBEB; this is that alternation on the dark palette. */}
            <dl>
              {details.map((r, i) => {
                const rowGlyph = r.live ? glyphOfActive : 'flat';
                return (
                  <div
                    key={r.label}
                    data-detail-row={r.label}
                    className={cn('flex items-baseline gap-2 px-3 py-1', i % 2 === 1 ? 'bg-[#141c26]' : '')}
                  >
                    <span aria-hidden className="w-3 shrink-0 text-center text-[10px] leading-none" style={{ color: GUTTER_COLOUR[rowGlyph] }}>
                      {GUTTER_GLYPH[rowGlyph]}
                    </span>
                    <dt className="min-w-0 flex-1 truncate text-[var(--mt5-muted)]">{r.label}</dt>
                    <dd
                      className="shrink-0 font-mono tabular-nums"
                      style={{ color: r.live && activeTone !== null ? QUOTE_TONE_COLOUR[activeTone] : '#ffffff' }}
                    >
                      {r.value}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <div className="px-3 py-2">
              {/* MetaTrader reaches this from the context menu. A phone has no right click, so the
                  Details tab carries it too. */}
              <button
                type="button"
                onClick={() => setSpecOpen(true)}
                className="h-7 w-full rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[11px] font-semibold text-[var(--mt5-text)] transition hover:border-[var(--mt5-blue)]"
              >
                Specification
              </button>
            </div>
          </div>
        )}
      </div>

      {/* MetaTrader Android's Quotes row menu, which a TAP opens on a phone. Its six items are its
          own, in its own order; see MT5MobileQuoteMenu. */}
      {phone && sheet !== null ? (
        <MT5MobileQuoteMenu
          title={sheet}
          subtitle={describe(sheet) === '' ? 'Instrument' : describe(sheet)}
          onDismiss={() => setSheet(null)}
          items={[
            // "hidden when not connected to the server" — MetaTrader's own rule for this item, and
            // the only one of the six it drops rather than disables.
            ...(status === 'open'
              ? [{
                  label: 'New order',
                  ...(sheet === defaultSymbol
                    ? { onPick: () => { openChart(sheet); onNewOrder?.(); } }
                    : { unavailable: `This brand settles ${defaultSymbol ?? 'one symbol'} only, so an order cannot be placed on ${sheet}.` }),
                }]
              : []),
            { label: 'Chart', onPick: () => { openChart(sheet); onChart?.(); } },
            // MetaTrader's phone calls the symbol specification "Properties".
            { label: 'Properties', onPick: () => { setSelected(sheet); setSpecOpen(true); } },
            { label: 'Depth of Market', unavailable: 'This engine quotes one price per symbol and keeps no order book, so there is no depth to show.' },
            // Its "Market statistics" is the session figures, which is this panel's Details tab.
            { label: 'Market statistics', onPick: () => { setSelected(sheet); setTab('details'); } },
            { label: 'Advanced view mode', checked: view === 'advanced', onPick: toggleView },
          ]}
        />
      ) : null}

      {menu ? (
        <MT5MarketWatchMenu
          at={{ x: menu.x, y: menu.y }}
          items={menuItems}
          onDismiss={() => setMenu(null)}
        />
      ) : null}

      {symbolsOpen ? (
        <MT5SymbolsDialog
          catalogue={catalogue}
          watched={visible}
          onApply={replace}
          onDismiss={() => setSymbolsOpen(false)}
        />
      ) : null}

      {specOpen ? (
        <MT5Specification
          spec={{
            symbol: active,
            // MetaTrader prints the instrument's description beside the symbol in its blue header.
            description: describe(active) === '' ? active : describe(active),
            digits: activeDigits,
            contractSize: money.fmt(LOT_STAKE_CENTS),
            currency: money.currency,
            /* MetaTrader prints the SYMBOL's own three volume numbers here, not the brand's one
               range: "Minimal volume", "Maximal volume", "Volume step" are per instrument. The
               brand's money limits still narrow them, because they are what the engine enforces. */
            minVolume: activeVolume.min,
            maxVolume: activeVolume.max,
            volumeStep: activeVolume.step,
            expiries: DURATION_OPTIONS.map(durationLabel),
            /* The brand's own fixed spread, in this symbol's points: the same figure the Symbols
               grid prints in its Spread column, derived from the same two sides. */
            spreadPoints: activeSides === null
              ? null
              : spreadPoints(activeSides.bid, activeSides.ask, activeDigits),
            /* The step decides the decimals, so an index reads 0.1 and a major 0.01; one more
               place where the brand's minimum sits off the symbol's grid. */
            volumeDigits: volumeDigitsOf(activeVolume)
              + (Math.abs(activeVolume.min / activeVolume.step - Math.round(activeVolume.min / activeVolume.step)) < 1e-9 ? 0 : 1),
            /**
             * Only the symbol this brand settles accepts an order. Every other one is quoted and
             * charted but not tradable, which is MetaTrader's own `Disabled` trade mode rather than
             * a gap: a broker sets it on a symbol it quotes and will not accept an order on.
             */
            tradeMode: active === defaultSymbol ? 'Full access' : 'Disabled',
          }}
          onDismiss={() => setSpecOpen(false)}
        />
      ) : null}

      {/* MetaTrader's Market Watch tabs sit along the bottom of the panel, as the Toolbox's do. */}
      {/* MetaTrader's four Market Watch tabs are a DESKTOP window's tabs. Its phone app has no
          such strip: it reaches the same places from the row's own context menu, and stacking a
          second bar under the five-tab bar would put two rows of chrome along the bottom of a
          360px screen. Details is reached from `Market statistics`, and the Specification from
          `Properties`. */}
      {/* The strip has to FIT the panel it is drawn in, and it did not: the `aside` is `lg:w-60`
          until `xl:w-72` (TradeSurface.tsx:126) and clips its overflow, so at every width below
          1280 the four tabs measured 248px of content in a 238px box and `Ticks` ran from x 213 to
          261 while the panel ended at 251. Ten of its pixels, part of the final "s" among them,
          were painted over AND unclickable: `document.elementFromPoint` on that column returned the
          panel, not the tab. `px-2` on a tab is what did not fit, so a tab is `px-1.5` and the four
          come to 232px; the strip also scrolls now, which is MetaTrader's own answer to a tab strip
          with no room ("when the panel is too narrow, `◀ ▶` scroll arrows appear at the right of
          the strip", docs/mt5/10-market-watch.md:96) rather than a tab hidden under an edge. */}
      {phone ? null : (
      <div data-mw-tabs="" className="flex gap-0.5 overflow-x-auto border-t border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold transition',
              tab === t.id ? 'bg-[var(--mt5-border)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      )}
    </aside>
  );
}

/**
 * MetaTrader mobile's open-position marker on a Quotes row.
 *
 * "a small filled triangle in the row's top-LEFT corner — blue (#1C5FE9 measured) = net floating
 * profit, red = loss" (docs/mt5/04-mobile-app.md 81). It is a CORNER triangle, a dog-ear filling the
 * angle of the row rather than a centred ▲ in a gutter, which is why it is drawn as a polygon
 * against the row's own two edges and sits outside the flex flow entirely.
 *
 * MetaQuotes' own help text places it "on the right" and every screenshot puts it top-left; the
 * reference notes the contradiction and resolves it the way this repo always does: the screenshot
 * wins.
 *
 * Its size is not a measured figure. The reference says "small" and publishes no dimension, so this
 * is 7px, scaled to the 15px symbol beside it — named here as a choice rather than passed off as a
 * sample.
 *
 * `mark` of null draws nothing, which is the common case: no exposure on this symbol, or the
 * catalogue has not landed yet so which symbol carries the positions is not yet known.
 */
function PositionCorner({ mark }: { mark: PositionMark | null }) {
  if (mark === null) return null;
  return (
    <svg
      viewBox="0 0 7 7"
      className="pointer-events-none absolute left-0 top-0 h-[7px] w-[7px]"
      // "You have an open position on this symbol" is not decoration, and a trader using a screen
      // reader is the one who most needs telling. The colour says which way it is going; so does
      // this, because a label naming only the triangle would carry none of the meaning.
      role="img"
      aria-label={mark === 'profit' ? 'Open position, in profit' : 'Open position, at a loss'}
    >
      <polygon points="0,0 7,0 0,7" fill={POSITION_MARK_COLOUR[mark]} />
    </svg>
  );
}

/**
 * The Time column: `16:56:57`.
 *
 * MetaTrader's own caption is "the last quote arrival time, specified according to the time zone of
 * the broker's trading server". There is no separate server time zone here, so it is the viewer's
 * clock, which is the same instant named differently.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};


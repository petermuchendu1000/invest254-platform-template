'use client';

import { useEffect, useRef } from 'react';
import {
  SPEC_GLYPH, SPEC_SESSION_DAYS, SPEC_SESSION_SPAN, specRows, type SpecInput,
} from '@/lib/game/symbolSpec';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Specification dialog, from `contract_specification.png`.
 *
 * Titled just `Specification`, with a yellow badge. A blue header line carries the symbol and its
 * description ("EURUSD, Euro vs US Dollar"), then a two-column list with a type glyph against each
 * row, the label left and the value right-aligned, then the Sessions block, then a single `Close`
 * button. See docs/mt5/02-toolbox-and-panels.md section 5h.
 *
 * Which rows appear is decided in lib/game/symbolSpec, where each omission is argued. MetaQuotes
 * states that "which fields appear depends on instrument type and broker", so a row that has no
 * meaning for this instrument is left out rather than printed empty, which is MetaTrader's own
 * behaviour and the reason there are no swap rows on a contract that expires in seconds.
 */
export function MT5Specification({ spec, onDismiss }: { spec: SpecInput; onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const rows = specRows(spec);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Specification"
      className="fixed inset-0 z-[85] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-[72vh] sm:max-w-[420px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span aria-hidden className="grid h-4 w-4 shrink-0 place-items-center rounded-[2px] bg-[#f0b90b] text-[10px] font-black text-[var(--mt5-surface)]">$</span>
          <span className="flex-1 truncate text-[15px] font-semibold leading-tight">Specification</span>
          <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white">×</button>
        </div>

        {/* MetaTrader's blue header line: the symbol, then its description. */}
        <div className="shrink-0 bg-[var(--mt5-blue)] px-3 py-1.5 text-[12px] font-semibold text-white">
          {spec.symbol}, {spec.description}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <dl className="text-[11px]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline gap-2 border-b border-[var(--mt5-border)]/60 px-3 py-1.5">
                <span aria-hidden className="w-5 shrink-0 font-mono text-[9px] text-[var(--mt5-muted)]">{SPEC_GLYPH[r.kind]}</span>
                <dt className="min-w-0 flex-1 truncate text-[var(--mt5-muted)]">{r.label}</dt>
                <dd className="shrink-0 text-right font-mono tabular-nums text-white">{r.value}</dd>
              </div>
            ))}
          </dl>

          {/* MetaTrader's Sessions block: a Quotes column and a Trade column, one row per weekday. */}
          <div className="mt-2 px-3 pb-3">
            <div className="mb-1 flex gap-2 border-b border-[var(--mt5-border)] pb-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--mt5-muted)]">
              <span className="flex-1">Sessions</span>
              <span className="w-24 text-right">Quotes</span>
              <span className="w-24 text-right">Trade</span>
            </div>
            {SPEC_SESSION_DAYS.map((d) => (
              <div key={d} className="flex gap-2 py-0.5 text-[11px]">
                <span className="flex-1 text-[var(--mt5-muted)]">{d}</span>
                <span className="w-24 text-right font-mono tabular-nums">{SPEC_SESSION_SPAN}</span>
                <span className="w-24 text-right font-mono tabular-nums">{SPEC_SESSION_SPAN}</span>
              </div>
            ))}
            <p className="mt-2 text-[10px] leading-snug text-[var(--mt5-muted)]">
              This market never closes, so quotes and trading run every day.
            </p>
          </div>
        </div>

        {/* One button, as MetaTrader has. */}
        <div className="flex shrink-0 items-center justify-end border-t border-[var(--mt5-border)] px-3 py-2.5">
          <button
            type="button"
            onClick={onDismiss}
            className="h-8 rounded-sm bg-[var(--mt5-blue)] px-6 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * MetaTrader's Market Watch context menu, verbatim, including its capital O in "Depth Of Market"
 * and the shortcuts it prints.
 *
 * MetaQuotes ships TWO versions of this menu on the same help page. The older one carries
 * `Use System Colors`; the newer one drops it entirely and inserts `Subscribe to Realtime Datafeed`
 * and `Fundamental Data` after `Specification`. This is the NEWER one, and the prose on that same
 * page still tells you to enable a checkbox the dialog no longer has.
 *
 * `Options Board` is greyed in MetaTrader's own screenshot, so it is greyed here too. `Auto Arrange`
 * is UNCHECKED here, unlike in every Toolbox tab, which is also MetaTrader's own state.
 *
 * Everything the list can genuinely do is wired to a callback; everything it cannot carries the
 * reason, because a disabled item with no reason reads as a bug. The reasons changed when the
 * catalogue did: `Hide`, `Show All`, `Symbols` and `Sort` were disabled while a brand quoted one
 * symbol and are real actions now, while `Popup Prices` and `Columns` are refused for reasons that
 * have nothing to do with how many symbols there are.
 */
export interface MarketWatchMenuItem {
  label: string;
  shortcut?: string;
  unavailable?: string;
  separatorBefore?: boolean;
  checked?: boolean;
  onPick?: () => void;
  /**
   * A flyout, as MetaTrader's `Columns ▸` is. An item with one opens on hover and on click and
   * picks nothing itself; its children are ordinary items.
   */
  submenu?: readonly MarketWatchMenuItem[];
}

const NO_BOOK =
  'Depth of Market needs an order book. Contracts here are struck against the brand, not matched against other orders, so there is no book to show.';

export function marketWatchMenu(opts: {
  onSpecification: () => void;
  onNewOrder?: (() => void) | undefined;
  /** MetaTrader's Symbols dialog (Ctrl+U). */
  onSymbols?: (() => void) | undefined;
  /** `Hide` (Delete): drop the symbol the menu was opened on. */
  onHide?: (() => void) | undefined;
  onHideAll?: (() => void) | undefined;
  onShowAll?: (() => void) | undefined;
  onSort?: (() => void) | undefined;
  /** `Grid`: MetaTrader's grid-line toggle, with its current state. */
  grid?: { on: boolean; toggle: () => void } | undefined;
  /** Whether the chart can be switched to the symbol the menu was opened on. */
  onChartWindow?: (() => void) | undefined;
  /** `Tick Chart`: show this window's Ticks tab. */
  onTickChart?: (() => void) | undefined;
  /** `Columns ▸`: MetaTrader's optional column set, with each column's state and toggle. */
  columns?: { items: ReadonlyArray<{ label: string; on: boolean; toggle: () => void }> } | undefined;
}): MarketWatchMenuItem[] {
  // An action is offered when this platform can genuinely do it and carries a reason when it
  // cannot. A disabled item with no reason is worse than no item: it looks like a bug.
  const act = (fn: (() => void) | undefined, why: string) =>
    (fn ? { onPick: fn } : { unavailable: why });
  return [
    { label: 'New Order', ...act(opts.onNewOrder, 'The order ticket is already on screen.') },
    {
      label: 'Chart Window',
      ...act(opts.onChartWindow, 'The chart draws the symbol this brand settles on. Charting another is not built yet, and a chart the order ticket could not trade would be worse than none.'),
    },
    // MetaTrader's `Tick Chart` opens the Market Watch Ticks tab, which this window now has.
    { label: 'Tick Chart', ...act(opts.onTickChart, 'The Ticks tab is already open.') },
    { label: 'Depth Of Market', shortcut: 'Alt+B', unavailable: NO_BOOK },
    // Greyed in MetaTrader's own screenshot.
    { label: 'Options Board', unavailable: 'Greyed in MetaTrader too: there are no options on this instrument.' },
    { label: 'Specification', onPick: opts.onSpecification },
    { label: 'Subscribe to Realtime Datafeed', unavailable: 'The quote here is already the live feed; there is no delayed one to upgrade from.' },
    { label: 'Fundamental Data', unavailable: 'MetaTrader links out to twelve financial-news sites from here. This platform links to none.' },
    {
      label: 'Popup Prices',
      shortcut: 'F10',
      unavailable: 'Popup Prices is a separate always-on-top window. This terminal runs in a browser tab, which cannot open one.',
    },
    { label: 'Hide', shortcut: 'Delete', separatorBefore: true, ...act(opts.onHide, 'There is no symbol selected to hide.') },
    { label: 'Hide All', ...act(opts.onHideAll, 'The list is already empty.') },
    { label: 'Show All', ...act(opts.onShowAll, 'Every symbol this feed quotes at once is already shown.') },
    { label: 'Symbols', shortcut: 'Ctrl+U', ...act(opts.onSymbols, 'The symbol list has not arrived yet.') },
    {
      label: 'Sets',
      unavailable: 'Saved symbol sets are not built on this platform. The list itself is remembered per device.',
    },
    { label: 'Sort', ...act(opts.onSort, 'There is nothing to sort.') },
    { label: 'Export', unavailable: 'Quote export is not built on this platform.' },
    // The newer menu has no `Use System Colors`.
    { label: 'Show Milliseconds', separatorBefore: true, unavailable: 'This feed is not quoted to the millisecond.' },
    { label: 'Auto Remove Expired', checked: true, unavailable: 'Nothing here expires out of the list: no symbol in this catalogue has an expiry date.' },
    {
      label: 'Auto Arrange',
      unavailable: 'MetaTrader fits its column widths to the window. The columns here are a fixed layout, so there is nothing to arrange.',
    },
    ...(opts.grid
      ? [{ label: 'Grid', checked: opts.grid.on, onPick: opts.grid.toggle }]
      : [{ label: 'Grid', checked: true, unavailable: 'The grid is on.' }]),
    // MetaTrader's `Columns ▸` submenu. Its optional set is Bid, Ask, Spread, Time and Daily
    // Change; `Symbol` is not among them, because MetaTrader offers no way to hide it.
    {
      label: 'Columns',
      separatorBefore: true,
      ...(opts.columns
        ? { submenu: opts.columns.items.map((c) => ({ label: c.label, checked: c.on, onPick: c.toggle })) }
        : { unavailable: 'The column set is fixed on this surface.' }),
    },
  ];
}

export function MT5MarketWatchMenu({ at, items, onDismiss }: {
  at: { x: number; y: number };
  items: readonly MarketWatchMenuItem[];
  onDismiss: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    /**
     * Only a mousedown OUTSIDE the menu closes it.
     *
     * Dismissing on any mousedown looked equivalent and was not: a click is mousedown then mouseup,
     * so the menu unmounted on the way down and the item's own onClick never ran. Every entry in
     * this menu was therefore dead.
     */
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onDismiss(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onDismiss]);

  return (
    <div
      ref={box}
      role="menu"
      aria-label="Market Watch"
      className="fixed z-[90] min-w-52 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[11px] shadow-xl"
      style={{ left: at.x, top: at.y }}
    >
      {items.map((it) => (
        <div key={it.label} className={it.submenu ? 'group relative' : undefined}>
          {it.separatorBefore ? <div className="my-1 h-px bg-[var(--mt5-border)]" /> : null}
          <button
            type="button"
            role="menuitem"
            // A stable hook for the label, since the rendered row also carries a tick glyph and a
            // shortcut, so matching on its text alone confuses `Hide` with `Hide All`.
            data-mw-item={it.label}
            data-mw-checked={it.checked === true ? '' : undefined}
            title={it.unavailable}
            disabled={it.unavailable !== undefined}
            // An item with a flyout picks nothing of its own: it is a heading for its children, and
            // dismissing the menu on its click would close the flyout before it could be used.
            onClick={() => { if (it.submenu) return; it.onPick?.(); onDismiss(); }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left transition',
              it.unavailable ? 'cursor-not-allowed text-[#4a5666]' : 'text-white hover:bg-[var(--mt5-blue)]',
            )}
          >
            <span aria-hidden className="w-3 shrink-0 text-[var(--mt5-green)]">{it.checked ? '✓' : ''}</span>
            <span className="flex-1">{it.label}</span>
            {it.shortcut ? <span className="shrink-0 text-[10px] text-[var(--mt5-muted)]">{it.shortcut}</span> : null}
            {it.submenu ? <span aria-hidden className="shrink-0 text-[10px] text-[var(--mt5-muted)]">▸</span> : null}
          </button>
          {it.submenu ? (
            /* MetaTrader's flyout, opening to the RIGHT of its parent row. It is hidden rather than
               unmounted so the hover that opens it is not interrupted by a remount, and it stays
               open while the pointer is anywhere in the group, which is what lets a trader cross
               the gap between the row and the panel. */
            <div
              role="menu"
              aria-label={it.label}
              data-mw-submenu={it.label}
              className="absolute left-full top-0 z-[91] hidden min-w-40 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 shadow-xl group-hover:block group-focus-within:block"
            >
              {it.submenu.map((sub) => (
                <button
                  key={sub.label}
                  type="button"
                  role="menuitem"
                  data-mw-item={sub.label}
                  data-mw-checked={sub.checked === true ? '' : undefined}
                  // A column toggle does NOT dismiss: MetaTrader's own stays open so several can be
                  // switched in one visit, and the grid behind it updates as each is picked.
                  onClick={() => sub.onPick?.()}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white transition hover:bg-[var(--mt5-blue)]"
                >
                  <span aria-hidden className="w-3 shrink-0 text-[var(--mt5-green)]">{sub.checked ? '✓' : ''}</span>
                  <span className="flex-1">{sub.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

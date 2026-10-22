'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TIMEFRAME_KEYS } from '@invest254/shared/candles';
import { useAuthUi } from '@/lib/auth/ui';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's desktop application chrome: the menu bar and the three toolbars.
 *
 * Until this existed the whole top of the terminal was the brand's `#3183ff` band with a hamburger,
 * a wordmark and an avatar on it — the single loudest "web app, not terminal" signal left on the
 * screen, and the one `docs/mt5/19-desktop-phone-parity.md` 134-136 carried forward: "On the desktop
 * terminal MetaTrader uses dark chrome with a File/View/Insert menu. A shell-structure question."
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────────────────
 *
 * It is not a second implementation of anything. Every row and every button here reaches a handler
 * that already exists — through the accelerator MetaTrader itself prints beside the command, or
 * through the chart's own control. That is what MetaTrader's chrome IS: MetaQuotes states verbatim
 * of the Charts menu and the chart context menu that "Commands in these menus are identical"
 * (docs/mt5/08-chart-properties.md 554-556), so a menu bar is a second ROUTE to one terminal, never
 * a second copy of it that can disagree with it.
 *
 * Three consequences follow, and they are the whole design:
 *
 *   1. A command is sent as the KEYSTROKE MetaTrader prints for it. `Properties` sends F8, `Grid`
 *      sends Ctrl+G, `Bar Chart` sends Alt+1. The chart, Market Watch and the Toolbox already listen
 *      for those on `window` — that is how a trader reaches them today — so the menu is one more
 *      caller of a listener that is already there, and there is no new state anywhere.
 *   2. Where MetaTrader has no accelerator (the periods, the crosshair, the object tree) the button
 *      clicks the chart's OWN control, found by the accessible name it already carries. Same
 *      handler, same state, same place a screen reader finds it.
 *   3. `Charts` draws no list of its own. It opens MetaTrader's chart menu itself, which this
 *      terminal already builds and already prunes to what it can honour (see `MT5ChartMenu` in
 *      CandleChart). Re-listing those rows here would be the one thing this file must not do.
 *
 * ── WHAT IS DELIBERATELY NOT DRAWN ────────────────────────────────────────────────────────────────
 *
 * `Tools`, `Window` and `Help` are three of MetaTrader's seven menu titles (the bar reads
 * `File · View · Insert · Charts · Tools · Window · Help`, read off MetaQuotes' own `char_color.png`
 * — docs/mt5/08-chart-properties.md 94-98, and again at docs/mt5/09-toolbox.md 105). They carry no
 * row this platform can act on: the only Tools item MetaQuotes documents is the Options dialog
 * (docs/mt5/05-options-reports-tradingview.md 22), which is not built here; Window manages MDI chart
 * windows and this terminal has one chart in one page; and Help links to MQL5.com. A title that
 * opens an empty list is worse than no title, which is the same rule the Market Watch menu already
 * applies row by row (`marketWatchMenu` in MT5Specification).
 *
 * The brand band above STAYS. Its hamburger is the whole of this app's navigation on a terminal
 * brand — the bottom nav is gone and `MT5Drawer` replaced it — so removing it to make room would
 * take account, funds, history and sign-out with it. MetaTrader's chrome sits directly under it
 * instead, flush, which is also how the real thing is stacked: a window title bar, then the menu,
 * then the toolbars.
 */

/* ── reaching the terminal that is already on screen ──────────────────────────────────────────── */

/**
 * Send one of MetaTrader's own accelerators at the window.
 *
 * `code` as well as `key`, because the handlers are split between the two: the chart reads `e.code`
 * for anything with Alt on it ("Alt is a modifier that rewrites `key` on several keyboard layouts
 * while the physical key stays put") and `e.key` for F8 and Ctrl+B, while Market Watch and the
 * Toolbox read `e.key`. Sending both means a menu row cannot be broken by which one a listener
 * happens to have picked.
 */
function accelerator(spec: { key: string; code?: string; ctrl?: boolean; alt?: boolean }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: spec.key,
    ...(spec.code === undefined ? {} : { code: spec.code }),
    ctrlKey: spec.ctrl === true,
    altKey: spec.alt === true,
    bubbles: true,
    cancelable: true,
  }));
}

/**
 * The terminal's own controls, with this chrome's copies excluded.
 *
 * The exclusion is load-bearing rather than tidy: the Periodicity toolbar draws a button reading
 * `M1` beside the chart's own button reading `M1`, so a lookup that did not skip this subtree would
 * find itself and click nothing.
 */
function terminalControl(selector: string, label?: (el: HTMLElement) => boolean): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((el) => el.closest('[data-mt5-chrome]') === null);
  const found = label === undefined ? all[0] : all.find(label);
  return found ?? null;
}

/** Click a control the chart draws, if it is on screen. Silent when it is not: see `MT5Chrome`. */
function clickTerminalControl(ariaLabel: string): void {
  terminalControl(`[aria-label="${ariaLabel}"]`)?.click();
}

/**
 * Open MetaTrader's chart menu under a menu-bar title.
 *
 * The chart opens it on `contextmenu` over the plot and nowhere else, so this sends exactly that
 * event at the chart host, with the title's own corner as the point. The menu clamps itself into the
 * window from there (`MT5ChartMenu` measures after layout), so a title near the right edge still
 * gets a menu that is fully on screen.
 */
function openChartMenu(at: { x: number; y: number }): void {
  terminalControl('[role="img"][aria-label$="price chart"]')?.dispatchEvent(
    new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }),
  );
}

/* ── the toolbars, as data ────────────────────────────────────────────────────────────────────── */

/**
 * MetaTrader's three built-in toolbars, under MetaQuotes' own names.
 *
 * "Three built-in toolbars: **Standard, Line Studies and Periodicity**" — docs/mt5/03-chart-ui.md
 * 21-26, which also records that the charts page calls the third one "Timeframes" and that
 * MetaQuotes uses both names, so the one the live View menu shows is unverified. `Periodicity` is
 * the name on the interface page and is used here.
 */
type ToolbarId = 'standard' | 'lineStudies' | 'periodicity';

const TOOLBARS: ReadonlyArray<{ id: ToolbarId; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'lineStudies', label: 'Line Studies' },
  { id: 'periodicity', label: 'Periodicity' },
];

/** Which toolbars are showing. MetaTrader opens with all three; `View` turns them off. */
const ALL_ON: Record<ToolbarId, boolean> = { standard: true, lineStudies: true, periodicity: true };
const TOOLBARS_KEY = 'pp-mt5-toolbars';

/**
 * One Standard-toolbar button, and the route it takes.
 *
 * MetaQuotes publishes no toolbars page for MT5 at all — "confirmed by crawling the full 138-URL
 * help link graph and by querying the Wayback CDX index" — so there is no authoritative ORDER and no
 * tooltip-exact list. What there is, and all that is drawn here, is the set of buttons individually
 * confirmed on the Standard toolbar: docs/mt5/03-chart-ui.md 28-32.
 *
 * Seven of those confirmed buttons are missing below, each because the thing itself is missing:
 *   New Order      the order ticket is docked to the right of the chart and never closed, so there
 *                  is no window to open. Market Watch's own menu already refuses it for this exact
 *                  reason ("The order ticket is already on screen.", MT5Specification).
 *   Print,         this terminal has no print layout, and a button that printed the page's chrome
 *   Print Preview  would not be MetaTrader's chart print.
 *   Templates      MetaTrader's templates are chart-settings FILES; this chart persists its settings
 *                  per symbol instead and has no file to save or load (the same reason the chart
 *                  menu leaves `Templates ▸` out).
 *   Profiles       a profile is a saved arrangement of chart WINDOWS. There is one chart.
 *   AutoTrading    this platform runs no Expert Advisors, which is why the Toolbox hides the Experts
 *                  tab's content too (lib/game/toolboxTabs).
 *   New Chart      one chart, one page.
 */
interface ToolButton {
  label: string;
  /** MetaTrader's own accelerator, printed in the tooltip where it has one. */
  accel?: string;
  run: () => void;
  icon: string;
}

const STANDARD: readonly ToolButton[] = [
  {
    // The ⚙ Tools menu IS this chart's indicator list, which is what Ctrl+I opens.
    label: 'Indicators', accel: 'Ctrl+I',
    run: () => accelerator({ key: 'i', code: 'KeyI', ctrl: true }),
    icon: 'M3 17l4-7 4 4 4-8 4 6M3 11c3-5 6 5 9 0s6-5 9 0',
  },
  {
    label: 'Bar Chart', accel: 'Alt+1',
    run: () => accelerator({ key: '1', code: 'Digit1', alt: true }),
    icon: 'M7 5v14M4 8h3M7 15h3M17 5v14M14 9h3M17 16h3',
  },
  {
    label: 'Candlesticks', accel: 'Alt+2',
    run: () => accelerator({ key: '2', code: 'Digit2', alt: true }),
    icon: 'M8 4v3M8 17v3M16 3v4M16 15v6M5.5 7h5v10h-5zM13.5 7h5v8h-5z',
  },
  {
    label: 'Line Chart', accel: 'Alt+3',
    run: () => accelerator({ key: '3', code: 'Digit3', alt: true }),
    icon: 'M3 17l5-6 4 3 4-7 5 4',
  },
  {
    label: 'Zoom In', accel: '+',
    run: () => accelerator({ key: '+', code: 'Equal' }),
    icon: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6M11 8v6',
  },
  {
    label: 'Zoom Out', accel: '-',
    run: () => accelerator({ key: '-', code: 'Minus' }),
    icon: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6',
  },
];

/**
 * The Line Studies toolbar.
 *
 * Two buttons are confirmed on it and only two: "Crosshair is on the **Line Studies** toolbar, and
 * Arrows is a dropdown button on it" (docs/mt5/03-chart-ui.md 34). The Objects button here IS that
 * dropdown's parent: it opens the chart's `Insert → Objects` tree, which carries all 44 objects in
 * MetaTrader's eight categories including the eleven Arrows (docs/mt5/03-chart-ui.md 111-122).
 * Redrawing those eleven as a dropdown of this toolbar's own would be a second object tree.
 *
 * `Objects List` is third because the rail that owns it already states where MetaTrader puts it:
 * "MetaTrader opens the Objects List on Ctrl+B, from the View menu and from the Line Studies
 * toolbar" (`DrawRail`, CandleChart).
 */
const LINE_STUDIES: readonly ToolButton[] = [
  {
    label: 'Crosshair',
    run: () => clickTerminalControl('Crosshair'),
    icon: 'M12 3v18M3 12h18',
  },
  {
    label: 'Objects',
    run: () => clickTerminalControl('Objects'),
    icon: 'M4 19L20 5M4.6 18.4h.01M19.4 5.6h.01',
  },
  {
    label: 'Objects List', accel: 'Ctrl+B',
    run: () => accelerator({ key: 'b', code: 'KeyB', ctrl: true }),
    icon: 'M4 7h16M4 12h16M4 17h16',
  },
];

/**
 * One toolbar button: MetaTrader's toolbars are icons with a tooltip, and the tooltip carries the
 * accelerator where the command has one, so the keystroke the button sends is also the keystroke the
 * trader learns. Declared here rather than inside `MT5Chrome`, because a component declared inside
 * another is a new type on every render and React rebuilds the tree instead of updating it.
 */
function ToolbarButton({ b }: { b: ToolButton }) {
  return (
    <button
      type="button"
      onClick={b.run}
      aria-label={b.label}
      title={b.accel === undefined ? b.label : `${b.label} (${b.accel})`}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-[var(--mt5-muted)] transition hover:bg-[var(--mt5-border)] hover:text-white"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={b.icon} />
      </svg>
    </button>
  );
}

/* ── the component ────────────────────────────────────────────────────────────────────────────── */

type MenuId = 'file' | 'view' | 'insert';

export function MT5Chrome() {
  const openAuth = useAuthUi((s) => s.openAuth);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [toolbars, setToolbars] = useState<Record<ToolbarId, boolean>>(ALL_ON);
  const bar = useRef<HTMLDivElement>(null);

  /**
   * Which toolbars are showing, read back after mount rather than in the initialiser.
   *
   * The house reason: an initialiser runs during the server render too, where there is no
   * localStorage, and a first client paint seeded differently from the server's is a hydration
   * mismatch. Same shape as `useRestoreOneClick` and `useRestoreChartSymbol`.
   */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TOOLBARS_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Partial<Record<ToolbarId, boolean>>;
      setToolbars({
        standard: saved.standard !== false,
        lineStudies: saved.lineStudies !== false,
        periodicity: saved.periodicity !== false,
      });
    } catch { /* blocked or corrupt storage: all three show, which is MetaTrader's own default */ }
  }, []);

  const toggleToolbar = useCallback((id: ToolbarId) => {
    setToolbars((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { window.localStorage.setItem(TOOLBARS_KEY, JSON.stringify(next)); }
      catch { /* private mode: the choice still holds for this session */ }
      return next;
    });
  }, []);

  /**
   * The period the CHART is on, read off the chart rather than kept here.
   *
   * There is no store behind it — the chart owns `tf` as its own state — so the alternative to
   * reading it would be a second copy in this file, and a second copy is exactly what goes stale the
   * first time a trader changes the period from the chart's own strip, the chart menu or a reload.
   * `aria-pressed` is the chart's existing answer to "which one is active" and is what a screen
   * reader reads, so it is what this reads.
   */
  const [activeTf, setActiveTf] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const on = terminalControl(
        'button[aria-pressed="true"]',
        (el) => TIMEFRAME_KEYS.includes((el.textContent ?? '').trim() as (typeof TIMEFRAME_KEYS)[number]),
      );
      setActiveTf(on === null ? null : (on.textContent ?? '').trim());
    };
    read();
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, []);

  // A menu closes on Escape and on a click anywhere outside the bar, as every menu on this terminal
  // does. `mousedown` rather than `click`: on `click` the row unmounts on the way down and its own
  // handler never runs, which is the bug `MT5MarketWatchMenu` records.
  useEffect(() => {
    if (menu === null) return;
    const away = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const chooseTf = (key: string) => {
    terminalControl('button[aria-pressed]', (el) => (el.textContent ?? '').trim() === key)?.click();
    setActiveTf(key);
  };

  const title = 'flex h-full items-center px-2 text-[11px] leading-none text-[#cfd8e3] transition hover:bg-[var(--mt5-blue)] hover:text-white aria-expanded:bg-[var(--mt5-blue)] aria-expanded:text-white';
  const row = 'flex w-full items-center gap-3 px-3 py-1 text-left text-[11px] text-white transition hover:bg-[var(--mt5-blue)]';
  const grip = <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--mt5-border)]" />;

  return (
    <div
      data-mt5-chrome=""
      /**
       * Below `lg` this is not drawn at all, in CSS rather than by a width read in JavaScript.
       * `useIsPhone` reports false until mount, so a JS check would paint a desktop menu bar across
       * a 360px phone and then take it away — and below `lg` a terminal brand is rendering
       * MetaTrader's PHONE app, which has no menu bar and no toolbars to begin with.
       *
       * The negative margins cancel the shell's own gutters (`lg:px-3 lg:pt-2 xl:px-4` in AppShell)
       * so the chrome sits flush under the title bar, edge to edge, the way MetaTrader stacks it.
       */
      className="-mx-3 -mt-2 hidden shrink-0 select-none border-b border-[var(--mt5-border)] bg-[var(--mt5-raised)] lg:block xl:-mx-4"
    >
      {/* ── the menu bar ─────────────────────────────────────────────────────────────────────── */}
      <div ref={bar} role="menubar" aria-label="Terminal" className="flex h-[22px] items-center border-b border-[var(--mt5-border)]">
        {/*
          File. MetaQuotes documents exactly two of its items and they are both account routes:
          "Click 'Open an Account' in the File menu or in the context menu of the Navigator window"
          and "Click 'Login to Trade Account' in the File menu or in the Navigator"
          (docs/mt5/05-options-reports-tradingview.md 99 and 135). Both open the terminal's own
          sign-in surface, which on this brand is already MetaTrader's (AuthModal).
        */}
        <div className="relative h-full">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menu === 'file'} onClick={() => setMenu(menu === 'file' ? null : 'file')} className={title}>File</button>
          {menu === 'file' ? (
            <div role="menu" aria-label="File" className="absolute left-0 top-full z-[60] min-w-[200px] rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 shadow-xl">
              <button type="button" role="menuitem" className={row} onClick={() => { setMenu(null); openAuth('register'); }}>Open an Account</button>
              <button type="button" role="menuitem" className={row} onClick={() => { setMenu(null); openAuth('login'); }}>Login to Trade Account</button>
            </div>
          ) : null}
        </div>

        {/*
          View. The three toolbars are what MetaQuotes puts in this menu — it is the page that names
          them that also leaves open "which string the live View menu uses" for the third
          (docs/mt5/03-chart-ui.md 21-26), so the menu is where they are switched on and off.

          Market Watch (Ctrl+M) and the Toolbox (Ctrl+T) are NOT here, and that is not an oversight:
          MetaQuotes documents a hot key for each and no menu route for either — "It never names the
          View menu item for the Toolbox" (docs/mt5/09-toolbox.md 104-106) and "There is no documented
          menu route" for Market Watch (docs/mt5/10-market-watch.md 106-109). Both shortcuts work on
          this terminal today; inventing the rows they might sit on would not make them more
          reachable, only less true.
        */}
        <div className="relative h-full">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menu === 'view'} onClick={() => setMenu(menu === 'view' ? null : 'view')} className={title}>View</button>
          {menu === 'view' ? (
            <div role="menu" aria-label="View" className="absolute left-0 top-full z-[60] min-w-[200px] rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 shadow-xl">
              {TOOLBARS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={toolbars[t.id]}
                  className={row}
                  onClick={() => toggleToolbar(t.id)}
                >
                  {/* The tick column is reserved whether or not it is ticked, so the labels line up
                      however many toolbars are on — the same reason the chart menu reserves one. */}
                  <span aria-hidden className="w-2.5 shrink-0 text-[var(--mt5-blue)]">{toolbars[t.id] ? '✓' : ''}</span>
                  <span className="flex-1">{t.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/*
          Insert. The one branch MetaQuotes records is `Insert → Objects →`, with its eight
          categories in exactly this order and all 44 objects under them (docs/mt5/03-chart-ui.md
          111-122). That tree is already built, and this opens it: the chart's own Objects button
          says so in its comment — "it opens the Insert > Objects tree". Listing the 44 again here
          would be a second tree that could disagree with the first about which seven are disabled.

          `Insert → Indicators` is not drawn. MetaTrader has one; MetaQuotes' pages record the
          objects branch only, and the indicator list this terminal does have is reached from the
          Standard toolbar's own confirmed `Indicators` button beneath.
        */}
        <div className="relative h-full">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menu === 'insert'} onClick={() => setMenu(menu === 'insert' ? null : 'insert')} className={title}>Insert</button>
          {menu === 'insert' ? (
            <div role="menu" aria-label="Insert" className="absolute left-0 top-full z-[60] min-w-[200px] rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 shadow-xl">
              <button type="button" role="menuitem" className={row} onClick={() => { setMenu(null); clickTerminalControl('Objects'); }}>
                <span className="flex-1">Objects</span>
                <span aria-hidden className="shrink-0 text-[var(--mt5-muted)]">▸</span>
              </button>
            </div>
          ) : null}
        </div>

        {/*
          Charts. This title draws nothing of its own.

          MetaQuotes, on this menu and the chart's context menu: "Commands in these menus are
          identical (except for 'Save As Picture' and 'Delete Indicators Window' that are available
          only in the context menu)" (docs/mt5/08-chart-properties.md 554-556). The context menu is
          built, it is pruned to what this platform can honour, and every row of it calls the handler
          the ⚙ Tools menu, the rail or the Properties dialog already calls. So the faithful Charts
          menu is that menu, opened under this title instead of at a right click.
        */}
        {/* Wrapped like the three above it so all four titles sit on one baseline: the others are
            positioning contexts for their dropdowns, and a bare flex child centred differently. */}
        <div className="relative h-full">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            className={title}
            onClick={(e) => {
              setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              openChartMenu({ x: r.left, y: r.bottom });
            }}
          >
            Charts
          </button>
        </div>
      </div>

      {/* ── the toolbars ─────────────────────────────────────────────────────────────────────── */}
      {toolbars.standard || toolbars.lineStudies || toolbars.periodicity ? (
        <div className="flex h-[28px] items-center px-1">
          {toolbars.standard ? (
            <div role="toolbar" aria-label="Standard" aria-orientation="horizontal" className="flex shrink-0 items-center gap-0.5">
              {STANDARD.map((b) => <ToolbarButton key={b.label} b={b} />)}
            </div>
          ) : null}
          {toolbars.standard && (toolbars.lineStudies || toolbars.periodicity) ? grip : null}

          {toolbars.lineStudies ? (
            <div role="toolbar" aria-label="Line Studies" aria-orientation="horizontal" className="flex shrink-0 items-center gap-0.5">
              {LINE_STUDIES.map((b) => <ToolbarButton key={b.label} b={b} />)}
            </div>
          ) : null}
          {toolbars.lineStudies && toolbars.periodicity ? grip : null}

          {/*
            Periodicity. All 21 of MetaTrader's periods, because which subset its toolbar shows by
            default is one of the ten things docs/mt5/03-chart-ui.md 187-199 lists as NOT verified:
            "Which timeframe buttons are shown by default." Choosing a subset would be inventing one.

            The row scrolls rather than wrapping, so the band keeps one height at every width and the
            chart keeps the rest — the same thing the chart's own period strip does, for the same
            reason.
          */}
          {toolbars.periodicity ? (
            <div
              role="toolbar"
              aria-label="Periodicity"
              aria-orientation="horizontal"
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {TIMEFRAME_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => chooseTf(k)}
                  aria-pressed={activeTf === k}
                  className={cn(
                    'h-5 shrink-0 rounded-sm px-1.5 text-[10px] font-semibold leading-none transition',
                    activeTf === k ? 'bg-[var(--mt5-border)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

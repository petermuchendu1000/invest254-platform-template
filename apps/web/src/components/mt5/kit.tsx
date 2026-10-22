'use client';

import Link from 'next/link';
import { useNavDrawer } from '@/lib/ui/drawer';
import { MT5Back } from '@/components/mt5/MT5Back';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';
import { cn } from '@/lib/cn';

/**
 * The pieces every MetaTrader screen off the trade surface is built from.
 *
 * History, Settings and Funds each need the same three things — a title bar flush under the app bar,
 * a figure summary with MetaTrader's dotted leader, and a two-line list row. They were written twice
 * before this file existed; a third copy is where a set of screens stops looking like one product,
 * so they live here once.
 *
 * Colours are the sampled MT5 dark theme (lib/ui/mt5.ts), written as literals because Tailwind needs
 * them at build time.
 */

/**
 * MetaTrader's title bar: the screen name, optionally over a second line, with the screen's own
 * controls on the right. Sticky under the app bar on a wide window, and AT THE TOP on a phone,
 * where it is the app's only bar.
 *
 * MetaTrader's phone has ONE bar across the top and the hamburger lives IN it:
 * *"Top bar is `☰ | Quotes | ＋ | ✎`"* and *"Android: `☰` | title "Trade" … | sort button (↑↓) |
 * new-order button"* (docs/mt5/04-mobile-app.md sections 2 and 4). So below `lg` this bar carries
 * the drawer hamburger and `TopBar` stands down — three stacked blue bands was the app's bar, this
 * one and the account panel's header all competing to be the navigation.
 *
 * Above `lg` the app's own title bar is on screen with its own hamburger, so this one draws none.
 */
export function MT5TitleBar({
  title, subtitle, actions, children, embedded = false, back,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: React.ReactNode;
  /**
   * A way back, drawn where MetaTrader draws one: left of the title, in place of the hamburger.
   *
   * Every screen this bar titles is PUSHED from the chart, and none of them had one — the only
   * exit was to re-open the drawer and tap Trade, which is two taps to undo one and is not what
   * the back gesture on the phone does either. `true` uses the browser's own history; an object
   * overrides the handler or the fallback for a screen that was opened from a link.
   */
  back?: boolean | { onBack?: (() => void) | undefined; fallback?: string } | undefined;
  /** Tabs, which MetaTrader draws inside the bar rather than under it. */
  children?: React.ReactNode;
  /**
   * The bar is inside a scroller of its own rather than on a page that scrolls under the app bar.
   *
   * On a ROUTE the whole page scrolls beneath the app bar, so on a wide window the bar sticks that
   * bar's height down. Inside the phone shell's tab the screen has its own scroll container that
   * already starts below the app bar, and the same offset pushed the blue band down by a strip of
   * empty black on first paint — a sticky element whose natural position is above its threshold is
   * shifted to it immediately, before any scrolling happens.
   *
   * It also decides who owns the hamburger: an embedded bar never draws one, because the app bar
   * above it is still on screen with its own.
   */
  embedded?: boolean;
}) {
  const toggleDrawer = useNavDrawer((s) => s.toggle);
  /**
   * Embedded means the phone shell's own tab already sits under the app bar, so that bar is on
   * screen and this one is a band inside a view. Only a ROUTE's bar is the app's bar.
   */
  const ownsBar = !embedded;
  return (
    <div
      className={cn(
        'sticky z-20 bg-[var(--mt5-blue)]',
        // 48px is the terminal app bar's height (TopBar, `h-12`); it used to be told 56 and left a
        // 7px strip of page showing between the two bands.
        embedded ? 'top-0' : 'top-0 lg:top-12',
      )}
    >
      <div
        className={cn(
          // White, stated here and not inherited: this bar's fill is `--mt5-blue` in BOTH themes,
          // so it is the one strip on a MetaTrader screen whose foreground does not follow the
          // theme. The screen around it now paints from `--mt5-text`, and without this the title
          // went dark the moment a trader chose the light theme -- dark text on a blue bar.
          'flex items-center gap-3 pr-3 text-white',
          ownsBar ? 'pl-1 lg:pl-3' : 'pl-3',
          subtitle ? 'pb-1 pt-2' : 'py-2.5',
          // The hamburger is a 44px tap target and supplies the bar's height on a phone; the
          // desktop bar has no button in it and keeps its own padding.
          ownsBar && !subtitle && 'max-lg:py-1',
        )}
      >
        {/* The back control replaces the hamburger rather than sitting beside it: this screen was
            pushed from somewhere, so going back is what the left of the bar is for, and the drawer
            is still one swipe or one tap on the chart away. Drawn at every width, because a desktop
            window has no system back gesture at all. */}
        {back ? (
          <MT5Back
            {...(typeof back === 'object' && back.onBack ? { onBack: back.onBack } : {})}
            {...(typeof back === 'object' && back.fallback ? { fallback: back.fallback } : {})}
            className={ownsBar ? '' : '-ml-1'}
          />
        ) : ownsBar ? (
          <button
            type="button"
            onClick={toggleDrawer}
            aria-label="Open menu"
            className="grid h-10 w-10 shrink-0 place-items-center rounded text-white transition hover:bg-white/20 lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        ) : null}
        <div className="min-w-0">
          {subtitle ? <div className="text-[11px] leading-tight text-white/75">{title}</div> : null}
          <div className={cn('truncate font-semibold leading-tight', subtitle ? 'text-[15px]' : 'text-[15px]')}>
            {subtitle ?? title}
          </div>
        </div>
        {actions ? <div className="relative ml-auto flex items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A whole MetaTrader screen: its surface, with its title bar across the top.
 *
 * Every state of a terminal route needs it, not just the loaded one. Below `lg` this bar carries
 * the hamburger and is the ONLY bar on the screen, so a route that drops it while it loads — or
 * because nobody is signed in — drops the app's navigation with it and strands the screen.
 */
export function MT5Screen({ title, children, back = true }: {
  title: string;
  children: React.ReactNode;
  /**
   * A way back to where this screen was pushed from. ON by default, because every screen this
   * wraps is reached from the chart and none of them had one.
   */
  back?: boolean | { onBack?: (() => void) | undefined; fallback?: string };
}) {
  return (
    // The tokens, because what these states hold is the app's own components — a Skeleton, an
    // EmptyState with a Log in button — and on a MetaTrader screen that button is blue and square,
    // not the app's green pill.
    //
    // The foreground is `--mt5-text`, not the literal white it used to be.
    //
    // This screen's background is `--mt5-surface`: #0f1720 in dark and #ffffff in light. The
    // foreground was `text-white`, so asking for the light theme painted white text on a white
    // screen -- not a dim screen, an unreadable one -- and every label below inherits from here.
    // `--mt5-text` is the same pair the other way round (#ffffff / #0f1720), so the two move
    // together by construction and cannot come apart again.
    <div style={MT5_TOKENS} className="mt5-square flex flex-1 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      <MT5TitleBar title={title} back={back} />
      {children}
    </div>
  );
}

/**
 * A figure in MetaTrader's summary block: the label, a dotted leader, the value in blue.
 *
 * The leader is what stops the block reading as a plain table, and it is capped on a wide window —
 * stretched across a desktop it stops reading as a leader at all.
 */
export function MT5SummaryLine({ label, value, tone }: { label: string; value: string; tone?: 'bad' | undefined }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="shrink-0 text-[13px] font-semibold">{label}:</span>
      <span aria-hidden className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-[var(--mt5-border)]" />
      <span className={cn('shrink-0 font-mono text-[13px] font-semibold tabular-nums', tone === 'bad' ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-blue-link)]')}>
        {value}
      </span>
    </div>
  );
}

/** The container those figures sit in. */
export function MT5Summary({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-[var(--mt5-border)] px-3 py-2 lg:max-w-md">{children}</div>;
}

/** A group heading on a settings-style list. */
export function MT5Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="border-t border-[var(--mt5-border)] px-3 pb-1.5 pt-4 text-[12px] font-bold uppercase tracking-wide text-[var(--mt5-text)]">
        {title}
      </h2>
      <div className="border-t border-[var(--mt5-border)]">{children}</div>
    </section>
  );
}

/**
 * One list row: the label, the current state under it, and at most one thing on the right —
 * MetaTrader's checkbox, a value, or a chevron.
 *
 * The sub-label WRAPS rather than clipping. On MetaTrader's own screens it carries the setting's
 * current state, so it is the one part of the row that must not be cut short.
 */
export function MT5Row({
  label, sub, subTone, value, check, control, href, onClick, chevron, tone, disabled,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: 'ok' | 'bad' | 'neutral' | undefined;
  value?: React.ReactNode;
  check?: boolean | undefined;
  control?: React.ReactNode;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  chevron?: boolean | undefined;
  tone?: 'bad' | undefined;
  disabled?: boolean | undefined;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[15px] leading-tight', tone === 'bad' ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-text)]')}>
          {label}
        </span>
        {sub ? (
          <span
            className={cn(
              'mt-0.5 line-clamp-2 block break-words text-[13px] leading-tight',
              subTone === 'ok' ? 'text-[var(--mt5-green)]' : subTone === 'bad' ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-muted)]',
            )}
          >
            {sub}
          </span>
        ) : null}
      </span>
      {control ?? null}
      {value !== undefined && value !== null ? (
        <span className="shrink-0 font-mono text-[13px] text-[var(--mt5-blue-link)]">{value}</span>
      ) : null}
      {check !== undefined ? <MT5Check on={check} /> : null}
      {chevron ? <span aria-hidden className="shrink-0 text-[var(--mt5-muted)]">›</span> : null}
    </>
  );

  const className = cn(
    'flex w-full items-center gap-3 border-b border-[var(--mt5-border)] px-3 py-3 text-left',
    disabled && 'opacity-50',
  );

  if (href && !disabled) return <Link href={href} className={className}>{body}</Link>;
  // A row carrying its own control is not itself a button: the control would swallow its taps, and a
  // nested interactive element is invalid markup.
  if (onClick && !control) {
    return <button type="button" onClick={onClick} disabled={disabled} className={className}>{body}</button>;
  }
  return <div className={className}>{body}</div>;
}

/** MetaTrader's square checkbox: an outline when off, solid blue with a white tick when on. */
export function MT5Check({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'grid h-5 w-5 shrink-0 place-items-center rounded-[2px] border',
        on ? 'border-[var(--mt5-blue)] bg-[var(--mt5-blue)]' : 'border-[var(--mt5-muted)]',
      )}
    >
      {on ? (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l5 5 9-10" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The two-line entry MetaTrader lists a record as: what it is and when, over the size and the
 * result. Used for orders, deals, positions and balance operations.
 */
export function MT5Entry({
  title, time, detail, result, onOpen,
}: {
  title: React.ReactNode;
  time: string;
  detail: React.ReactNode;
  result: React.ReactNode;
  onOpen?: (() => void) | undefined;
}) {
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag
      {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})}
      className="flex w-full items-start gap-3 border-b border-[var(--mt5-border)] px-3 py-2 text-left"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight">{title}</div>
        <div className="mt-0.5 truncate font-mono text-[12px] leading-tight text-[var(--mt5-muted)]">{detail}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-[11px] leading-tight text-[var(--mt5-muted)]">{time}</div>
        <div className="mt-0.5 font-mono text-[12px] font-semibold leading-tight tabular-nums">{result}</div>
      </div>
    </Tag>
  );
}

/** A signed amount: MetaTrader's blue for a credit, red for a debit. */
export function MT5Amount({ cents, fmt }: { cents: number | null; fmt: (cents: number) => string }) {
  if (cents === null) return <span className="text-[var(--mt5-muted)]">-</span>;
  return <span className={cents < 0 ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-blue)]'}>{fmt(cents)}</span>;
}

export function MT5Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-10 text-center text-[13px] text-[var(--mt5-muted)]">{children}</div>;
}

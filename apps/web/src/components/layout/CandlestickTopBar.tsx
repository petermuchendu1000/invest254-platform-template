'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { useBrand } from '@/lib/brand/BrandProvider';
import { brandWordmark } from '@/lib/brand/brand';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useNavDrawer } from '@/lib/ui/drawer';
import { CIcon } from '@/components/game/candlestick/icons';
import { CandlestickAccountChip } from '@/components/candlestick-account/CandlestickModeBadge';

/**
 * The candlestick screen's header.
 *
 * It is a separate component from `TopBar` and `DigitsTopBar` for the same reason those two are
 * separate from each other: they are different headers, not one header with branches.
 *
 * WHAT THIS LAYOUT IS CORRECTING. The previous version put the balance, the account badge, Deposit,
 * Withdraw and the menu inside ONE outlined box with `gap-1` between them, beside a separate
 * pill-shaped mode badge. Four problems, all visible at a glance on a phone:
 *
 *  1. A box around a group of controls draws a second border 2px inside the header's own, so the
 *     bar read as a frame inside a frame with the controls crammed into the gap. Grouping is done
 *     with SPACE here instead — the only border left on the bar is the one under it.
 *  2. Three saturated colours competed in a 200px strip: a warn-orange mode pill, an accent-outlined
 *     Deposit and a `bg-down` RED Withdraw. Red is this product's loss colour; a withdrawal is not a
 *     loss or an error, and painting it red made the safest action on the bar look destructive.
 *     There is now exactly one filled colour on the bar — Deposit, the action it exists to offer —
 *     and one small state dot. Everything else is foreground, muted or a hairline.
 *  3. `gap-1` (4px) between tap targets on a touch screen is a mis-tap waiting to happen, and the
 *     controls were 32px tall in a 56px bar. Targets are 40px on a phone with 8px between them.
 *  4. The mode badge and the balance were separate items, which is backwards: the mode is what the
 *     balance MEANS. "Demo" beside "KSh 77.08" asks the player to join two facts that belong in one.
 *     They are one control now — see `CandlestickAccountChip`.
 *
 * Every control still routes to the surface that already exists: the deposit sheet, the withdraw
 * sheet, the auth modal and — behind the account chip — the shared Real/Demo panel. The hamburger
 * opens `CandlestickNavSheet`, this shell's own menu, NOT the terminal's `MT5Drawer`.
 */
export function CandlestickTopBar() {
  const brand = useBrand();
  const token = useSession((s) => s.token);
  const openAuth = useAuthUi((s) => s.openAuth);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const openWithdraw = useDepositUi((s) => s.openWithdraw);
  const toggleDrawer = useNavDrawer((s) => s.toggle);

  const authed = !!token;
  const needAuth = (fn: () => void) => () => (authed ? fn() : openAuth('login'));

  return (
    <header
      className={cn(
        'flex h-14 w-full shrink-0 items-center justify-between border-b border-border bg-surface',
        // The gutter grows with the viewport rather than being one cramped value everywhere. 12px
        // at 320px is the smallest edge margin that still reads as a margin.
        'gap-2 px-3 sm:gap-3 sm:px-4 md:h-16 md:gap-4 md:px-6',
      )}
    >
      {/* ── Identity ─────────────────────────────────────────────────────────────────────────
          The wordmark is the one thing here a player can still identify when it is clipped, so it
          is the child that gives way: `min-w-0` + `truncate`. Everything to its right is
          load-bearing and `shrink-0`. */}
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <Link href="/" aria-label={`${brand.name} home`} className="min-w-0 shrink">
          <Wordmark text={brandWordmark(brand)} />
        </Link>

        {/*
          DEMO, beside the wordmark, for a visitor with no account.
          Anybody can place a trade here without registering, and the money that tap spends is
          simulated — so the screen says so where the brand says its own name, which is where the
          mock puts it too. The balance itself is in the quote band below; this is the label.
        */}
        {authed ? null : (
          <span className="shrink-0 rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-warn">
            Demo
          </span>
        )}

        {/* Desktop-only section links. Both opened the drawer already; what changed is that they no
            longer hover to two DIFFERENT colours (warn and accent), which made a two-item nav look
            like two unrelated controls. */}
        <nav className="hidden items-center gap-1 lg:flex">
          <NavLink icon="top" label="Top Traders" onClick={toggleDrawer} />
          <NavLink icon="tours" label="Tournaments" onClick={toggleDrawer} />
        </nav>
      </div>

      {/* ── Account and actions ──────────────────────────────────────────────────────────────
          No enclosing box. The cluster reads as a group because it is spaced as one and separated
          from the identity block by the flex gap, which is what grouping by proximity means. */}
      <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
        {authed ? (
          <>
            {/* Mode + balance, one control, opening the shared Real/Demo panel. */}
            <CandlestickAccountChip />

            {/* THE primary action, and the only filled colour on this bar. */}
            <button
              type="button"
              onClick={() => openDeposit()}
              className={cn(
                'h-10 shrink-0 rounded-lg bg-accent px-2.5 text-[11px] font-bold uppercase tracking-wide text-accent-fg sm:px-3 sm:text-xs',
                'transition hover:brightness-110 active:brightness-95 md:h-9 md:px-4',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
              )}
            >
              Deposit
            </button>

            {/* Secondary, and deliberately quiet: it used to be a solid RED button, the same hue the
                charts use for a loss. From `sm` because a 320px bar has no room for a second verb. */}
            <button
              type="button"
              onClick={needAuth(openWithdraw)}
              className={cn(
                'hidden h-10 shrink-0 rounded-lg border border-border px-3 text-xs font-semibold uppercase tracking-wide text-muted',
                'transition hover:border-fg/30 hover:text-fg sm:block md:h-9',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
            >
              Withdraw
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => openAuth('login')}
              className={cn(
                'h-10 shrink-0 rounded-lg px-3 text-xs font-semibold text-fg transition hover:bg-fg/5 md:h-9',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => openAuth('register')}
              className={cn(
                'h-10 shrink-0 rounded-lg bg-accent px-3 text-xs font-bold text-accent-fg transition hover:brightness-110 md:h-9 md:px-4',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
              )}
            >
              Register
            </button>
          </>
        )}

        <button
          type="button"
          onClick={toggleDrawer}
          aria-label="Menu"
          className={cn(
            // Square and 40px on a phone: an icon-only control is the easiest thing on a bar to
            // mis-tap, so it gets a full target rather than the 32px it had.
            'flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-muted sm:w-10',
            'transition hover:bg-fg/5 hover:text-fg md:h-9 md:w-9',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function NavLink({ icon, label, onClick }: { icon: 'top' | 'tours'; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold uppercase tracking-wide text-muted',
        'transition hover:bg-fg/5 hover:text-fg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <CIcon name={icon} className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/**
 * The two-tone wordmark: the first word in the brand's accent, the rest in the foreground.
 *
 * The split comes from the brand's own wordmark, so every brand that wears this screen gets its own
 * name in the same lockup rather than someone else's. `tracking-tighter` is gone — at `font-black`
 * and uppercase it was pulling the letters into each other, which is most of why the bar read as
 * cramped in the first place.
 */
function Wordmark({ text }: { text: string }) {
  const i = text.indexOf(' ');
  const [a, b] = i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ''];
  return (
    <span className="block max-w-[7.5rem] truncate whitespace-nowrap text-base font-extrabold uppercase leading-none tracking-tight text-fg sm:max-w-none sm:text-lg md:text-xl">
      <span className="text-accent">{a}</span>
      {/*
        THE SECOND WORD IS DROPPED ON THE SMALLEST SCREENS, deliberately.

        At 320px the balance, Deposit and the menu need about 250 of the 320 pixels, which left the
        wordmark around 30 and rendered it as "C…" — a brand nobody can identify, which is worse
        than no wordmark at all. An ellipsis is what a layout does when it has run out of ideas; a
        short mark is a decision. So below `sm` the lockup is its FIRST word only ("CPF"), which is
        how an abbreviated brand mark is supposed to behave, and the full two-tone name returns the
        moment there is room for it. The `<Link>` still carries the full brand name as its
        accessible label, so nothing is lost to a screen reader at any width.
      */}
      {b ? <span className="hidden sm:inline">{b}</span> : null}
    </span>
  );
}

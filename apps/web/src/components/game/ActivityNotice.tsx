'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import type { BrandActivityDto } from '@/lib/api/types';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useDisplayMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { selectCards } from '@/lib/game/activityCards';

/**
 * The "someone just won" notification: a one-line ribbon, OUT of the chart.
 *
 * Shown by the CANDLESTICK and WAVE shells. Not by the broker terminal, which is MetaTrader and has
 * no social-proof surface, and not on a BASIC-skin screen, whose whole point is to remove the
 * financial tells this ribbon is made of.
 *
 * IT USED TO BE A 288x73 CARD FLOATING OVER THE CHART, and that is the bug this shape fixes.
 * Measured in Chromium against the wave shell with the feed mocked, the card covered **42.7% of
 * the whole chart at 320x568** and 30.6% at 360x640 — centred, right over the curve a player is
 * reading to choose Higher or Lower. Marketers demonstrating the app reported exactly that: the
 * notification blocks the wave. (It reached them because the basic skin is no longer pinned to the
 * marketer role — see `lib/marketer/skinPolicy` — so a marketer gets the player screen, card and
 * all.) The ribbon is ~30px, carries the same four facts, and sits outside the plot entirely.
 *
 * WHY A LANE AND NOT A BETTER CORNER. Notifications that overlap the surface the user is acting on
 * are measurably more distracting than the same notification further from the point of gaze
 * (Hueber et al., MobileHCI '23, gaze-attentive notifications), and the trade screen has exactly
 * one such surface: the curve plus the Higher/Lower buttons. The counter-pressure is banner
 * blindness — a region learned as "where the adverts go" is filtered out (Benway & Lane, 1998) —
 * so the ribbon does not get a slot of its own either. It borrows the row that already carries
 * live-looking market data and that a player already glances at, which keeps it in the upper scan
 * path without ever covering the decision.
 *
 * WHERE THE EVENTS COME FROM. The same place the Chat tab's system lines come from, and nowhere
 * else: `GET /api/v1/site/activity` (`api.siteActivity`), on the same query key, the same limit and
 * the same 20s poll as `ChatPane`. That is deliberate on two counts.
 *
 *  1. React Query dedupes it. Two components asking `['siteActivity', slug]` for 40 rows share one
 *     cache entry and one request, so this ribbon costs the screen no extra traffic — it is a second
 *     *view* of the feed the rail already holds, not a second feed.
 *  2. It inherits the server's gate for free. `activity.pg.ts` is the thing that decides what may
 *     appear here: settled deposits, paid withdrawals and winning positions, plus whatever rows the
 *     product owner seeded into `activity_seed` (0193) FOR THIS BRAND. A future reader will wonder
 *     whether something this promotional needed its own "is this brand allowed social proof?" check —
 *     it does not. A brand with no real activity and no seeds gets an empty list and this renders
 *     nothing. There is no client-side generator here, and there must never be one: every name and
 *     every figure on the ribbon below came off the wire.
 *
 * It is a notification, not a dialog, in exactly the sense `MT5CloseNotice` is one: it takes no
 * focus, it never swallows a pointer event, and the chart and the ticket stay live underneath it.
 * A ribbon that could eat a tap on Higher/Lower would cost the player a trade.
 */
export function ActivityNotice({ placement, className }: {
  /**
   * WHICH LANE this instance lives in. The two shells have nothing in common above the chart, so
   * each gets a placement rather than a pile of offset classes.
   *
   *  - `'band'` — fills its positioned parent EXACTLY (`inset-0`). The wave shell wraps the
   *    decorative ticker in a `relative` box and hands that box over: for its three seconds the
   *    ribbon simply IS that row, and the marquee returns underneath afterwards. Nothing moves,
   *    nothing is covered that carries information (`TickerStrip` is a client-side random walk and
   *    says so in its own header), and the chart gives up no pixels — which it cannot afford to:
   *    BUGLOG #129 fought the chart up to a 160px floor on a 320x568 phone and it measures 158px
   *    there today. A row that appeared and collapsed every few seconds would be worse than the
   *    overlap it replaced, because `CurveCanvas` has a `ResizeObserver` on its canvas and would
   *    rescale the wave on every cycle.
   *  - `'ribbon'` — hangs from the bottom edge of the quote band, flush, at the top-left of the
   *    chart pane. The candlestick shell has no marquee to borrow, and its chart has no dead space
   *    either: the bars are right-aligned and fill the pane edge to edge. The top band is the
   *    nearest thing to empty — `CandlestickTape` sets `scaleMargins.top: 0.12`, so the top 12% of
   *    the plot holds no candle body or wick at any zoom, only grid lines — and the left of it is
   *    the oldest bars, the part of a chart nobody is reading. A right gutter keeps the ribbon off
   *    the price axis, and it stops well short of the live edge on the right, which is the part
   *    they ARE reading.
   *
   * REQUIRED, with no default. A default would let a new shell mount this and silently inherit a
   * lane built for a screen it is not — which is the whole class of mistake that put it over the
   * chart in the first place. Picking one forces a reading of the two notes above.
   */
  placement: Placement;
  /**
   * Extra classes for the live region. ADDITIVE only — `cn` is a plain join with no
   * tailwind-merge, so anything that collides with a placement's own utilities would be decided by
   * stylesheet order rather than by this argument. The candlestick shell uses it to hide the
   * ribbon on a phone that has navigated off the trade tab, WITHOUT unmounting it: unmounting
   * would drop the queue and the `seen` set, and every event already shown would come round again
   * on the next poll.
   */
  className?: string;
}) {
  const brand = useBrand();

  /**
   * Same key/limit/intervals as `ChatPane`'s query — see the note above. If either side changes
   * these, the two stop sharing a cache entry and the screen quietly starts polling twice.
   */
  const { data: activity } = useQuery({
    queryKey: ['siteActivity', brand.slug],
    queryFn: () => api.siteActivity(brand.slug, 40),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  const items = activity?.items ?? [];

  const [queue, setQueue] = useState<BrandActivityDto[]>([]);
  const [current, setCurrent] = useState<BrandActivityDto | null>(null);
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(0);
  // Keys of every item already queued, so a row that is still in the server's 40-row window on the
  // next poll is not surfaced again. `seen` is state rather than a ref only because the enqueue
  // effect has to read and write it in the same pass.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The names the last few cards carried. A ref, not state: it is read and written inside the
   * enqueue effect and must not retrigger it.
   */
  const lastNamesRef = useRef<string[]>([]);

  // ── What gets queued ────────────────────────────────────────────────────────
  useEffect(() => {
    if (items.length === 0) return;

    /**
     * A few at a time, drawn at random, every poll.
     *
     * The window holds forty rows and firing forty cards at someone who just opened the screen is
     * the behaviour this component would be most hated for — so the batch is capped rather than the
     * first load being special-cased. That cap replaces the old `primed` flag entirely: with every
     * batch bounded there is no "first load" to distinguish, and one fewer piece of state to keep
     * in step with the queue.
     *
     * The rules themselves — the shuffle, one card per trader, what counts as seen — live in
     * `lib/game/activityCards` and are unit-tested there. They used to be written inline here,
     * which is how a comment asserting the wrong feed order survived long enough to put the same
     * trader's fortnight-old wins on every card.
     */
    const { take, seenKeys } = selectCards(items, seen, lastNamesRef.current, MAX_PER_BATCH);
    if (take.length === 0) return;

    setSeen((prev) => {
      const next = new Set(prev);
      for (const k of seenKeys) next.add(k);
      return next;
    });
    // Remembered across batches, so one trader cannot open consecutive cards 20s apart either.
    lastNamesRef.current = [...lastNamesRef.current, ...take.map((t) => t.name.trim().toLowerCase())]
      .slice(-RECENT_NAME_MEMORY);
    setQueue((q) => [...q, ...take]);
  }, [items, seen]);

  /**
   * ── Take the next card off the queue ──────────────────────────────────────
   *
   * Nothing but bookkeeping happens here. The TIMERS deliberately live in their own effect below,
   * and splitting the two is a bug fix rather than tidying:
   *
   * this effect writes `current` and `queue`, which were also its own dependencies. So React tore
   * the effect down the instant it ran — running the cleanup, which cleared the hide and drop
   * timeouts — and re-ran it, where `if (current)` now returned early and armed nothing. The card
   * was shown and then never hidden: measured in a real browser, it sat at `opacity: 1` for every
   * sample across twelve seconds, which is what "it should only last a few seconds" was describing.
   * `SHOW_MS` had nothing to do with it; no value of it would have helped.
   */
  useEffect(() => {
    if (current || queue.length === 0) return;
    setCurrent(queue[0]!);
    setQueue((q) => q.slice(1));
    setShown((n) => n + 1);
  }, [current, queue]);

  /**
   * ── The life of the card that is up ───────────────────────────────────────
   *
   * Keyed on `current` ALONE, which changes exactly twice per card (null → card → null), so the
   * timers below are armed once and survive every other render. That is the whole fix.
   */
  useEffect(() => {
    if (!current) return;
    // Painted hidden for one frame so the transition has a state to move FROM; under
    // `prefers-reduced-motion` the transition is off and this frame is simply invisible.
    const raf = requestAnimationFrame(() => setVisible(true));
    const hide = setTimeout(() => setVisible(false), SHOW_MS);
    // Dropped only after the exit has run, plus a gap — back-to-back cards with no gap read as one
    // card flickering rather than as two separate events.
    const drop = setTimeout(() => { setVisible(false); setCurrent(null); }, SHOW_MS + EXIT_MS + GAP_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
      clearTimeout(drop);
    };
  }, [current]);

  if (!current) return null;

  /**
   * A screen reader hears the first few and then nothing. The ribbon is ambient social proof: a
   * polite live region that re-announces every eight seconds for as long as the player keeps the
   * screen open is not information, it is an obstruction, and there is nothing here the player
   * needs — the rail's Chat tab carries the same rows as readable text. After the cap it is
   * `aria-hidden` and purely decorative.
   */
  const announce = shown <= MAX_ANNOUNCEMENTS;

  return (
    <div
      /**
       * `absolute`, against whatever positioned ancestor the placement names — never `fixed`.
       *
       * `'band'` fills the wave shell's ticker wrapper. `'ribbon'` is measured from the top of
       * `AppShell`'s `<main>`, which on the candlestick screen starts at the quote band: 40px of it
       * on a phone (`QuoteBar compact`, `h-10`) and 64px on a desktop (`h-16`). Those two numbers
       * are the only arithmetic here, they are the quote band's own fixed heights, and the e2e
       * asserts the ribbon lands flush under it at five viewports.
       */
      data-testid="activity-notice"
      className={cn('pointer-events-none z-30 flex', POSITION[placement], className)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        aria-hidden={announce ? undefined : true}
        className={cn(
          'flex min-w-0 items-center gap-2 border-border bg-surface px-3 text-[11px] leading-none',
          'shadow-[0_6px_18px_rgba(0,0,0,0.45)]',
          // Never `pointer-events-auto`, unlike MT5CloseNotice: this ribbon has nothing to press, so
          // it has no reason to be in the way. It dismisses itself.
          'transition-all duration-300 ease-out motion-reduce:transition-none',
          SHAPE[placement],
          visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        )}
      >
        <Coin className="h-3.5 w-3.5 text-warn" />

        {/* `min-w-0` is what lets a long handle actually truncate: a flex child's default
            `min-width: auto` refuses to shrink below its text, so `truncate` alone does nothing
            here and the amount would be pushed out of the ribbon instead. */}
        <span className="min-w-0 shrink truncate font-semibold text-fg">{current.name}</span>
        <span className="shrink-0 text-muted">{VERB[current.kind]}</span>
        {/* The figure never truncates and never wraps — it is the one thing on the ribbon that
            would be a lie in part. */}
        <span className="shrink-0 whitespace-nowrap font-bold tabular-nums text-up">
          <Amount cents={current.amountCents} />
        </span>

        {/*
          The proof, and the ONE part of the ribbon that is allowed to lose words.
        
          `PROOF` is a factual claim per kind, not decoration — a settled trade credited a balance,
          a withdrawal was paid — so what survives a squeeze matters. Three things rank it:
        
            · The TICK is `shrink-0` and unconditional. It is 10px and it is the trust mark.
            · The WORDS appear from `xs` (360px) and truncate from the END, so the head of the
              claim — "Settled trade", "Verified withdrawal", "Confirmed deposit", the part that
              distinguishes one kind from another — is the last thing to go. Below 360px there is
              no room for any of it and the tick carries it alone.
            · `shrink-[6]` makes this group give way six times faster than the handle beside it, so
              a long name costs the proof its tail rather than the proof costing the name its
              identity. The amount is `shrink-0` and never pays at all.
        */}
        <span className="ml-auto flex min-w-0 shrink-[6] items-center gap-1 pl-1 text-muted">
          <Check className="h-2.5 w-2.5 text-accent" />
          <span className="hidden truncate xs:block">{PROOF[current.kind]}</span>
        </span>
      </div>
    </div>
  );
}

/** @see the `placement` prop. */
export type Placement = 'band' | 'ribbon';

/** Where the live region sits. Keyed by placement so the two shells share no offsets. */
const POSITION: Record<Placement, string> = {
  // Exactly the ticker row the wave shell hands over, so there is nothing to measure.
  band: 'absolute inset-0',
  // Flush under the candlestick quote band (h-10 phone / h-16 desktop), with a gutter on the right
  // that clears the chart's price axis.
  ribbon: 'absolute inset-x-0 top-10 pr-12 md:top-16 md:pr-16',
};

/** The ribbon's own box. Keyed by placement because one fills a row and the other hangs off a bar. */
const SHAPE: Record<Placement, string> = {
  // The row's height, and the row's own corners — `TickerStrip` is `rounded-xl border`.
  band: 'h-full w-full rounded-xl border',
  // A tab hanging off the quote band: no top edge, rounded only where it leaves the bar. `w-fit`
  // so it covers its own text and not a pixel more, capped so a long handle on a wide pane can
  // never run it out towards the live edge on the right.
  ribbon: 'h-7 w-fit max-w-[26rem] rounded-br-xl border-b border-r',
};

/** The amount in the brand's own wallet formatter, so a foreign or marketer brand is not told KES. */
function Amount({ cents }: { cents: number }) {
  const { fmt } = useDisplayMoney();
  return <>+{fmt(cents)}</>;
}

/** The first line's verb. */
const VERB: Record<BrandActivityDto['kind'], string> = {
  win: 'won',
  withdrawal: 'withdrew',
  deposit: 'deposited',
};

/**
 * The third line, and the one thing on this card that could become a lie.
 *
 * The mock prints "Verified withdrawal · Mpesa Cash" under every row, including the wins. That is
 * two separate inventions: a won trade is not a withdrawal, and a won trade has not been paid out
 * to anything — it credited a trading balance that the player still has to withdraw. So the label
 * is derived from `kind` and says only what that kind supports.
 *
 * The rail is named "M-Pesa", which is the codebase's own wording and not a borrowed brand: the
 * server labels every STK rail that way regardless of which gateway moved the money, and the
 * gateway's own brand is never shown to a player (docs/35, `DepositPanel`). "Mpesa Cash" is the
 * mock's product, not a thing this one has.
 */
const PROOF: Record<BrandActivityDto['kind'], string> = {
  win: 'Settled trade · Paid to balance',
  withdrawal: 'Verified withdrawal · M-Pesa',
  deposit: 'Confirmed deposit · M-Pesa',
};

/**
 * How many cards one poll may queue.
 *
 * Every batch is bounded, not just the first: at two per 20s poll the stream is continuous without
 * ever being a wall of cards, and there is no first-load special case to maintain.
 */
const MAX_PER_BATCH = 2;
/** How many cards a screen reader hears before the region goes quiet. */
const MAX_ANNOUNCEMENTS = 3;
/**
 * Three seconds on screen, as specified.
 *
 * It is enough to read a name and a figure — which is all the card carries — and short enough that
 * a card arriving while the player is choosing a stake is gone before it becomes an irritation.
 * The exit is excluded: `EXIT_MS` runs after this, so the card is legible for the full three.
 */
/** How many recently-shown traders are remembered when enforcing one card each. */
const RECENT_NAME_MEMORY = 4;
const SHOW_MS = 3_000;
const EXIT_MS = 300;
const GAP_MS = 2_500;

/* The two glyphs the ribbon needs. Inline rather than in `icons.tsx`, which is the tab-bar set and
   draws to a different weight; these are solid marks at 10–14px. */

function Coin({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('shrink-0', className)} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2a3 3 0 0 0-2.5-1.2c-1.5 0-2.5.8-2.5 1.9 0 1.2 1 1.7 2.5 2s2.6.8 2.6 2.1-1.1 2-2.6 2a3 3 0 0 1-2.6-1.3M12 6.3v1.7M12 16v1.7" />
    </svg>
  );
}

function Check({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('shrink-0', className)} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12.5 5.5 5.5L20 6" />
    </svg>
  );
}


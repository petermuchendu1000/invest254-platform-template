'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  swipeAxis, swipeOutcome, swipeOffset, barWidthOf,
} from '@/lib/game/swipe';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's swipe-left quick commands, the gesture every list row on its phone has.
 *
 * Android, on a Trade row: "a BLUE BAR slides over the row's right side with 6 white icons", in a
 * documented order (docs/mt5/04-mobile-app.md section 4). iOS has three on a Trade row and two on a
 * Quotes row, and adds one thing Android's help does not: "By dragging the menu further to the
 * left, you can immediately switch to [the last command's] screen." Both halves are here: the bar
 * opens at the first threshold and the final command fires on its own at the second.
 *
 * ── Why a primitive and not two copies ───────────────────────────────────────────────────────────
 * The gesture is identical on Quotes rows, Trade rows and History rows; only the icons differ. Hand
 * it the commands and it is the same bar everywhere, which is what MetaTrader's is.
 *
 * ── The gesture, and the four things that break it ───────────────────────────────────────────────
 *
 * 1. A list scrolls vertically. `touch-action: pan-y` gives the browser the vertical axis and keeps
 *    the horizontal one, so a swipe down the list is never stolen by a row, and the row's own drag
 *    never fights the scroll.
 * 2. The axis is decided ONCE, on the first few pixels of movement, and then held. Deciding it per
 *    move made a diagonal flick jitter between scrolling the list and dragging the row.
 * 3. The drag is tracked in refs, not state. A fast flick emits its moves before React has
 *    re-rendered from the `pointerdown`, so a handler reading state sees nothing and the flick is
 *    silently dropped: on a touch screen that is most swipes.
 * 4. A swipe must not also be a tap. The row underneath is a button that opens the context menu, so
 *    a click that follows any real movement is swallowed in the capture phase, and while the bar is
 *    open a tap on the row closes it rather than reaching through.
 */

export interface SwipeCommand {
  /** MetaTrader's own name for the command, which is the icon's accessible label. */
  label: string;
  icon: ReactNode;
  onPick?: (() => void) | undefined;
  /** Why this engine cannot do it. Present means the icon is dimmed and says so, not hidden. */
  unavailable?: string | undefined;
}

export function MT5SwipeRow({ commands, label, children }: {
  commands: readonly SwipeCommand[];
  /** What this row is, for the bar's accessible name. */
  label: string;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  /** The live gesture: where it started, which axis it took, and how far it has gone. */
  const drag = useRef<null | { x: number; y: number; axis: null | 'x' | 'y'; dx: number }>(null);
  /** Set when a gesture moved enough to be a drag, so the click it ends with is not a tap. */
  const swiped = useRef(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /** The bar's width, so the row slides exactly as far as there are icons to reveal. */
  const barW = barWidthOf(commands.length);

  // A bar left open on one row while another is swiped would leave two open at once, which
  // MetaTrader never shows. A pointer down anywhere outside this row closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) { setOpen(false); setOffset(0); }
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const shortcut = commands[commands.length - 1];

  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d === null || d.axis !== 'x') return;
    const outcome = swipeOutcome(d.dx, barW);
    // MetaTrader's own shortcut: dragged far enough, the last command runs and the bar never opens.
    if (outcome === 'shortcut' && shortcut !== undefined && shortcut.unavailable === undefined) {
      setOpen(false);
      setOffset(0);
      shortcut.onPick?.();
      return;
    }
    setOpen(outcome === 'open');
    setOffset(outcome === 'open' ? barW : 0);
  };

  return (
    <div ref={hostRef} className="relative overflow-hidden">
      {/* The bar MetaTrader slides over the row's right side. It sits UNDER the row and is revealed
          by the row moving, rather than sliding in over it, so the two cannot disagree about how
          much of it is showing. */}
      <div
        role="group"
        aria-label={`${label} quick commands`}
        aria-hidden={!open}
        className="absolute inset-y-0 right-0 flex items-stretch bg-[var(--mt5-blue)]"
        style={{ width: barW, pointerEvents: open ? 'auto' : 'none' }}
      >
        {commands.map((c) => (
          <button
            key={c.label}
            type="button"
            data-swipe-command={c.label}
            /* No `data-compact` here, deliberately: the app's 44px minimum tap target applies, and
               closing a position is exactly the kind of control it exists for. The icon is 48px
               wide and stretches to the row's height, so the floor is already cleared and the rule
               is left in place as the safety net. */
            disabled={c.unavailable !== undefined}
            title={c.unavailable}
            aria-label={c.label}
            tabIndex={open ? 0 : -1}
            onClick={() => { setOpen(false); setOffset(0); c.onPick?.(); }}
            className={cn(
              'grid w-12 place-items-center text-white transition',
              c.unavailable === undefined ? 'active:bg-[#1f68d8]' : 'cursor-not-allowed opacity-45',
            )}
          >
            {c.icon}
          </button>
        ))}
      </div>

      <div
        /**
         * The row itself, slid left by however much of the bar is showing.
         *
         * `pan-y` hands the browser the vertical axis: the list still scrolls through this row, and
         * only the horizontal gesture is the row's own.
         */
        className="relative touch-pan-y bg-[var(--mt5-surface)]"
        style={{
          transform: `translateX(${-offset}px)`,
          transition: drag.current === null ? 'transform 160ms ease-out' : 'none',
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          swiped.current = false;
          drag.current = { x: e.clientX, y: e.clientY, axis: null, dx: 0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          // The axis is chosen once and held. Re-deciding it on every move made a diagonal flick
          // alternate between scrolling the list and dragging the row, and do neither.
          if (d.axis === null) {
            const axis = swipeAxis(dx, dy);
            if (axis === null) return;
            d.axis = axis;
            /**
             * Captured only now that this IS a horizontal drag.
             *
             * The capture keeps the moves arriving here once the row has slid out from under the
             * finger, without which a long drag stops being reported and MetaTrader's
             * drag-further-left shortcut can never be reached. It is taken late because a captured
             * pointer retargets the CLICK to the capturing element as well: captured on
             * `pointerdown`, an ordinary tap never reached the row's own button, and tapping a
             * Quotes row stopped opening its context menu altogether.
             */
            if (axis === 'x') e.currentTarget.setPointerCapture(e.pointerId);
          }
          if (d.axis !== 'x') return;
          swiped.current = true;
          d.dx = dx;
          // Left only, and it may be dragged past the bar for MetaTrader's shortcut.
          setOffset(swipeOffset(dx, barW));
        }}
        onPointerUp={end}
        onPointerCancel={() => { drag.current = null; setOffset(open ? barW : 0); }}
        /**
         * A swipe is not a tap, and an open bar is not a row.
         *
         * The child is a button that opens the context menu. Without this, every swipe ended by
         * opening that menu over the bar it had just revealed, and a tap meant to dismiss the bar
         * opened the menu instead.
         */
        onClickCapture={(e) => {
          if (swiped.current) { e.preventDefault(); e.stopPropagation(); swiped.current = false; return; }
          if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setOffset(0); }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The icons, drawn rather than typed.
 *
 * Every glyph in this phone chrome is an SVG, because a Unicode symbol an Android system font is
 * missing comes out as an empty box, and a trading control that renders as a box is unusable. The
 * phone probe asserts no control carries one of those code points as text.
 */
const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'h-[18px] w-[18px]',
  'aria-hidden': true,
};

/** Close: MetaTrader's cross. */
export const SwipeCloseIcon = <svg {...stroke}><path d="M6 6l12 12M18 6L6 18" /></svg>;
/** Edit / modify: its pencil. */
export const SwipeEditIcon = <svg {...stroke}><path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4z" /></svg>;
/** Increase / place: its plus. */
export const SwipePlusIcon = <svg {...stroke}><path d="M12 5v14M5 12h14" /></svg>;
/** Chart: a candle pair, which is what MetaTrader's chart icon is. */
export const SwipeChartIcon = (
  <svg {...stroke}>
    <path d="M8 4v16M8 8h-3v7h3M16 4v16M16 7h3v9h-3" />
  </svg>
);
/** Depth of Market: its stacked book of bids and asks. */
export const SwipeDepthIcon = (
  <svg {...stroke}>
    <path d="M4 7h10M4 12h16M4 17h7" />
  </svg>
);
/** The context menu, which is iOS's first swipe icon. */
export const SwipeMoreIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);

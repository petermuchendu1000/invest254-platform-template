'use client';

import { useRef, useState } from 'react';
import type { Projection } from '@/components/game/ChartDrawings';
import { useDisplayMoney } from '@/lib/money';
import {
  pointsOfPrice, priceOfPoints, applyRatioLock, type Levels,
} from '@/lib/game/levels';
import { useLevelsStore } from '@/lib/game/levelsStore';
import { isContinuousBrand } from '@/lib/game/levelWatch';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { useBrand } from '@/lib/brand/BrandProvider';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Stop Loss and Take Profit, drawn on the chart and dragged there.
 *
 * Row 13 of its advanced trading dialog: "The live chart below, with draggable TP (green dashed +
 * green tag), SL (orange/red dashed + tag), and bid/ask price tags" — and from the chart screen,
 * "Tap 'SL' / 'TP' then drag those levels; as you drag, potential P/L shows in points and in
 * money" (docs/mt5/04-mobile-app.md sections 3 and 5b).
 *
 * The levels are the SAME ones the dialog sets: both read `useLevelsStore`, so dragging the line
 * moves the dialog's figure and stepping the dialog's figure moves the line. MetaTrader's ratio
 * lock applies here too — its own wording is that the lock holds "including while dragging on the
 * chart".
 *
 * ── Colours ──────────────────────────────────────────────────────────────────────────────────────
 * The dialog's measured chips, not a second pair: these lines and those chips are two views of one
 * level, and a trader must not have to work out that the orange rule on the ticket, the red chip in
 * the dialog and a third colour on the chart all mean the stop. MetaQuotes describes the on-chart
 * stop as "orange/red" without publishing a value, so the measured chip hex is the better source.
 *
 * ── What the money figure says ───────────────────────────────────────────────────────────────────
 * MetaTrader shows the potential P/L of the level being dragged. The distance in POINTS is real and
 * is shown; the money depends on how the brand is priced.
 *
 * On a CONTINUOUS brand the engine closes the position at the level, for what it is worth there, so
 * the figure does follow from the distance — but it follows through a gain and a break-even cost the
 * engine does not publish to the client, so no figure is printed rather than an invented one. On a
 * committed contract the payout is a multiplier assigned at open that no level determines, so the
 * stop shows the stake, which is exactly what it risks, and the target says it varies. The dialog's
 * own notes carry the same distinction.
 */
export const LEVEL_COLOUR = { sl: '#DD5B4E', tp: '#0EB52E' } as const;

export function MT5ChartLevels({ project, width, height, digits, price, stakeCents }: {
  project: Projection;
  width: number;
  height: number;
  digits: number;
  /** The live price, which the levels are measured from. Null before the first quote. */
  price: number | null;
  /** What this contract risks, which is what the stop's money figure is. */
  stakeCents: number;
}) {
  const money = useDisplayMoney();
  const brand = useBrand();
  const { earlyCloseEnabled } = useGameSocket();
  /** Whether the engine will act on these levels at all. See lib/game/levelWatch.ts. */
  const continuous = isContinuousBrand({ chartStyle: brand.chartStyle, earlyCloseEnabled });
  const levels = useLevelsStore((s) => s.levels);
  const setLevels = useLevelsStore((s) => s.set);
  const levelRef = useLevelsStore((s) => s.ref);
  const locked = useLevelsStore((s) => s.locked);
  /**
   * Which level the finger has hold of.
   *
   * A REF decides it and the state only draws the highlight, because a pointer that moves fast
   * emits its moves before React has re-rendered from the `pointerdown`. Reading the state in the
   * move handler meant every one of those early moves saw `null` and did nothing: a slow drag
   * worked and a flick was silently ignored, which on a touch screen is most of them.
   */
  const draggingRef = useRef<null | 'sl' | 'tp'>(null);
  const [dragging, setDragging] = useState<null | 'sl' | 'tp'>(null);
  /** The plot's own box, so a pointer's page coordinate becomes a chart coordinate. */
  const hostRef = useRef<HTMLDivElement | null>(null);

  if (price === null || width === 0 || height === 0) return null;
  if (levels.slPoints === null && levels.tpPoints === null) return null;
  // The anchor the distances are measured from, so a line stays on the price it was dragged to
  // instead of sliding with the market. See levelsStore.
  const ref = levelRef ?? price;

  const onDrag = (field: 'sl' | 'tp', clientY: number) => {
    const box = hostRef.current?.getBoundingClientRect();
    if (!box) return;
    const next = project.priceOf(clientY - box.top);
    if (next === null || !Number.isFinite(next)) return;
    const points = pointsOfPrice(ref, next, digits);
    // A level dragged onto the price is not a level; it would also make the pair shapeless and
    // kill both trade buttons, which is a confusing thing to happen under a finger.
    if (points === 0) return;
    const moved: Levels = field === 'sl' ? { ...levels, slPoints: points } : { ...levels, tpPoints: points };
    // "A lock button fixes the TP:SL ratio — adjust one and the other follows, INCLUDING WHILE
    // DRAGGING ON THE CHART."
    setLevels(locked ? applyRatioLock(levels, moved, field) : moved, ref);
  };

  /**
   * Where each level sits, and where its TAG sits, which are not always the same.
   *
   * The dashed rule is always on the exact price. The tag is 44px tall — this app's minimum tap
   * target, which is right on a control that moves money — so two levels closer together than that
   * produce tags that overlap, and the one drawn second swallows the other's taps entirely. A
   * trader with a tight stop and target simply could not grab the lower one.
   *
   * So when they would collide the tags are pushed apart around their midpoint, the lower one down
   * and the upper one up, by just enough to clear. The rules do not move, so the levels still read
   * at exactly the prices they are set to.
   */
  const TAG_H = 46;

  /**
   * The grab, shared by the tag and by the rule itself.
   *
   * MetaTrader does not make you hit the little label: "drag the SL/TP line (Drag'n'Drop)"
   * (docs/mt5/01-order-and-close-dialogs.md section 3.5). The line IS the handle, so both the tag
   * and the strip over the rule start the same drag.
   */
  const grab = (field: 'sl' | 'tp') => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();
      // The plot underneath is lightweight-charts' own pan and pinch surface. Capture plus
      // `touch-none` keeps the whole gesture here, so a finger that starts on a level drags the
      // level rather than scrolling the chart out from under it.
      e.preventDefault();
      draggingRef.current = field;
      setDragging(field);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (draggingRef.current !== field) return;
      e.stopPropagation();
      onDrag(field, e.clientY);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      draggingRef.current = null;
      setDragging(null);
    },
    onPointerCancel: () => { draggingRef.current = null; setDragging(null); },
  });
  const yOfLevel = (points: number | null): number | null => {
    if (points === null) return null;
    const y = project.yOf(priceOfPoints(ref, points, digits));
    // Off-scale: MetaTrader's level simply is not on screen, rather than pinned to the edge where
    // it would read as a level at a price it is not at.
    return y === null || y < 0 || y > height ? null : y;
  };
  const ySl = yOfLevel(levels.slPoints);
  const yTp = yOfLevel(levels.tpPoints);
  const nudge = { sl: 0, tp: 0 };
  if (ySl !== null && yTp !== null && Math.abs(ySl - yTp) < TAG_H) {
    const push = (TAG_H - Math.abs(ySl - yTp)) / 2;
    const slLower = ySl > yTp;
    nudge.sl = slLower ? push : -push;
    nudge.tp = slLower ? -push : push;
  }

  const line = (field: 'sl' | 'tp', points: number | null) => {
    if (points === null) return null;
    const at = priceOfPoints(ref, points, digits);
    const y = field === 'sl' ? ySl : yTp;
    if (y === null) return null;
    const colour = LEVEL_COLOUR[field];
    const live = dragging === field;
    return (
      <div key={field} className="pointer-events-none absolute inset-x-0" style={{ top: y }}>
        {/* The dashed rule. */}
        <div
          aria-hidden
          className="absolute inset-x-0"
          style={{
            top: -1,
            height: 0,
            borderTop: `1px dashed ${colour}`,
            opacity: live ? 1 : 0.85,
          }}
        />
        {/*
          * The rule itself is a handle, 24px of it.
          *
          * MetaTrader modifies a level by Drag'n'Drop ON THE LINE, and on the phone by "Tap 'SL' /
          * 'TP' then drag those levels" (docs/mt5/01-… 3.5, docs/mt5/04-mobile-app.md section 3).
          * A 1px rule is not something a mouse can hit and not something a finger can hit at all,
          * so the drag gets a band around it the way MetaTrader's own hit tolerance does. It is
          * transparent and only 24px, so it never hides a candle and leaves the rest of the plot to
          * the chart's pan and pinch.
          */}
        <div
          aria-hidden
          data-chart-level-line={field}
          {...grab(field)}
          className="pointer-events-auto absolute inset-x-0 h-6 -translate-y-1/2 cursor-ns-resize touch-none"
          style={{ top: 0 }}
        />
        {/* MetaTrader's tag, on the price axis side, carrying the level and its label.
            The button is 44px tall so a finger and a mouse have something to take hold of; the
            coloured pill inside keeps MetaTrader's own slim label, which is what a trader reads.
            Sized here rather than left to the global 44px tap-target rule, because that rule only
            exists under `@media (pointer: coarse)` and a desktop mouse got a 14px target. */}
        <button
          type="button"
          data-chart-level={field}
          aria-label={`${field === 'sl' ? 'Stop loss' : 'Take profit'} at ${at.toFixed(digits)}, drag to move`}
          {...grab(field)}
          className="pointer-events-auto absolute right-0 flex h-11 -translate-y-1/2 cursor-ns-resize touch-none items-center justify-end bg-transparent"
          style={{ top: nudge[field] }}
        >
          <span
            className={cn(
              'rounded-l px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-white tabular-nums',
              live && 'ring-2 ring-white/60',
            )}
            style={{ background: colour }}
          >
            {field.toUpperCase()} {at.toFixed(digits)}
          </span>
        </button>
        {/* While dragging, MetaTrader shows the potential result in points and in money. */}
        {live ? (
          <span
            className="pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-[var(--mt5-surface)]/90 px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--mt5-text)] tabular-nums"
            style={{ outline: `1px solid ${colour}`, top: nudge[field] }}
          >
            {points > 0 ? '+' : ''}{points} pts
            {continuous ? null : <> · {field === 'sl' ? money.fmt(stakeCents) : 'varies'}</>}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div
      ref={hostRef}
      /**
       * `pointer-events-none` on the layer, `pointer-events-auto` on the tags alone.
       *
       * The whole plot is the chart's own pan and pinch surface. A full-size overlay that took
       * pointer events would swallow every drag on the chart, so only the two tags are targets and
       * everything between them falls through to the chart.
       */
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
    >
      {line('sl', levels.slPoints)}
      {line('tp', levels.tpPoints)}
    </div>
  );
}

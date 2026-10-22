'use client';

import { useState } from 'react';
import {
  LEVEL_UNITS, pointsOfPrice, priceOfPoints, applyRatioLock, shapeOf,
  type LevelUnit, type Levels,
} from '@/lib/game/levels';
import { useLevelsStore } from '@/lib/game/levelsStore';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Stop Loss and Take Profit rows, for a DOCKED ticket.
 *
 * The phone's advanced dialog had these and the desktop ticket did not. What the desktop had
 * instead was a Stop Loss that was a read-only label printing the stake, and a Take Profit that was
 * a target floating PROFIT in cents from a different store, with no unit selector, no ratio lock,
 * no side swap and nothing drawn on the chart. So "SL/TP does not work on desktop" was accurate:
 * the stop could not be set at all, and the target was a different concept wearing MetaTrader's
 * label.
 *
 * This is the same model the phone uses, `lib/game/levels.ts`: signed distances in points from the
 * anchor the pair was placed against, which is how MetaTrader stores them and why a level stays on
 * its price instead of crawling with the market. One store, so a level set here is drawn on the
 * chart, draggable there, and still set when the phone layout takes over at a narrow width.
 *
 * ── Shaped for a docked panel, not copied from the phone ─────────────────────────────────────────
 * The phone stacks a chip above its stepper because at 360px a chip, two 44px buttons and a full
 * price did not fit on one line. A docked ticket is wider and MetaTrader's own desktop ticket puts
 * each level on one row, so that is what this is: label, stepper, clear.
 */
export function MT5LevelRows({ price, digits, continuous }: {
  /** The live price, which a first level is anchored against. Null before the first quote. */
  price: number | null;
  digits: number;
  /**
   * Whether the engine prices this brand's positions CONTINUOUSLY, so both levels really close one
   * at their price. See `isContinuousBrand` in lib/game/levelWatch.ts.
   */
  continuous: boolean;
}) {
  const levels = useLevelsStore((s) => s.levels);
  const setLevels = useLevelsStore((s) => s.set);
  const levelRef = useLevelsStore((s) => s.ref);
  const locked = useLevelsStore((s) => s.locked);
  const setLocked = useLevelsStore((s) => s.setLocked);
  const [unit, setUnit] = useState<LevelUnit>('price');
  const [typing, setTyping] = useState<null | { field: 'sl' | 'tp'; text: string }>(null);

  /** The anchor the distances are measured from. See levelsStore: a level is a price. */
  const anchor = levelRef ?? price;
  const ref = anchor ?? 0;
  /** A level is a price, so there has to be a price. Before the first quote there is none. */
  const settable = anchor !== null;

  /** MetaTrader's default distance for a first tap, in points. */
  const DEFAULT_POINTS = 100;

  const edit = (field: 'sl' | 'tp', points: number | null) => {
    if (!settable && points !== null) return;
    const next: Levels = field === 'sl' ? { ...levels, slPoints: points } : { ...levels, tpPoints: points };
    setLevels(locked ? applyRatioLock(levels, next, field) : next, price);
  };
  const step = (field: 'sl' | 'tp', dir: 1 | -1) => {
    const cur = field === 'sl' ? levels.slPoints : levels.tpPoints;
    // Nothing set yet: the first tap puts the level where MetaTrader's default would be, on the
    // side that field belongs on for a buy, rather than one point from the price.
    if (cur === null) { edit(field, field === 'sl' ? -DEFAULT_POINTS : DEFAULT_POINTS); return; }
    edit(field, cur + dir);
  };

  /**
   * How a level reads in the selected unit, which is what MetaTrader's segmented control changes:
   * the VALUE shown, not the level.
   *
   * `currency` is its third mode, "an approximate money amount". Both levels read `varies`: the
   * figures follow from the distance, but the engine publishes neither the gain nor the break-even
   * cost they follow from, so there is no number to print that would not be invented. The rows only
   * exist on a continuous brand now, so the committed-contract case this used to carry (a stop worth
   * exactly the stake) can no longer arise here.
   */
  const text = (field: 'sl' | 'tp'): string => {
    const points = field === 'sl' ? levels.slPoints : levels.tpPoints;
    if (!settable) return 'waiting';
    if (points === null) return 'not set';
    if (unit === 'points') return String(points);
    if (unit === 'price') return priceOfPoints(ref, points, digits).toFixed(digits);
    return 'varies';
  };
  const commit = (field: 'sl' | 'tp', raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) { setTyping(null); return; }
    edit(field, unit === 'points' ? Math.round(n) : pointsOfPrice(ref, n, digits));
    setTyping(null);
  };

  /**
   * A brand whose engine will not act on a level gets NO level rows.
   *
   * This is the rule the chart's context menu already follows and the reason its 11 unimplementable
   * rows are absent rather than greyed: a control that cannot act must not be drawn. Here the ticket
   * used to draw a full Stop Loss and Take Profit pair, with spinners, a unit control and a ratio
   * lock, on a brand where the engine fires neither, and then printed a sentence underneath saying
   * so. The trader could set a stop, watch it on the chart, and lose the whole stake anyway.
   *
   * `continuous` is the engine's own test (`isContinuousBrand`): a price axis, pool mode off. It is
   * the same condition `openPosition` uses to decide whether it will honour the levels at all, so
   * the ticket cannot offer what the engine will refuse.
   */
  if (!continuous) return null;

  const rowLabel = 'w-20 shrink-0 text-[12px] text-[var(--mt5-muted)]';
  const stepBtn = 'h-8 w-8 shrink-0 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] font-mono text-[14px] font-semibold text-[var(--mt5-blue)] transition hover:border-[var(--mt5-blue)] disabled:opacity-40';
  const shape = shapeOf(levels);

  return (
    <>
      {/*
        MetaTrader's unit control, and its ratio lock at the end of the same row.

        BARE, with no leading text: `docs/mt5/01-order-and-close-dialogs.md` 574 records the control
        as "Segmented control for stop-level units: `Price` | `Pips` | `USD`", a segmented control on
        its own. It carried a 80px "Levels in" label here, which is both an invention and the reason
        "Currency" rendered as "Currenc": the three segments shared what was left of a ~310px panel
        and the longest label overflowed its button by 4px. The name moves to the group's aria-label,
        so a screen reader still hears what the three buttons are for.
      */}
      <div className="flex items-center gap-1.5">
        <div role="group" aria-label="Stop Loss and Take Profit units" className="flex min-w-0 flex-1 overflow-hidden rounded border border-[var(--mt5-border)]">
          {LEVEL_UNITS.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setUnit(u.id)}
              aria-pressed={unit === u.id}
              className={cn(
                'min-w-0 flex-1 px-2 py-1 text-[11px] font-semibold transition',
                unit === u.id ? 'bg-[var(--mt5-border)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
        {/* "A lock button fixes the TP:SL ratio: adjust one and the other follows." */}
        <button
          type="button"
          onClick={() => setLocked(!locked)}
          aria-pressed={locked}
          aria-label="Lock the take profit to stop loss ratio"
          title="Fix the TP:SL ratio: adjust one level and the other follows."
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded border border-[var(--mt5-border)] transition', locked ? 'bg-[var(--mt5-border)] text-[var(--mt5-blue)]' : 'text-[var(--mt5-muted)] hover:text-white')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden>
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d={locked ? 'M8 11V8a4 4 0 018 0v3' : 'M8 11V8a4 4 0 017-2.6'} strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {(['sl', 'tp'] as const).map((field) => {
        const label = field === 'sl' ? 'Stop Loss' : 'Take Profit';
        const colour = field === 'sl' ? '#DD5B4E' : '#0EB52E';
        const value = text(field);
        const set = (field === 'sl' ? levels.slPoints : levels.tpPoints) !== null;
        return (
          <div key={field} className="flex items-center gap-1.5">
            <span className={rowLabel} style={{ color: colour }}>{label}</span>
            <button type="button" onClick={() => step(field, -1)} disabled={!settable} className={stepBtn} aria-label={`Lower ${label}`}>−</button>
            {typing?.field === field ? (
              <input
                autoFocus
                value={typing.text}
                inputMode="decimal"
                aria-label={`${label} value`}
                onChange={(e) => setTyping({ field, text: e.target.value })}
                onBlur={() => commit(field, typing.text)}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(field, typing.text); if (e.key === 'Escape') setTyping(null); }}
                className="h-8 min-w-0 flex-1 rounded border border-[var(--mt5-blue)] bg-[var(--mt5-surface)] px-1 text-center font-mono text-[12px] font-semibold text-[var(--mt5-text)] tabular-nums outline-none"
              />
            ) : (
              /* Tap the value to type it, which is MetaTrader's own affordance on these fields and
                 the thing the desktop ticket had no version of: it was a span. */
              <button
                type="button"
                disabled={!settable}
                onClick={() => setTyping({ field, text: value === 'not set' || value === 'varies' || value === 'waiting' ? '' : value })}
                aria-label={`${label} ${value}`}
                className={cn(
                  'h-8 min-w-0 flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1 text-center font-mono text-[12px] font-semibold tabular-nums transition hover:border-[var(--mt5-blue)]',
                  set ? 'text-white' : 'text-[var(--mt5-muted)]',
                )}
              >
                {value}
              </button>
            )}
            <button type="button" onClick={() => step(field, 1)} disabled={!settable} className={stepBtn} aria-label={`Raise ${label}`}>+</button>
            {set ? (
              <button type="button" data-compact="" onClick={() => edit(field, null)} className="shrink-0 px-0.5 text-[10px] text-[var(--mt5-blue)]" aria-label={`Clear ${label}`}>clear</button>
            ) : null}
          </div>
        );
      })}

      {/**
        * MetaTrader's new-order ticket prints NO paragraph under Stop Loss and Take Profit.
        *
        * Its fields stand on their own; the only stop-level prose MetaQuotes writes anywhere is the
        * two-line hint under the Modify position button (01-order-and-close-dialogs.md 224-228),
        * which is where this app now carries it too. What used to be here was two inventions: one
        * claiming stops are processed "on the server side" where MetaQuotes writes "broker side"
        * and quoting a max loss MetaTrader never prints here, and one that read
        *
        *     "Stop risks KES 10,000, the stake. Neither it nor Target fires on this brand: the
        *      contract settles at 10s."
        *
        * A paragraph explaining that the two controls directly above it do nothing is not a label,
        * it is an admission. The rows are not drawn at all on such a brand now (see the early
        * return at the top of this component), so there is nothing left to explain.
        */}

      {shape === null && (levels.slPoints !== null || levels.tpPoints !== null) ? (
        <p data-levels-invalid="" className="text-[11px] text-[var(--mt5-red)]">
          The stop and the target are on the same side of the price. One has to be above it and one
          below.
        </p>
      ) : null}
    </>
  );
}

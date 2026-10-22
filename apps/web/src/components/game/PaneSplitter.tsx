'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MIN_PANEL_PX, clampPanelHeight } from '@/lib/chart/paneSplit';

/**
 * MetaTrader's Toolbox splitter: drag the pane's top edge up for more Toolbox, down for more chart.
 *
 * MT5 docks the Toolbox under the chart and puts a splitter on its top edge. The chart above simply
 * takes whatever is left, which is why dragging the bar never leaves a hole: there is exactly one
 * flexible pane (the chart) and one sized pane (the Toolbox). Ours had neither a splitter nor a
 * sizeable pane: the panel was a fixed `min(46vh, 22rem)` and that was that, so a trader who wanted
 * to read the newswire could not have more of it, and one who wanted the chart could not have less.
 *
 * The size is stored as the TOOLBOX's pixel height and remembered per device. Pixels rather than a
 * fraction because what a trader is setting is how many rows of the panel they can read, and a
 * fraction of a short screen shows a different number of rows from a fraction of a tall one.
 */
const STORAGE_KEY = 'pp-toolbox-height';

export function usePanelHeight() {
  const [px, setPx] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startPx: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= MIN_PANEL_PX) setPx(saved);
    } catch { /* blocked storage: the default pane size is a fine answer */ }
  }, []);

  const begin = useCallback((clientY: number, currentPx: number) => {
    dragRef.current = { startY: clientY, startPx: currentPx };
  }, []);

  // Dragging UP grows the pane, because the edge being dragged is the pane's TOP: the pane follows
  // the finger rather than inverting it.
  const move = useCallback((clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    setPx(clampPanelHeight(d.startPx + (d.startY - clientY), window.innerHeight));
  }, []);

  const end = useCallback(() => {
    dragRef.current = null;
    setPx((v) => {
      if (v !== null) { try { window.localStorage.setItem(STORAGE_KEY, String(v)); } catch { /* non-fatal */ } }
      return v;
    });
  }, []);

  /** Double-click the splitter to hand the size back to the layout, as MT5 resets a pane. */
  const reset = useCallback(() => {
    setPx(null);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* non-fatal */ }
  }, []);

  return { px, begin, move, end, reset };
}

export function PaneSplitter({
  onGrab, onMove, onRelease, onReset, className,
}: {
  onGrab: (clientY: number) => void;
  onMove: (clientY: number) => void;
  onRelease: () => void;
  onReset: () => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);

  // Listening on the WINDOW while dragging, so the pointer may leave the 10px bar without the drag
  // dying: a splitter you lose the moment your finger strays is worse than no splitter.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { e.preventDefault(); onMove(e.clientY); };
    const up = () => { setDragging(false); onRelease(); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.userSelect = prev;
    };
  }, [dragging, onMove, onRelease]);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel"
      tabIndex={0}
      onPointerDown={(e) => { e.preventDefault(); onGrab(e.clientY); setDragging(true); }}
      onDoubleClick={onReset}
      // Arrow keys move it too, because a splitter that only answers to a pointer is unusable to
      // anyone driving by keyboard. Up grows the pane, matching the drag.
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onGrab(0);
        onMove(e.key === 'ArrowUp' ? -24 : 24);
        onRelease();
      }}
      title="Drag to resize. Double-click to reset."
      className={[
        'group relative h-2.5 w-full shrink-0 cursor-row-resize touch-none select-none',
        dragging ? 'bg-[var(--mt5-blue)]/30' : 'hover:bg-[var(--mt5-border)]',
        className ?? '',
      ].join(' ')}
      style={{ touchAction: 'none' }}
    >
      {/* The grip: MetaTrader draws a short rule, not a handle. */}
      <span
        aria-hidden
        className={[
          'pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition',
          dragging ? 'bg-[var(--mt5-blue-link)]' : 'bg-[var(--mt5-border)] group-hover:bg-[var(--mt5-muted)]',
        ].join(' ')}
      />
    </div>
  );
}

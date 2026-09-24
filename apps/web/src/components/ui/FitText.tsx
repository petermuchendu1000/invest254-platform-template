'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

const useIsoLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * A figure that is always shown IN FULL: never cut off with "…" and never spilling out of its card.
 *
 * The outer element carries the normal (largest) text size from its classes. After layout, if the
 * figure is wider than the space it has, the font shrinks just enough to fit (down to `minPx`). Only
 * if it still does not fit at `minPx` does it wrap at spaces ("KES" / "1,234,567"). It re-fits when
 * the card is resized and whenever the figure changes. Server render and no-JS show the full size.
 *
 * Use it where the WIDTH COMES FROM THE LAYOUT (a grid cell, a card, a flex-1 column) — not inside a
 * content-sized box, where shrinking the text would shrink the box and the two would chase each other.
 */
export function FitText({ children, className, minPx = 13, title }: {
  children: React.ReactNode; className?: string; minPx?: number; title?: string;
}) {
  const box = React.useRef<HTMLSpanElement | null>(null);
  const text = React.useRef<HTMLSpanElement | null>(null);

  const fit = React.useCallback(() => {
    const el = box.current, t = text.current;
    if (!el || !t) return;
    t.style.fontSize = '';
    t.style.whiteSpace = 'nowrap';
    const avail = el.clientWidth;
    const natural = t.scrollWidth;
    if (!avail || natural <= avail) return;
    const base = parseFloat(getComputedStyle(t).fontSize) || 16;
    const next = Math.max(minPx, Math.floor(base * (avail / natural) * 100) / 100 - 0.25);
    t.style.fontSize = `${next}px`;
    if (t.scrollWidth > avail) t.style.whiteSpace = 'normal'; // last resort: wrap at spaces
  }, [minPx]);

  useIsoLayoutEffect(fit); // after every render: the figure may have changed
  React.useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    // web fonts can land after first paint and change widths
    void (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
  }, [fit]);

  const plain = typeof children === 'string' || typeof children === 'number' ? String(children) : undefined;
  return (
    <span ref={box} className={cn('block min-w-0 max-w-full', className)} title={title ?? plain}>
      <span ref={text} className="inline-block max-w-full whitespace-nowrap leading-tight">{children}</span>
    </span>
  );
}

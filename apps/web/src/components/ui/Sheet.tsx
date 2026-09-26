'use client';

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Sheet — the one overlay pattern for phones (Apple HIG "sheets"): slides up from the bottom with a
 * grabber, never taller than the screen (header fixed, body scrolls), respects the home-indicator
 * safe area, closes on backdrop / Escape / the ✕ (44 px target). On ≥ sm it is a centred card.
 *
 * Replaces hand-built `fixed inset-0 … items-end` overlays whose content (and any menu inside them)
 * ran off the bottom of the screen with no way to scroll (BUGLOG #120).
 */
export function Sheet({
  open, onClose, title, icon, children, footer, label, className,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Small leading glyph in the header. */
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** Pinned below the scrolling body (primary actions stay reachable). */
  footer?: React.ReactNode;
  /** Accessible name when `title` is not a string. */
  label?: string;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true"
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => closeRef.current()} />
      <div ref={panel} tabIndex={-1}
        className={cn(
          'relative flex max-h-[min(92dvh,760px)] w-full max-w-app flex-col rounded-t-[20px] border border-border bg-surface shadow-2xl outline-none',
          'sm:max-w-md sm:rounded-[20px]',
          className,
        )}>
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted/40 sm:hidden" />
        {title ? (
          <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-2.5 sm:pt-4">
            {icon}
            <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight text-fg">{title}</h2>
            <button type="button" onClick={() => closeRef.current()} aria-label="Close"
              className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg">
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        {footer ? <div className="shrink-0 border-t border-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>
          : <div aria-hidden className="shrink-0 pb-[env(safe-area-inset-bottom)]" />}
      </div>
    </div>
  );
}

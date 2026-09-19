'use client';

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Accessible modal/sheet: a full-screen sheet on mobile, a centred card on >= sm.
 *
 * Two modes:
 *  - BARE (default, backward compatible): renders `children` directly inside the panel. Used by
 *    bespoke modals that draw their own header/padding (AuthModal, WalletModal, …).
 *  - CHROME (`chrome`): a professional header (title + close) / scrollable padded body / optional
 *    sticky footer — the high-end look (Binance/Stripe-style) for form & confirm popups, so each
 *    call-site stops re-implementing chrome and inconsistent padding.
 *
 * FOCUS BUG FIX: the open-time effect used to depend on `onClose`, which call-sites pass as an inline
 * arrow (a NEW function identity every render). Typing into a field re-renders the parent, so the
 * effect re-ran on EVERY keystroke and called `panelRef.focus()`, stealing focus off the input
 * (the "type one letter, lose the cursor" bug). The handler now reads `onClose` via a ref, so the
 * effect depends ONLY on `open` and runs exactly once per open — focus is set on open, never stolen.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  chrome = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional sub-title under the title (chrome mode). */
  description?: React.ReactNode;
  /** Optional sticky footer, e.g. Cancel / Confirm (chrome mode). */
  footer?: React.ReactNode;
  /** Panel max width on >= sm. */
  size?: 'sm' | 'md' | 'lg';
  /** Professional header/body/footer chrome. ON by default; set false for bespoke modals that draw
   *  their own header (AuthModal, WalletModal, transcript/detail views). */
  chrome?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without making it an effect dependency (see FOCUS BUG FIX above).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  const maxW = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md';

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-stretch justify-center sm:items-center',
        chrome ? 'sm:p-4' : '',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex w-full flex-col bg-surface outline-none',
          'border border-border shadow-2xl shadow-black/60 ring-1 ring-white/5',
          chrome
            ? 'max-h-dvh overflow-hidden sm:max-h-[88dvh] sm:rounded-2xl'
            : 'max-h-dvh overflow-y-auto sm:my-8 sm:max-h-[90dvh] sm:rounded-2xl sm:max-w-md',
          chrome ? maxW : '',
        )}
      >
        {chrome ? (
          <>
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="truncate text-base font-semibold tracking-tight text-fg">{title}</h2>
                {description ? <p className="text-xs text-muted">{description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => onCloseRef.current()}
                aria-label="Close"
                className="-mr-1.5 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
            {footer ? (
              <div className="flex items-center justify-end gap-2 border-t border-border bg-surface px-5 py-4 sm:px-6">
                {footer}
              </div>
            ) : null}
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

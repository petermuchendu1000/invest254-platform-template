'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useDisplayMoney } from '@/lib/money';

/** Everything needed to render a settled MANUAL digit trade, sourced from the authoritative
 *  `digit_settled` event (won / pnlCents / payoutCents / digit) plus the captured pending contract. */
export interface DigitResult {
  won: boolean;
  /** Human contract label, e.g. "Even", "Over 5", "Matches 3". */
  label: string;
  /** The settled last digit (0-9). */
  digit: number;
  stakeCents: number;
  /** Authoritative gross amount returned to the wallet (0 on a loss). */
  payoutCents: number;
  /** Authoritative net P/L (positive on a win, negative on a loss). */
  pnlCents: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Post-settlement result card for a MANUAL digit trade. A focused, dismissible modal that speaks the
 * app's existing outcome language (up/down tokens, the shared `pp-pop`/`pp-shake` entrance) and adds a
 * full receipt: contract, result digit, stake and payout. Purely presentational — every figure is
 * passed straight from the authoritative `digit_settled` event, so it can never disagree with the
 * ledger. AUTO-bot trades never open this (it would interrupt the rapid-fire loop); they keep the
 * in-chart flash badge instead.
 */
export function DigitResultModal({ result, onClose }: { result: DigitResult | null; onClose: () => void }) {
  const { fmt } = useDisplayMoney();
  const cardRef = useRef<HTMLDivElement>(null);
  const [reduce, setReduce] = useState(false);
  const open = result !== null;

  useEffect(() => { setReduce(prefersReducedMotion()); }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cardRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
  }, [open, onClose]);

  if (!result) return null;
  const { won, label, digit, stakeCents, payoutCents, pnlCents } = result;

  const anim = reduce
    ? ''
    : won
      ? 'animate-[pp-pop_320ms_cubic-bezier(0.2,0.9,0.2,1)]'
      : 'animate-[pp-shake_320ms_ease-in-out]';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={won ? 'You won' : 'No win'}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-sm rounded-2xl border bg-surface p-5 text-center outline-none ring-1 ring-white/5',
          won ? 'border-up/60 shadow-[0_0_48px_-6px_var(--pp-up)]' : 'border-down/50 shadow-[0_0_36px_-10px_var(--pp-down)]',
          anim,
        )}
      >
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        {/* Outcome icon */}
        <div
          className={cn(
            'mx-auto grid h-14 w-14 place-items-center rounded-full',
            won ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
          )}
        >
          {won ? (
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          )}
        </div>

        {/* Headline + net P/L */}
        <h2 className="mt-3 text-[13px] font-bold uppercase tracking-[0.18em] text-muted">{won ? 'You won' : 'No win'}</h2>
        <p className={cn('mt-1 text-4xl font-black tabular-nums', won ? 'text-up' : 'text-down')}>
          {won ? `+${fmt(pnlCents)}` : `-${fmt(Math.abs(pnlCents))}`}
        </p>

        {/* Receipt */}
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border text-left">
          <ReceiptCell label="Contract" value={label} />
          <ReceiptCell
            label="Result digit"
            value={
              <span
                className={cn(
                  'inline-grid h-6 w-6 place-items-center rounded-full text-xs font-bold tabular-nums',
                  won ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                )}
              >
                {digit}
              </span>
            }
          />
          <ReceiptCell label="Stake" value={<span className="tabular-nums">{fmt(stakeCents)}</span>} />
          <ReceiptCell label="Payout" value={<span className="tabular-nums">{fmt(payoutCents)}</span>} />
        </dl>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl bg-accent py-2.5 text-sm font-bold text-accent-fg transition hover:brightness-105"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ReceiptCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-surface px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="min-w-0 truncate text-sm font-semibold text-fg">{value}</span>
    </div>
  );
}

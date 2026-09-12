'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useDisplayMoney } from '@/lib/money';

/** The two authoritative figures behind a blocked trade. Shortfall is derived, never passed. */
export interface InsufficientFundsInfo {
  /** The stake the player tried to place (cents). */
  requiredCents: number;
  /** Their spendable balance right now (real + bonus, cents). */
  currentCents: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Shown when a MANUAL trade is blocked because the stake exceeds the spendable balance. Replaces the
 * old "silently pop the deposit sheet + a toast" flow with an explicit, honest step: the exact
 * numbers (current balance, required stake, and the shortfall to top up) plus a single Deposit CTA
 * that pre-fills the shortfall. Same shell/tokens as DigitResultModal so the two feel like one family.
 *
 * Purely presentational: figures are passed straight from the place() guard; it moves no money and
 * only calls back to open the existing deposit UI.
 */
export function InsufficientBalanceModal({
  info,
  onClose,
  onDeposit,
}: {
  info: InsufficientFundsInfo | null;
  onClose: () => void;
  onDeposit: (shortfallCents: number) => void;
}) {
  const { fmt } = useDisplayMoney();
  const cardRef = useRef<HTMLDivElement>(null);
  const [reduce, setReduce] = useState(false);
  const open = info !== null;

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

  if (!info) return null;
  const shortfall = Math.max(0, info.requiredCents - info.currentCents);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Not enough balance">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-sm rounded-2xl border border-warn/50 bg-surface p-5 text-center outline-none ring-1 ring-white/5',
          'shadow-[0_0_40px_-8px_var(--pp-warn)]',
          reduce ? '' : 'animate-[pp-pop_320ms_cubic-bezier(0.2,0.9,0.2,1)]',
        )}
      >
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

        {/* Wallet icon */}
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-warn/15 text-warn">
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            <path d="M3 7l2.5-3.5A1 1 0 0 1 6.3 3H16" />
            <circle cx="16.5" cy="13" r="1.3" fill="currentColor" stroke="none" />
          </svg>
        </div>

        <h2 className="mt-3 text-base font-bold text-fg">Not enough balance</h2>
        <p className="mt-1 text-[12px] leading-snug text-muted">Top up to place this trade. You only need the shortfall below.</p>

        {/* Figures */}
        <dl className="mt-4 flex flex-col gap-px overflow-hidden rounded-xl border border-border bg-border text-left">
          <Row label="Current balance" value={fmt(info.currentCents)} />
          <Row label="Required stake" value={fmt(info.requiredCents)} />
          <Row label="Shortfall" value={fmt(shortfall)} tone="warn" />
        </dl>

        <button
          type="button"
          onClick={() => onDeposit(shortfall)}
          className="mt-4 w-full rounded-xl bg-accent py-2.5 text-sm font-bold text-accent-fg transition hover:brightness-105"
        >
          Deposit {fmt(shortfall)}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-xl border border-border py-2 text-sm font-medium text-muted transition hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-surface px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className={cn('text-sm font-bold tabular-nums', tone === 'warn' ? 'text-warn' : 'text-fg')}>{value}</span>
    </div>
  );
}

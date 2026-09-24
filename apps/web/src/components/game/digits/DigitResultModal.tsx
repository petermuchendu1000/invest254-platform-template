'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAmountText } from '@/lib/game/useAmountText';
import { DIcon, type IconName } from '@/components/game/digits/icons';

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
  /** Open → settle time, when known. */
  durationMs?: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Post-settlement result card for a MANUAL digit trade (digits broker mock): outcome icon, headline,
 * the net profit/loss, then Stake / Payout / Result digit / Duration tiles and the contract as a
 * pill. Every figure comes straight from the engine's `digit_settled` event, so it can never disagree
 * with the ledger. AUTO trades never open this; they keep the in-chart flash badge.
 */
export function DigitResultModal({ result, onClose }: { result: DigitResult | null; onClose: () => void }) {
  const amt = useAmountText();
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
  const { won, label, digit, stakeCents, payoutCents, pnlCents, durationMs } = result;
  const anim = reduce ? '' : won ? 'animate-[pp-pop_320ms_cubic-bezier(0.2,0.9,0.2,1)]' : 'animate-[pp-shake_320ms_ease-in-out]';
  const secs = durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={won ? 'You won' : 'Trade lost'}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-[320px] rounded-2xl border-[1.5px] bg-surface px-5 pb-5 pt-6 text-center outline-none',
          won ? 'border-up shadow-[0_0_40px_-10px_var(--pp-up)]' : 'border-down shadow-[0_0_40px_-12px_var(--pp-down)]',
          anim,
        )}
      >
        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full bg-surface-2 text-muted transition hover:text-fg">
          <DIcon name="close" className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>

        <div className={cn('mx-auto grid h-14 w-14 place-items-center rounded-full', won ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
          <DIcon name={won ? 'trophy' : 'arrowDownRight'} className="h-7 w-7" />
        </div>

        <h2 className={cn('mt-3 font-mono text-[22px] font-black tracking-wide', won ? 'text-up' : 'text-down')}>{won ? 'YOU WON!' : 'YOU LOST'}</h2>
        <p className="mt-0.5 text-[13px] text-muted">{won ? 'Your contract settled in your favour.' : 'Your contract did not settle in your favour.'}</p>

        <div className="mt-4 rounded-xl border border-border bg-bg/40 px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Profit / Loss</div>
          <div className={cn('mt-1 font-mono text-[26px] font-bold tabular-nums', won ? 'text-up' : 'text-down')}>{amt.signed(pnlCents)}</div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-left">
          <Tile icon="dollar" label="Stake" value={amt.num(stakeCents)} prefix={amt.prefix} />
          <Tile icon="dollar" label="Payout" value={amt.num(payoutCents)} prefix={amt.prefix} />
          <Tile icon="hash" label="Result digit" value={String(digit)} />
          <Tile icon="clock" label="Duration" value={secs != null ? `${secs}s` : '—'} />
        </div>

        <span className={cn('mt-4 inline-block rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase', won ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{label}</span>
      </div>
    </div>
  );
}

function Tile({ icon, label, value, prefix = '' }: { icon: IconName; label: string; value: string; prefix?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-bg/30 px-3 py-2.5">
      <DIcon name={icon} className="h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</div>
        <div className="truncate font-mono text-[13px] font-bold tabular-nums text-fg">{prefix}{value}</div>
      </div>
    </div>
  );
}

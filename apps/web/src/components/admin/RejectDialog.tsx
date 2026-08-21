'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';

/*
 * RejectDialog — a focused confirmation modal for rejecting a payout. Replaces the browser
 * confirm()/prompt() with a proper surface that (a) states the consequence plainly, and (b) captures
 * an optional reason (persisted to the audit log / shared with the marketer). Esc + backdrop close;
 * the reason field is cleared each time it opens. Dark-token styled, matches the admin console.
 */
export function RejectDialog({
  open,
  onClose,
  onConfirm,
  title = 'Reject payout',
  subject,
  consequence,
  reasonPersisted = true,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
  title?: string;
  /** Short line naming what's being rejected, e.g. "James · KES 1,200". */
  subject?: string | undefined;
  /** Plain-language explanation of what rejecting does. */
  consequence: React.ReactNode;
  /** When false, the reason is not stored server-side (shown as a note). */
  reasonPersisted?: boolean;
  busy?: boolean;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/60 ring-1 ring-white/5 sm:rounded-2xl">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-down/15 text-down">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight text-fg">{title}</h3>
            {subject ? <p className="truncate text-sm text-muted">{subject}</p> : null}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-border bg-surface-2/50 p-3 text-sm leading-relaxed text-muted">
          {consequence}
        </div>

        <label className="mt-4 flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-fg">
            Reason{' '}
            <span className="font-normal text-muted">
              (optional{reasonPersisted ? ', saved to the audit log & shared with the marketer' : ''})
            </span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            autoFocus
            placeholder="e.g. Awaiting KYC · duplicate request · suspected fraud…"
            className="w-full rounded-brand border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent"
          />
          <span className="self-end text-[11px] text-muted">{reason.length}/500</span>
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="down" size="sm" onClick={() => onConfirm(reason.trim() || undefined)} disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject payout'}
          </Button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { useDigitSession } from '@/lib/game/digitSession';
import { PositionsPanel } from '@/components/game/digits/PositionsPanel';

/** Phones: the Positions panel as a sheet opened from the bottom nav (desktop shows it as a rail). */
export function PositionsSheet() {
  const open = useDigitSession((s) => s.positionsOpen);
  const setOpen = useDigitSession((s) => s.setPositionsOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, setOpen]);
  if (!open) return null;
  return (
    // A bottom sheet with a grabber, like every other phone overlay (was a side drawer leaving a strip).
    <div className="fixed inset-0 z-50 flex items-end lg:hidden" role="dialog" aria-modal="true" aria-label="Positions">
      <button aria-label="Close positions" tabIndex={-1} className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative flex h-[min(88dvh,720px)] w-full flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted/40" />
        <PositionsPanel onClose={() => setOpen(false)} className="min-h-0 flex-1" />
      </div>
    </div>
  );
}

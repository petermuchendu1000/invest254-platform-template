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
    <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Positions">
      <button aria-label="Close positions" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative ml-auto flex h-full w-[88vw] max-w-[420px] flex-col border-l border-border bg-surface shadow-2xl">
        <PositionsPanel onClose={() => setOpen(false)} className="h-full" />
      </div>
    </div>
  );
}

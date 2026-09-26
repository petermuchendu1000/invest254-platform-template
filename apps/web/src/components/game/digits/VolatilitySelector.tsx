'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { type Instrument } from '@/lib/game/instruments';
import { MarketsPanel, IndexBadge } from '@/components/game/digits/MarketsPicker';

function BarsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <rect x="1" y="9" width="3" height="6" rx="1" />
      <rect x="6.5" y="5" width="3" height="10" rx="1" />
      <rect x="12" y="2.5" width="3" height="12.5" rx="1" />
    </svg>
  );
}

/** Renders the label with the "(1s)" tag emphasised, mirroring Deriv's picker typography. */
function IndexLabel({ inst }: { inst: Instrument }) {
  const m = inst.label.match(/^(Volatility \d+)( \(1s\))?( Index)$/);
  if (!m) return <>{inst.label}</>;
  return (
    <>
      {m[1]}
      {m[2] ? <span className="font-bold text-fg">{m[2]}</span> : null}
    </>
  );
}

/**
 * Deriv-style market trigger. It shows the current instrument, its live price and change, and opens
 * the Markets picker (MarketsPicker.tsx): a popover on desktop, a bottom sheet on phones.
 */
export function VolatilitySelector({
  instrument,
  price,
  changePct,
  onSelect,
  wide = false,
}: {
  instrument: Instrument;
  price: number | null;
  changePct: number;
  onSelect: (inst: Instrument) => void;
  /** Wide toolbar trigger (icon · bold full label · live price+change · edit affordance). */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);   // the portalled panel is outside rootRef

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Desktop popover: anchored under the trigger, kept inside the viewport (the chart can be narrower
  // than the panel). Phones use a bottom sheet instead.
  const toggle = () => {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      const W = 640;
      setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - W - 12)), top: r.bottom + 8 });
    }
    setOpen((v) => !v);
  };

  const chgPos = changePct >= 0;
  const leaf = instrument.short.replace(/^Vol\s*/, ''); // e.g. "10 (1s)"

  return (
    <div ref={rootRef} className="relative min-w-0">
      {wide ? (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={instrument.label}
          className={cn(
            'flex h-9 min-w-0 max-w-full items-center gap-2 rounded-lg border bg-surface-2 pl-1.5 pr-2 text-left transition',
            open ? 'border-accent' : 'border-border hover:border-accent/60',
          )}
        >
          <IndexBadge inst={instrument} size="sm" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[12.5px] font-bold text-fg">
              <IndexLabel inst={instrument} />
            </span>
            <span className="truncate text-[10px] font-medium tabular-nums text-muted">
              {price != null ? price.toFixed(2) : '—'}
              <span className={cn('ml-1 font-semibold', chgPos ? 'text-up' : 'text-down')}>
                {chgPos ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            </span>
          </span>
          {/* dropdown chevron (rotates when open) */}
          <svg viewBox="0 0 24 24" className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform', open ? 'rotate-180' : '')} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={price != null ? `${instrument.label} · ${price.toFixed(2)}` : instrument.label}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border bg-surface-2/85 px-2 py-1 text-left backdrop-blur transition',
          open ? 'border-accent' : 'border-border hover:border-accent/60',
        )}
      >
        <BarsGlyph className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="text-[11px] font-medium text-muted">Volatility</span>
        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] font-bold text-fg">{leaf}</span>
        <span className={cn('ml-0.5 text-[10px] font-semibold tabular-nums', chgPos ? 'text-up' : 'text-down')}>
          {chgPos ? '+' : ''}{changePct.toFixed(2)}%
        </span>
        <svg viewBox="0 0 24 24" className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform', open ? 'rotate-180' : '')} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      )}

      {/* Portalled to <body> (BUGLOG #120): inside the chart toolbar's stacking context (z-20) the phone
          sheet rendered UNDER the bottom nav, hiding the last markets. */}
      {open && typeof document !== 'undefined' ? createPortal(
        <>
          <button type="button" aria-label="Close markets" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none" />
          <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Markets"
            style={pos ? ({ '--mp-left': `${pos.left}px`, '--mp-top': `${pos.top}px` } as React.CSSProperties) : undefined}
            className="fixed inset-x-0 bottom-0 z-50 flex h-[min(88dvh,720px)] flex-col overflow-hidden rounded-t-[20px] border border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl
                       lg:inset-auto lg:left-[var(--mp-left)] lg:top-[var(--mp-top)] lg:h-[min(470px,calc(100vh-var(--mp-top)-16px))] lg:w-[640px] lg:rounded-2xl lg:pb-0">
            <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted/40 lg:hidden" />
            <div className="min-h-0 flex-1"><MarketsPanel current={instrument} onSelect={onSelect} onClose={() => setOpen(false)} /></div>
          </div>
        </>, document.body) : null}
    </div>
  );
}

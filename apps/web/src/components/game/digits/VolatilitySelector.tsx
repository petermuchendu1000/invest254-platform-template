'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { INSTRUMENTS, type Instrument } from '@/lib/game/instruments';

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
      {m[3]}
    </>
  );
}

/**
 * Deriv-style Volatility Index picker. The trigger shows the current instrument, its live price and
 * change; the dropdown lists every index with a chart glyph and a selected marker.
 */
export function VolatilitySelector({
  instrument,
  price,
  changePct,
  onSelect,
}: {
  instrument: Instrument;
  price: number | null;
  changePct: number;
  onSelect: (inst: Instrument) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const chgPos = changePct >= 0;
  const leaf = instrument.short.replace(/^Vol\s*/, ''); // e.g. "10 (1s)"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
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

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-30 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-surface-2 p-1 shadow-2xl"
        >
          {INSTRUMENTS.map((inst) => {
            const active = inst.id === instrument.id;
            return (
              <button
                key={inst.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onSelect(inst); setOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition',
                  active ? 'bg-accent/15' : 'hover:bg-white/5',
                )}
              >
                <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', active ? 'bg-accent/20 text-accent' : 'bg-white/5 text-muted')}>
                  <BarsGlyph className="h-3.5 w-3.5" />
                </span>
                <span className={cn('min-w-0 flex-1 truncate text-sm', active ? 'text-fg' : 'text-muted')}>
                  <IndexLabel inst={inst} />
                </span>
                {active ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

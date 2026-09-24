'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { DIcon } from '@/components/game/digits/icons';

/**
 * DERIV-UI: the "Trade types" sheet (owner's mock). Filter chips on top, then the trade types in
 * groups. Only types the engine supports are listed: Multipliers and the three Digits contracts.
 *
 * Multipliers is offered on the Demo account only. On a real-money account in pool mode the engine
 * replaces the live price path with a scripted path to an outcome decided at open (and disables
 * stop loss, deal cancellation and closing early), so the P/L a player would watch would not follow
 * the chart. In demo the engine prices it honestly from the quote.
 */
export type TradeTypeId = 'multipliers' | 'matchesdiffers' | 'evenodd' | 'overunder';

export const TRADE_TYPES: { id: TradeTypeId; label: string; group: 'Multipliers' | 'Digits'; kind: 'multipliers' | 'options' }[] = [
  { id: 'multipliers', label: 'Multipliers', group: 'Multipliers', kind: 'multipliers' },
  { id: 'matchesdiffers', label: 'Matches/Differs', group: 'Digits', kind: 'options' },
  { id: 'evenodd', label: 'Even/Odd', group: 'Digits', kind: 'options' },
  { id: 'overunder', label: 'Over/Under', group: 'Digits', kind: 'options' },
];

const up = 'text-up';
const down = 'text-down';

/** Paired glyphs, like Deriv: the two sides of each contract. */
export function TradeTypeIcon({ id, className = 'h-5 w-5' }: { id: TradeTypeId; className?: string }) {
  const svg = (children: React.ReactNode, tone: string) => (
    <svg viewBox="0 0 24 24" className={cn(className, tone)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
  );
  switch (id) {
    case 'multipliers':
      return <span className="flex gap-1">{svg(<><path d="M5 19L19 5M11 5h8v8" /><path d="M5 5l5 5" opacity=".5" /></>, up)}{svg(<><path d="M5 5l14 14M19 11v8h-8" /><path d="M19 5l-5 5" opacity=".5" /></>, down)}</span>;
    case 'matchesdiffers':
      return <span className="flex gap-1">{svg(<><path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5" /></>, up)}{svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /><circle cx="12" cy="12" r="1.5" /></>, down)}</span>;
    case 'evenodd':
      return <span className="flex gap-1">{svg(<><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></>, up)}{svg(<><path d="M12 4l4 7H8z" /><path d="M7 13l4 7H3z" /><path d="M17 13l4 7h-8z" /></>, down)}</span>;
    case 'overunder':
      return <span className="flex gap-1">{svg(<><path d="M3 14h18" opacity=".5" /><path d="M6 11l5-6 5 3 3-3M15 5h4v4" /></>, up)}{svg(<><path d="M3 10h18" opacity=".5" /><path d="M6 13l5 6 5-3 3 3M15 19h4v-4" /></>, down)}</span>;
  }
}

const CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'multipliers', label: 'Multipliers' },
  { id: 'options', label: 'Options' },
] as const;

export function TradeTypesSheet({ value, onPick, onClose, demo }: {
  value: TradeTypeId; onPick: (id: TradeTypeId) => void; onClose: () => void; demo: boolean;
}) {
  const [chip, setChip] = useState<(typeof CHIPS)[number]['id']>('all');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = TRADE_TYPES.filter((t) => chip === 'all' || t.kind === chip);
  const groups = ['Multipliers', 'Digits'] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center" role="dialog" aria-modal="true" aria-label="Trade types">
      <button type="button" aria-label="Close trade types" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl lg:w-[420px] lg:rounded-2xl">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <h2 className="text-[17px] font-bold text-fg">Trade types</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-fg">
            <DIcon name="close" className="h-5 w-5" />
          </button>
        </div>
        <div className="flex gap-2 border-b border-border px-4 pb-3" role="tablist" aria-label="Filter trade types">
          {CHIPS.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={chip === c.id} onClick={() => setChip(c.id)}
              className={cn('rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition', chip === c.id ? 'bg-fg text-bg' : 'bg-surface-2 text-muted hover:text-fg')}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
          {groups.map((g) => {
            const items = shown.filter((t) => t.group === g);
            if (!items.length) return null;
            return (
              <section key={g}>
                <h3 className="px-3 pb-1 pt-4 text-[13px] font-bold text-fg">{g}</h3>
                {items.map((t) => {
                  const locked = t.id === 'multipliers' && !demo;
                  const active = t.id === value;
                  return (
                    <button key={t.id} type="button" disabled={locked} aria-pressed={active}
                      onClick={() => { onPick(t.id); onClose(); }}
                      className={cn('flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left transition',
                        active ? 'bg-surface-2' : 'hover:bg-surface-2/60', locked && 'cursor-not-allowed opacity-50 hover:bg-transparent')}>
                      <TradeTypeIcon id={t.id} />
                      <span className="flex-1 text-[14px] font-medium text-fg">{t.label}</span>
                      {locked ? <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] font-semibold text-muted">Demo account</span> : null}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

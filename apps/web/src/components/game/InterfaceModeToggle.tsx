'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useInterfaceMode, useInterfaceModeStore, type InterfaceMode } from '@/lib/ui/interfaceMode';

const GearIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.2 3H10.6l-.4 2.1a7.6 7.6 0 0 0-2.6 1.5l-2-.8L3.8 8.9l1.7 1.3a7.8 7.8 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.4 2.1h3.6l.4-2.1a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.3Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Check = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden>
    <path d="m5 10.5 3.2 3.2L15 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const OPTIONS: { id: InterfaceMode; label: string; desc: string }[] = [
  { id: 'classic', label: 'Classic', desc: 'Full chart & controls' },
  { id: 'basic', label: 'Basic', desc: 'Simplified game view' },
];

/**
 * Trade-screen gear: lets a PLAYER switch the classic (waves) shell between the full trading terminal
 * (`Classic`) and the simplified game skin (`Basic`). Rendered only for non-marketer players (a real
 * marketer is always on Basic and must not see a toggle). Preference is per-device (localStorage).
 */
export function InterfaceModeToggle() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useInterfaceMode();
  const setMode = useInterfaceModeStore((s) => s.setMode);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Interface settings"
        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--mt5-border)] bg-[var(--mt5-surface)]/80 text-[var(--mt5-muted)] transition hover:text-fg"
      >
        <GearIcon className="h-[18px] w-[18px]" />
      </button>
      {open ? (
        <div role="menu" aria-label="Interface" className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] p-1 shadow-2xl shadow-black/50">
          <div className="px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--mt5-muted)]">Interface</div>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === o.id}
              onClick={() => { setMode(o.id); setOpen(false); }}
              className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-[var(--mt5-raised)]', mode === o.id && 'bg-[var(--mt5-raised)]')}
            >
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-fg">{o.label}</span>
                <span className="block text-[11px] text-[var(--mt5-muted)]">{o.desc}</span>
              </span>
              {mode === o.id ? <Check className="h-4 w-4 shrink-0 text-[var(--mt5-blue)]" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

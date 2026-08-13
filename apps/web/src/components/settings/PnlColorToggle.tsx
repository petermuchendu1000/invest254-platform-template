'use client';

import { useEffect, useState } from 'react';

/**
 * P/L colour-mode toggle (opt-in accessibility / preference). Default "brand" keeps the calm
 * mono curve (vivid brand above zero, muted neutral below); "classic" swaps to the conventional
 * green/red by toggling `html.pnl-classic` (globals.css overrides only --pp-up/--pp-down, so the
 * live curve + ticker re-skin instantly). Persisted in localStorage('pp-pnl'); applied pre-paint
 * by the inline script in the root layout so there is no flash.
 */
type Mode = 'brand' | 'classic';

function apply(mode: Mode) {
  const e = document.documentElement;
  e.classList.toggle('pnl-classic', mode === 'classic');
  try { localStorage.setItem('pp-pnl', mode); } catch { /* ignore */ }
}

export function PnlColorToggle() {
  const [mode, setMode] = useState<Mode>('brand');
  useEffect(() => {
    try { setMode(localStorage.getItem('pp-pnl') === 'classic' ? 'classic' : 'brand'); } catch { /* ignore */ }
  }, []);

  const set = (m: Mode) => { setMode(m); apply(m); };
  const opts: Array<{ v: Mode; label: string; hint: string }> = [
    { v: 'brand', label: 'Brand (mono)', hint: 'vivid brand ▲ / muted neutral ▼' },
    { v: 'classic', label: 'Classic', hint: 'green ▲ / red ▼' },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg">Profit / loss colours</span>
      <div className="inline-flex w-full max-w-sm rounded-xl border border-border bg-surface-2 p-1" role="group" aria-label="P/L colour mode">
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            aria-pressed={mode === o.v}
            onClick={() => set(o.v)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              mode === o.v ? 'bg-brand text-[color:var(--pp-accent-fg)]' : 'text-muted hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        {mode === 'classic'
          ? 'Gains show green, losses red — the conventional trading palette.'
          : 'Gains use your brand colour, losses a muted neutral — calmer and colourblind-safe. Position (above/below zero) and +/− signs distinguish both modes.'}
      </p>
    </div>
  );
}

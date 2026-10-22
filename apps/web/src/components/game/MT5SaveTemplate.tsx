'use client';

import { useEffect, useRef, useState } from 'react';
import { listTemplates, type ChartTemplate } from '@/lib/chart/templates';

/**
 * MetaTrader's `Save Template...`, the one dialog its Templates submenu opens.
 *
 * In MetaTrader this is the operating system's Save As box, writing a `.tpl` file into
 * `MQL5\Profiles\Templates`; the name it offers first is the chart's own, and saving over an
 * existing template replaces it. There is no file system here, so the same job is done by a name
 * field over this device's storage (lib/chart/templates), and everything else is kept: the name is
 * offered, an existing name is overwritten, and the four that ship with the terminal are refused
 * rather than shadowed.
 *
 * It reports what `saveTemplate` returned instead of closing on a save that did not happen — a
 * dialog that dismissed itself after refusing `Default` would read as having saved.
 */
export function MT5SaveTemplate({
  suggested, existing, onSave, onDismiss,
}: {
  /** The name to offer, which is the chart's own title (`XAUUSD,M1`). */
  suggested: string;
  /** What is already saved, so the dialog can say it is about to replace one. */
  existing?: readonly ChartTemplate[] | undefined;
  /** Writes the chart under this name and returns what `saveTemplate` returned. */
  onSave: (name: string) => 'saved' | 'reserved' | 'empty';
  onDismiss: () => void;
}) {
  const [name, setName] = useState(suggested);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const all = existing ?? listTemplates();

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const match = all.find((t) => t.name === name.trim()) ?? null;

  /**
   * The chart's own state is the caller's, so the caller does the write; this dialog owns the NAME.
   * `saveTemplate`'s two refusals are still the authority on what a name may be, so the handler
   * reports whichever one came back rather than assuming the dialog's own check caught it.
   */
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '') { setError('A template needs a name.'); return; }
    const result = onSave(trimmed);
    if (result === 'reserved') {
      setError(`"${trimmed}" ships with the terminal and cannot be replaced. Choose another name.`);
      return;
    }
    if (result === 'empty') { setError('A template needs a name.'); return; }
    onDismiss();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Save Template"
      className="fixed inset-0 z-[86] flex items-center justify-center bg-black/60 p-4 text-white"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="w-full max-w-[360px] rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="flex-1 truncate text-[15px] font-semibold leading-tight">Save Template</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="px-3 py-3">
          <label className="mb-1.5 block text-[11px] font-semibold text-[var(--mt5-muted)]" htmlFor="tpl-name">
            Template name
          </label>
          <input
            id="tpl-name"
            ref={field}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            data-template-name
            className="h-8 w-full rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-2 text-[12px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
          />
          {/* What a template carries, stated where it is saved: MetaTrader's rule is settings and
              indicators, never the objects drawn on the chart. */}
          <p className="mt-2 text-[10.5px] leading-snug text-[var(--mt5-muted)]">
            Saves this chart&apos;s type, period, properties and indicators. Objects stay on the chart they
            were drawn on.
          </p>
          {error ? (
            <p data-template-error className="mt-2 text-[11px] font-semibold leading-snug text-[#ff4d6a]">{error}</p>
          ) : match !== null && !match.builtIn ? (
            <p className="mt-2 text-[11px] leading-snug text-[#f0b429]">
              A template named &quot;{match.name}&quot; already exists and will be replaced.
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--mt5-border)] px-3 py-2.5">
          <button
            type="button"
            onClick={submit}
            data-template-save
            className="h-8 rounded-sm bg-[var(--mt5-blue)] px-6 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="h-8 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-5 text-[11px] font-semibold text-[var(--mt5-text)] transition hover:bg-[var(--mt5-border)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

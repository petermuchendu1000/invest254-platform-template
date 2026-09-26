'use client';

import { cn } from '@/lib/cn';

/**
 * Segmented control (Apple HIG): 2–5 mutually exclusive choices shown at once — no dropdown to open,
 * nothing to clip. 48 px tall (44 px segments), equal segments, the selected one in the brand accent (as every active pill). Keyboard: arrow keys move.
 */
export function Segmented<T extends string>({
  value, onChange, options, label, disabled, className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ id: T; label: string }>;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const idx = options.findIndex((o) => o.id === value);
  return (
    <div role="radiogroup" aria-label={label}
      className={cn('grid h-12 rounded-[14px] bg-surface-2 p-0.5', disabled && 'opacity-60', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      onKeyDown={(e) => {
        if (disabled) return;
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = options[(idx + d + options.length) % options.length];
        if (next) onChange(next.id);
      }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" role="radio" data-compact aria-checked={on} tabIndex={on ? 0 : -1} disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn('min-w-0 truncate rounded-xl font-semibold transition', options.length >= 3 ? 'px-1 text-[12px]' : 'px-2 text-[13px]',
              on ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/40' : 'text-muted hover:text-fg')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

'use client';

import { cn } from '@/lib/cn';

/**
 * Deriv-style last-digit statistics: the frequency (%) of each digit 0-9 across the recent tick
 * window. The current (latest) digit is ringed; the hottest digit reads green and the coldest red.
 * When `selectable` the chips act as a digit picker (Matches/Differs barrier, Over/Under barrier).
 */
export function DigitHeatmap({
  freqs,
  current,
  selected = null,
  selectable = false,
  onSelect,
}: {
  freqs: number[];
  current: number | null;
  selected?: number | null;
  selectable?: boolean;
  onSelect?: (digit: number) => void;
}) {
  const max = Math.max(...freqs);
  const min = Math.min(...freqs);
  return (
    <div className="grid grid-cols-10 gap-1">
      {freqs.map((f, d) => {
        const isMax = max > 0 && f === max;
        const isMin = f === min && max !== min;
        const isCurrent = current === d;
        const isSelected = selectable && selected === d;
        return (
          <button
            key={d}
            type="button"
            disabled={!selectable}
            onClick={() => onSelect?.(d)}
            aria-pressed={isSelected}
            className={cn(
              'flex flex-col items-center rounded-md border py-1 transition',
              selectable ? 'cursor-pointer hover:border-accent/70' : 'cursor-default',
              isSelected ? 'border-accent bg-accent/20' : 'border-border bg-surface-2',
              isCurrent && !isSelected ? 'ring-2 ring-accent ring-offset-0' : '',
            )}
          >
            <span className="text-sm font-bold leading-none tabular-nums text-fg">{d}</span>
            <span
              className={cn(
                'mt-0.5 text-[9px] font-semibold leading-none tabular-nums',
                isMax ? 'text-up' : isMin ? 'text-down' : 'text-muted',
              )}
            >
              {f.toFixed(1)}%
            </span>
            {/* current-digit marker (triangle), mirrors the tagoption/Deriv pointer */}
            <span className={cn('mt-0.5 h-1 w-1 rotate-45 rounded-[1px]', isCurrent ? 'bg-accent' : 'bg-transparent')} />
          </button>
        );
      })}
    </div>
  );
}

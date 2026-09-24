'use client';

import { cn } from '@/lib/cn';

/**
 * Last-digit statistics row (digits broker mock): each digit 0-9 as a circle with its share (%) of
 * the recent tick window underneath.
 *  - CURRENT digit: solid light circle with dark text (+ an amber pointer beneath on phones).
 *  - HIGHEST share: an accent-green arc on the ring; LOWEST share: a red arc and red text.
 * Fluid on phones (grid-cols-10, circles fill their column); fixed 40px circles spread evenly on
 * desktop. Read-only; colours come from brand tokens so it re-skins per brand.
 */
export function DigitHeatmap({ freqs, current }: { freqs: number[]; current: number | null; selected?: number | null; selectable?: boolean; onSelect?: (d: number) => void }) {
  const max = Math.max(...freqs);
  const min = Math.min(...freqs);
  return (
    <div className="grid grid-cols-10 gap-[3px] lg:flex lg:items-start lg:justify-between lg:gap-0 lg:px-1" aria-label="Last digit statistics">
      {freqs.map((f, d) => {
        const isMax = max > 0 && f === max && max !== min;
        const isMin = max !== min && f === min;
        const isCurrent = current === d;
        return (
          <div key={d} className="flex min-w-0 flex-col items-center gap-1" aria-label={`Digit ${d}: ${f.toFixed(1)}%${isCurrent ? ', latest' : ''}`}>
            <span
              className={cn(
                'relative flex aspect-square w-full max-w-[42px] items-center justify-center rounded-full border-[1.5px] text-[clamp(12px,3.6vw,15px)] font-bold leading-none tabular-nums transition-colors lg:h-10 lg:w-10',
                isCurrent ? 'border-fg bg-fg text-bg' : 'border-border bg-surface text-fg',
                !isCurrent && isMin ? 'text-down' : '',
                !isCurrent && isMax ? 'text-up' : '',
              )}
            >
              {d}
              {(isMax || isMin) && !isCurrent ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-[1.5px] rounded-full"
                  style={{
                    background: `conic-gradient(from -50deg, var(${isMax ? '--pp-up' : '--pp-down'}) 0 28%, transparent 28% 100%)`,
                    WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                    mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                  }}
                />
              ) : null}
            </span>
            <span className={cn('whitespace-nowrap text-[clamp(8.5px,2.5vw,10.5px)] font-medium leading-none tabular-nums', isMax ? 'text-up' : isMin ? 'text-down' : 'text-muted')}>
              {f.toFixed(1)}%
            </span>
            <span
              aria-hidden
              className={cn('h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent lg:hidden', isCurrent ? '' : 'border-t-transparent')}
              style={isCurrent ? { borderTopColor: 'var(--pp-warn)' } : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

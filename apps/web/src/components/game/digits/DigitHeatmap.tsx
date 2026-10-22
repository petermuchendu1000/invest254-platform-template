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
export function DigitHeatmap({ freqs, current, ready = true }: { freqs: number[]; current: number | null; selected?: number | null; selectable?: boolean; onSelect?: (d: number) => void;
  /**
   * False until the first tick window has been counted.
   *
   * The screen seeds `freqs` with ten zeros, so this row used to render ten circles each labelled
   * "0.0%" on first paint — a statistics row stating that every digit has never once occurred,
   * which is a far more confident lie than a blank. While not ready the shares render as a dash
   * over a pulsing bar, and no max/min arc or current-digit highlight is claimed.
   */
  ready?: boolean }) {
  const max = ready ? Math.max(...freqs) : 0;
  const min = ready ? Math.min(...freqs) : 0;
  return (
    <div className="grid grid-cols-10 gap-[3px] lg:flex lg:items-start lg:justify-between lg:gap-0 lg:px-1" aria-label="Last digit statistics">
      {freqs.map((f, d) => {
        const isMax = ready && max > 0 && f === max && max !== min;
        const isMin = ready && max !== min && f === min;
        const isCurrent = ready && current === d;
        return (
          <div
            key={d}
            className="flex min-w-0 flex-col items-center gap-1"
            aria-label={ready ? `Digit ${d}: ${f.toFixed(1)}%${isCurrent ? ', latest' : ''}` : `Digit ${d}: counting ticks`}
          >
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
              {ready ? `${f.toFixed(1)}%` : <span className="inline-block h-2 w-5 animate-pulse rounded bg-surface-2 align-middle" />}
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

'use client';

import { cn } from '@/lib/cn';

/**
 * Deriv-style last-digit statistics: the frequency (%) of each digit 0-9 across the recent tick
 * window, rendered as the outlined-circle row from the digits-broker design.
 *
 * MOBILE-FIRST / FLUID: the ten digits live in a `grid-cols-10` and each circle is `aspect-square
 * w-full`, so the row ALWAYS fits the viewport exactly (no horizontal overflow / clipping) and the
 * circles scale with the available width — from a 320px phone up to a wide panel.
 *
 *  - Every digit is an outlined circle with its frequency % underneath.
 *  - The CURRENT (latest) digit gets an accent ring + an amber pointer triangle beneath it.
 *  - The HOTTEST digit reads accent-green, the COLDEST reads red (with a red top-right arc).
 *  - When `selectable` the circles act as a digit picker (Matches/Differs & Over/Under barrier).
 *
 * Purely presentational + a picker; all colours come from brand tokens so it re-skins per client.
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
    <div className="grid grid-cols-10 gap-[2px] xs:gap-1">
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
            aria-label={`Digit ${d}, ${f.toFixed(1)}%`}
            className={cn(
              'flex min-w-0 flex-col items-center gap-0.5 transition',
              selectable ? 'cursor-pointer' : 'cursor-default',
            )}
          >
            {/* the circle — fluid: fills its grid column, stays perfectly round via aspect-square */}
            <span
              className={cn(
                'relative flex aspect-square w-full items-center justify-center rounded-full border-[1.5px] text-[clamp(12px,3.6vw,17px)] font-bold leading-none tabular-nums',
                'border-border bg-surface text-fg',
                isMax && !isCurrent && !isSelected ? 'border-up/70' : '',
                isMin && !isCurrent && !isSelected ? 'border-down/70' : '',
                isCurrent && !isSelected ? 'border-accent text-fg ring-2 ring-accent/25' : '',
                isSelected ? 'border-accent bg-accent/20 text-fg' : '',
                selectable && !isSelected ? 'hover:border-accent/70' : '',
              )}
            >
              {d}
              {/* coldest digit: red top-right arc, mirroring the reference indicator */}
              {isMin && !isCurrent && !isSelected ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-[1.5px] rounded-full"
                  style={{
                    background:
                      'conic-gradient(from -55deg, var(--pp-down) 0 34%, transparent 34% 100%)',
                    WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                    mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                  }}
                />
              ) : null}
            </span>

            {/* frequency % */}
            <span
              className={cn(
                'whitespace-nowrap text-[clamp(8px,2.6vw,11px)] font-semibold leading-none tabular-nums',
                isMax ? 'text-up' : isMin ? 'text-down' : 'text-muted',
              )}
            >
              {f.toFixed(1)}%
            </span>

            {/* current-digit pointer (amber triangle) */}
            {isCurrent ? (
              <span
                aria-hidden
                className="h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent"
                style={{ borderTopColor: 'var(--pp-warn)' }}
              />
            ) : (
              <span aria-hidden className="h-0 w-0 border-t-[6px] border-transparent" />
            )}
          </button>
        );
      })}
    </div>
  );
}

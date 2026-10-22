'use client';

import { cn } from '@/lib/cn';
import { phaseCopy, phaseNeedsRetry, type DataPhase } from '@/lib/ui/dataPhase';

/**
 * What a chart area shows while it has nothing to draw.
 *
 * Every shell used to mount its chart library into a bare container and wait, so a socket that was
 * still connecting produced a full-height void — on a money product that reads as a broken page, or
 * worse. This gives the area a SHAPE (a drifting candle/line skeleton) plus a line of plain text
 * saying what is happening, so the player can tell "loading" from "broken" at a glance.
 *
 * It paints from the brand tokens, so it wears each brand's own colours like the rest of the shell.
 * `variant="terminal"` swaps to the broker's `--mt5-*` palette, because MetaTrader chrome is its own
 * identity and a brand-coloured placeholder inside it would look like a foreign screen.
 */
export function ChartPlaceholder({
  phase,
  subject,
  variant = 'brand',
  showSkeleton = true,
  onRetry,
  className,
}: {
  phase: DataPhase;
  /** What is being fetched, for the copy: 'market data' (default), 'your chart', 'ticks'. */
  subject?: string;
  variant?: 'brand' | 'terminal';
  /**
   * False drops the candle skeleton and leaves the words alone.
   *
   * Used by the MARKETER wave, whose whole point is that it must not read as a trading chart — a
   * row of pulsing candles there would reinstate exactly the tell the neutralised curve removes.
   */
  showSkeleton?: boolean;
  /**
   * Ask again. Drawn ONLY in the `failed` phase (see `phaseNeedsRetry`), because that is the one
   * state nothing resolves by itself — every other phase is already retrying, and a button there
   * would invite the player to "fix" something that is in hand.
   */
  onRetry?: () => void;
  className?: string;
}) {
  const { title, detail } = phaseCopy(phase, subject);
  const terminal = variant === 'terminal';

  // Seven bars at fixed heights: a deterministic shape, so it cannot differ between the server and
  // the first client paint (a random skeleton is a hydration mismatch waiting to happen).
  const bars = [38, 62, 48, 74, 56, 84, 66];

  return (
    <div
      className={cn(
        /*
          `z-10` is load-bearing, not decoration. Every chart library here mounts positioned canvases
          with their own stacking, and lightweight-charts paints its background as an OPAQUE fill —
          so an un-indexed sibling, even one declared after it, is painted over and the pane looks
          exactly as blank as it did before this component existed. Verified: without it the
          placeholder measures 800x772, reports `visibility: visible`, and is invisible on screen.
        */
        'absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-6',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {/* The skeleton: a row of pulsing candles. Low contrast on purpose — it is scaffolding, not
          content, and must never be mistaken for real prices.

          It does NOT pulse once the request has failed: a pulse is the page saying "working on it",
          and animating under a message that says nothing more is coming is the same lie the
          five-minute spinner told, just quieter. */}
      {showSkeleton ? (
        <div className="flex h-24 w-full max-w-[280px] items-end justify-center gap-2" aria-hidden>
          {bars.map((h, i) => (
            <div
              key={h}
              className={cn(
                'w-3 rounded-sm',
                phaseNeedsRetry(phase) ? 'opacity-50' : 'animate-pulse',
                terminal ? 'bg-[var(--mt5-border)]' : 'bg-surface-2',
              )}
              style={{ height: `${h}%`, animationDelay: `${i * 110}ms` }}
            />
          ))}
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-1 text-center">
        <p className={cn('text-sm font-semibold', terminal ? 'text-[var(--mt5-text)]' : 'text-fg')}>
          {title}
        </p>
        <p className={cn('max-w-[34ch] text-xs', terminal ? 'text-[var(--mt5-muted)]' : 'text-muted')}>
          {detail}
        </p>

        {phaseNeedsRetry(phase) && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              // 36px tall and 100px wide: a real touch target, because the one person who sees this
              // is already having a bad time on a phone.
              'mt-2 inline-flex h-9 min-w-[100px] items-center justify-center rounded-lg px-4 text-xs font-semibold',
              'transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              terminal
                ? 'border border-[var(--mt5-border)] text-[var(--mt5-text)] hover:bg-[var(--mt5-border)]/30'
                : 'border border-border text-fg hover:bg-fg/5',
            )}
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

'use client';

import { cn } from '@/lib/cn';
import { connBadge } from '@/lib/ui/dataPhase';
import type { ConnStatus } from '@/lib/game/types';

/**
 * The connection dot, with or without its word.
 *
 * Four surfaces had grown their own copy of the same ternary (`PriceHeader`, `MarketWatch`,
 * `MT5Toolbox`, `MT5MobileTrade`) and a fifth — the candlestick quote band — skipped the ternary
 * entirely and hardcoded a pulsing "LIVE". One definition instead, so a dead feed can never be
 * painted as a live one, and so the dot always carries a text equivalent for a screen reader.
 *
 * `variant="terminal"` takes MetaTrader's palette: the broker shell is its own identity and a
 * brand-coloured dot in its chrome would read as a foreign widget.
 */
export function LiveBadge({
  status,
  showLabel = true,
  variant = 'brand',
  dotClassName,
  labelClassName,
  className,
}: {
  status: ConnStatus;
  /** False renders the dot alone — for bands too narrow for a word (the MT5 toolbox, a row header). */
  showLabel?: boolean;
  variant?: 'brand' | 'terminal';
  dotClassName?: string;
  labelClassName?: string;
  className?: string;
}) {
  const { label, tone, pulse, hint } = connBadge(status);
  const terminal = variant === 'terminal';

  const dotTone = terminal
    ? { up: 'bg-[var(--mt5-green)]', warn: 'bg-[var(--mt5-amber)]', down: 'bg-[var(--mt5-red)]' }[tone]
    : { up: 'bg-up', warn: 'bg-warn', down: 'bg-down' }[tone];
  const textTone = terminal
    ? { up: 'text-[var(--mt5-green)]', warn: 'text-[var(--mt5-amber)]', down: 'text-[var(--mt5-red)]' }[tone]
    : { up: 'text-up', warn: 'text-warn', down: 'text-down' }[tone];

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={hint}>
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotTone, pulse && 'animate-pulse', dotClassName)}
        aria-hidden
      />
      {showLabel ? (
        <span className={cn('text-[10px] font-bold tracking-widest', textTone, labelClassName)}>{label}</span>
      ) : null}
      {/* The dot is 6px and `title` never fires on touch, so the state is always also readable. */}
      <span className="sr-only">{hint}</span>
    </span>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { CURVE_AMPLITUDE, CURVE_BASE_RATE } from '@invest254/shared/config';
import { cn } from '@/lib/cn';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { useSession } from '@/lib/auth/session';
import { useOnlineDisplay } from '@/lib/game/onlineDisplay';
import { useBrand } from '@/lib/brand/BrandProvider';

/** Signed display value the chart plots: rate = BASE + AMP * value. */
const toValue = (rate: number) => (rate - CURVE_BASE_RATE) / CURVE_AMPLITUDE;
const fmt = (v: number) => v.toFixed(4);
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * Headline price strip (mobile-first): BTC/KES signed value + % pill, with
 * 24H high/low (window extremes) and the live online count on the right.
 * The number is the game's synthetic curve value, not a real BTC price.
 */
export function PriceHeader() {
  const { getTicks, getLastTick, online, status } = useGameSocket();
  const role = useSession((s) => s.user?.role);
  // Staff see the real concurrency; everyone else sees a believable, gently
  // fluctuating crowd figure (social proof) — never the raw dev/low value.
  const displayOnline = useOnlineDisplay(online, role);
  const quote = useBrand().currency || 'KES';
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);

  const last = getLastTick();
  const value = last ? toValue(last.rate) : null;

  let hi: number | null = null;
  let lo: number | null = null;
  const ticks = getTicks();
  if (ticks.length > 0) {
    let mx = -Infinity;
    let mn = Infinity;
    for (const t of ticks) {
      const v = toValue(t.rate);
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    hi = mx;
    lo = mn;
  }

  const up = (value ?? 0) >= 0;
  const statusDot = status === 'open' ? 'bg-up' : status === 'connecting' ? 'bg-warn' : 'bg-down';

  return (
    <div className="shrink-0 rounded-xl border border-border bg-surface px-3 py-1.5">
      {/* Single compact row: pair + live | price + % | 24H stats + online. Keeps the chart tall. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDot)} title={status === 'open' ? 'Live' : status === 'connecting' ? 'Syncing' : 'Offline'} aria-label={status} />
          <span className="text-xs font-semibold text-fg">BTC/{quote}</span>
          <span className={cn('ml-1 font-mono text-lg font-bold leading-none tabular-nums', up ? 'text-up' : 'text-down')}>
            {value !== null ? fmt(value) : '\u2014'}
          </span>
          {value !== null ? (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                up ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
              )}
            >
              {signed(value * 100)}%
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-right">
          <Stat className="hidden sm:flex" label="24H H" value={hi !== null ? fmt(hi) : '\u2014'} />
          <Stat className="hidden sm:flex" label="24H L" value={lo !== null ? fmt(lo) : '\u2014'} />
          <Stat
            label="Online"
            valueClassName="text-up"
            value={displayOnline > 0 ? displayOnline.toLocaleString('en-KE') : '\u2014'}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  valueClassName,
}: {
  label: string;
  value: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn('flex flex-col leading-none', className)}>
      <span className="text-[9px] font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className={cn('mt-0.5 text-[11px] font-semibold tabular-nums text-fg', valueClassName)}>{value}</span>
    </div>
  );
}

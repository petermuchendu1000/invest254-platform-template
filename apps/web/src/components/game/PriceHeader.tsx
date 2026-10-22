'use client';

import { useEffect, useState } from 'react';
import { CURVE_AMPLITUDE, CURVE_BASE_RATE } from '@invest254/shared/config';
import { valueOfRate } from '@invest254/shared/candles';
import { cn } from '@/lib/cn';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { useSession } from '@/lib/auth/session';
import { useOnlineDisplay } from '@/lib/game/onlineDisplay';
import { useBrand } from '@/lib/brand/BrandProvider';
import { valueIsStale } from '@/lib/ui/dataPhase';
import { LiveBadge } from '@/components/ui/LiveBadge';

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
  const { getTicks, getLastTick, online, status, getMarket } = useGameSocket();
  const role = useSession((s) => s.user?.role);
  // Staff see the real concurrency; everyone else sees a believable, gently
  // fluctuating crowd figure (social proof) — never the raw dev/low value.
  const displayOnline = useOnlineDisplay(online, role);
  const quote = useBrand().currency || 'KES';
  // Re-render only when a new tick arrives (was 4 renders/s, each re-scanning the whole buffer).
  const [, force] = useState(0);
  useEffect(() => {
    let lastT = -1;
    const id = setInterval(() => { const t = getLastTick()?.t ?? -1; if (t !== lastT) { lastT = t; force((n) => (n + 1) % 1_000_000); } }, 250);
    return () => clearInterval(id);
  }, [getLastTick]);

  const last = getLastTick();
  // Candlestick brands quote a real instrument. Once the chart's first history reply has landed, the
  // strip speaks the same language as the chart below it — symbol, price and the day's change — so
  // the two cannot disagree. Until then (and on line brands) it keeps the raw curve value.
  const market = getMarket();
  const priceOfTick = (rate: number) =>
    market!.anchor.base + market!.instrument.scale * (valueOfRate(rate) - market!.anchor.openValue);

  const value = last ? (market ? priceOfTick(last.rate) : toValue(last.rate)) : null;

  let hi: number | null = null;
  let lo: number | null = null;
  const ticks = getTicks();
  if (ticks.length > 0) {
    let mx = -Infinity;
    let mn = Infinity;
    for (const t of ticks) {
      const v = market ? priceOfTick(t.rate) : toValue(t.rate);
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    hi = mx;
    lo = mn;
  }

  const pair = market ? market.instrument.symbol : `BTC/${quote}`;
  // On a real instrument "change" is against the day's OPEN, which is exactly the anchor base.
  const changePct = market && value !== null && market.anchor.base
    ? ((value - market.anchor.base) / market.anchor.base) * 100
    : (value ?? 0) * 100;
  const show = (v: number) => (market ? v.toFixed(market.instrument.digits) : fmt(v));
  const up = changePct >= 0;
  /**
   * The tick buffer survives a disconnect, so `value`, the % pill and H/L keep printing the last
   * figures received — at `text-lg font-bold`, with the 8px dot as the only cue, and that cue is a
   * `title` tooltip no touch device will ever show. Dimmed and labelled instead: the number is
   * still useful (it is the last real price) but it is no longer passed off as the current one.
   */
  const stale = valueIsStale(status);

  return (
    <div className="shrink-0 rounded-xl border border-border bg-surface px-3 py-1.5">
      {/* Single compact row: pair + live | price + % | 24H stats + online. Keeps the chart tall. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <LiveBadge status={status} showLabel={false} dotClassName="h-2 w-2" />
          <span className="text-xs font-semibold text-fg">{pair}</span>
          <span
            className={cn(
              'ml-1 font-mono text-lg font-bold leading-none tabular-nums',
              up ? 'text-up' : 'text-down',
              stale && 'opacity-50',
            )}
          >
            {value !== null ? show(value) : '\u2014'}
          </span>
          {value !== null ? (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                up ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                stale && 'opacity-50',
              )}
            >
              {signed(changePct)}%
            </span>
          ) : null}
          {/* The word, because the dot alone is 2% of the area of the number it qualifies. */}
          {stale && value !== null ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              {status === 'connecting' ? 'syncing' : 'last known'}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-right">
          <Stat className={cn('hidden sm:flex', stale && 'opacity-50')} label="H" value={hi !== null ? show(hi) : '\u2014'} />
          <Stat className={cn('hidden sm:flex', stale && 'opacity-50')} label="L" value={lo !== null ? show(lo) : '\u2014'} />
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

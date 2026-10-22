'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes } from '@invest254/shared/money';
import { api } from '@/lib/api/endpoints';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useDisplayMoney } from '@/lib/money';
import { cn } from '@/lib/cn';

/** The mock's four chips, and the period each one asks the server for. */
const PERIODS = [
  { label: 'Today', key: 'today' },
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'This Week', key: 'week' },
  { label: 'This Month', key: 'month' },
] as const;

/**
 * The rail's Top tab: real traders, ranked by the net profit settlement already recorded for them.
 *
 * Ranked by NET profit rather than winnings, because a board that ranks by winnings puts whoever
 * staked most at the top whether or not they are up, and calling a losing player a top trader is
 * worse than having no board. Names are masked exactly as the feed masks them — a first name and
 * nothing else (see activity.pg.ts).
 *
 * A window with no profitable trader shows that it has none. The mock's equivalent never does,
 * because its rows are generated.
 */
export function TopTradersPane() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const brand = useBrand();
  const { isForeign, symbol, toDisplay } = useDisplayMoney();

  const { data, isPending } = useQuery({
    queryKey: ['siteLeaderboard', brand.slug, period.key],
    queryFn: () => api.siteLeaderboard(brand.slug, period.key),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const rows = data?.items ?? [];

  const money = (cents: number) =>
    isForeign
      ? `${symbol} ${toDisplay(cents).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : `KSh ${centsToKes(cents).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-4">
        <span className="truncate text-xs font-bold uppercase tracking-widest text-fg">Top Traders</span>
      </div>

      {/* The four periods are ~280px of chips at a finger-sized height, so this row SCROLLS rather
          than wraps — a wrapped second line pushes the board itself off a 320px screen. */}
      <div className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-3">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p)}
            className={cn(
              'flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-[10px] font-bold uppercase tracking-wide transition-colors',
              p.key === period.key ? 'bg-accent text-accent-fg' : 'bg-border text-muted hover:text-fg',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="scrollbar-none min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {isPending ? (
          // The mock's own loading row, which is where its skeleton markup came from.
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex animate-pulse items-center gap-2 rounded-lg bg-surface-2 p-2.5 sm:gap-3">
              <div className="h-4 w-5 shrink-0 rounded bg-border" />
              <div className="h-8 w-8 shrink-0 rounded-full bg-border" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-24 max-w-full rounded bg-border" />
                <div className="h-2.5 w-16 max-w-full rounded bg-border" />
              </div>
              <div className="h-3 w-14 shrink-0 rounded bg-border" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs italic text-muted">
            No trader is up {period.label.toLowerCase().startsWith('this') ? period.label.toLowerCase() : period.label.toLowerCase()} yet.
          </p>
        ) : (
          rows.map((r) => (
            // Rank, avatar and the profit are fixed; the NAME is the only thing allowed to give
            // way, so a long first name truncates instead of colliding with a six-figure amount.
            <div key={r.rank} className="flex items-center gap-2 rounded-lg bg-surface-2 p-2.5 sm:gap-3">
              <div className={cn('w-5 shrink-0 text-xs font-bold tabular-nums', r.rank <= 3 ? 'text-warn' : 'text-muted')}>{r.rank}</div>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-border text-xs font-bold text-fg">
                {r.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-fg">{r.name}</div>
                <div className="truncate text-[10px] text-muted">{r.trades} {r.trades === 1 ? 'trade' : 'trades'}</div>
              </div>
              <div className="shrink-0 whitespace-nowrap text-xs font-bold tabular-nums text-up">+{money(r.profitCents)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

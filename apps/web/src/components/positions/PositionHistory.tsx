'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { DisplayMoney as Money } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { usePositions, type PositionStatusFilter } from '@/lib/positions/hooks';
import type { PositionDto } from '@/lib/api/types';
import { PositionDetailModal } from '@/components/positions/PositionDetailModal';

const FILTERS: { key: PositionStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'settled', label: 'Settled' },
];

function resultClass(p: PositionDto): string {
  if (p.result === 'win') return 'text-up';
  if (p.result === 'loss') return 'text-down';
  return 'text-muted';
}

function resultLabel(p: PositionDto): string {
  if (p.status === 'open') return 'Open';
  if (p.result === 'win') return `Won ×${(p.multiplier ?? 1).toFixed(2)}`;
  if (p.result === 'loss') return 'Lost';
  return 'Void';
}

export function PositionHistory() {
  const [filter, setFilter] = useState<PositionStatusFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const q = usePositions(filter);

  const items: PositionDto[] = (q.data?.pages ?? []).flatMap((p) => p.items);

  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex w-full rounded-xl border border-border bg-surface p-1 sm:w-auto">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'h-9 flex-1 rounded-lg px-4 text-sm font-medium transition sm:flex-none',
              filter === f.key ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : q.isError ? (
        <p className="text-sm text-down">Couldn&apos;t load bet history.</p>
      ) : items.length === 0 ? (
        <EmptyState title="No bets yet" description="Your placed positions will show up here." />
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelected(p.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-border bg-surface p-3 text-left"
                >
                  <div className="flex flex-col">
                    <span className={cn('text-sm font-semibold uppercase', p.direction === 'buy' ? 'text-up' : 'text-down')}>
                      {p.direction}
                    </span>
                    <span className="text-xs text-muted">{formatDateTime(p.openedAt)}</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className={cn('text-sm font-medium', resultClass(p))}>{resultLabel(p)}</span>
                    {p.pnlCents !== null ? (
                      <Money cents={p.pnlCents} className={cn('text-xs', resultClass(p))} />
                    ) : (
                      <Money cents={p.stakeCents} className="text-xs text-muted" />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <div className="hidden md:block">
            <div className="table-wrapper overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Direction</th>
                    <th className="px-4 py-2 font-medium">Stake</th>
                    <th className="px-4 py-2 font-medium">Result</th>
                    <th className="px-4 py-2 font-medium">P&L</th>
                    <th className="px-4 py-2 font-medium">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setSelected(p.id)}
                      className="cursor-pointer border-t border-border hover:bg-surface-2/40"
                    >
                      <td className={cn('px-4 py-2 font-medium uppercase', p.direction === 'buy' ? 'text-up' : 'text-down')}>
                        {p.direction}
                      </td>
                      <td className="px-4 py-2">
                        <Money cents={p.stakeCents} />
                      </td>
                      <td className={cn('px-4 py-2', resultClass(p))}>{resultLabel(p)}</td>
                      <td className="px-4 py-2">
                        {p.pnlCents !== null ? (
                          <Money cents={p.pnlCents} className={resultClass(p)} />
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted">{formatDateTime(p.openedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {q.hasNextPage ? (
            <Button variant="secondary" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      )}

      <PositionDetailModal id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

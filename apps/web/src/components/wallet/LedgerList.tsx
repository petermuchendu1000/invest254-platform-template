 'use client';

import { cn } from '@/lib/cn';
import { DisplayMoney as Money } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { useLedger } from '@/lib/wallet/hooks';
import type { LedgerEntryDto } from '@/lib/api/types';

export function LedgerList() {
  const q = useLedger();
  if (q.isLoading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (q.isError) return <p className="text-sm text-down">Couldn&apos;t load ledger.</p>;

  const items: LedgerEntryDto[] = (q.data?.pages ?? []).flatMap((p) => p.items);
  if (items.length === 0)
    return <EmptyState title="No ledger entries yet" description="Every balance change is recorded here." />;

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2 md:hidden">
        {items.map((e) => (
          <li key={e.id} className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium capitalize">{e.type.replace(/_/g, ' ')}</span>
              <span className="text-xs text-muted">
                {e.balanceKind} · {formatDateTime(e.ts)}
              </span>
            </div>
            <Money cents={e.amountCents} className={cn('font-medium', e.amountCents >= 0 ? 'text-up' : 'text-down')} />
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <div className="table-wrapper overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Wallet</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-4 py-2 capitalize">{e.type.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2 capitalize text-muted">{e.balanceKind}</td>
                  <td className="px-4 py-2">
                    <Money cents={e.amountCents} className={e.amountCents >= 0 ? 'text-up' : 'text-down'} />
                  </td>
                  <td className="px-4 py-2 text-muted">{formatDateTime(e.ts)}</td>
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
    </div>
  );
}

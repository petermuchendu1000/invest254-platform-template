 'use client';

import { cn } from '@/lib/cn';
import { DisplayMoney as Money } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/format';
import { useTransactions } from '@/lib/wallet/hooks';
import type { TransactionDto } from '@/lib/api/types';

export function TransactionsList() {
  const q = useTransactions();
  if (q.isLoading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (q.isError) return <p className="text-sm text-down">Couldn&apos;t load transactions.</p>;

  const items: TransactionDto[] = (q.data?.pages ?? []).flatMap((p) => p.items);
  if (items.length === 0)
    return <EmptyState title="No transactions yet" description="Your deposits and withdrawals appear here." />;

  return (
    <div className="flex flex-col gap-3">
      {/* Mobile: stacked cards */}
      <ul className="flex flex-col gap-2 md:hidden">
        {items.map((t) => (
          <li key={t.id} className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium capitalize">{t.kind}</span>
              <span className="text-xs text-muted">{formatDateTime(t.ts)}</span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Money cents={t.amountCents} className={cn('font-medium', t.kind === 'deposit' ? 'text-up' : 'text-down')} />
              <StatusBadge status={t.status} />
            </div>
          </li>
        ))}
      </ul>

      {/* md+: table */}
      <div className="hidden md:block">
        <div className="table-wrapper overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Receipt</th>
                <th className="px-4 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-4 py-2 capitalize">{t.kind}</td>
                  <td className="px-4 py-2">
                    <Money cents={t.amountCents} className={t.kind === 'deposit' ? 'text-up' : 'text-down'} />
                  </td>
                  <td className="px-4 py-2"><StatusBadge status={t.status} /></td>
                  <td className="px-4 py-2 text-muted">{t.mpesaReceipt ?? '—'}</td>
                  <td className="px-4 py-2 text-muted">{formatDateTime(t.ts)}</td>
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

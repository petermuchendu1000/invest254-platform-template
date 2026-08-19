'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatKes } from '@invest254/shared/money';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { useReferral, useMyCommissions, useRequestCommissionPayout } from '@/lib/affiliate/hooks';

/**
 * Deposit-based referral commissions (0078/0079). Shows the caller's earned / available / paid
 * balance and their commission line-items, and lets a marketer request a payout once the available
 * balance reaches the minimum (KES 500). Separate from the GGR affiliate payout stream.
 */
export function ReferralCommissionsCard() {
  const { data: summary, isLoading } = useReferral();
  const { data: commissions } = useMyCommissions();
  const requestPayout = useRequestCommissionPayout();
  const toast = useToast();

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!summary) return null;

  const canRequest = summary.availableCents >= summary.minPayoutCents;
  const items = commissions?.items ?? [];

  const onRequest = async () => {
    try {
      const r = await requestPayout.mutateAsync();
      toast.push({ tone: 'success', title: 'Payout requested', description: `${formatKes(r.amountCents)} — an admin will process it to your M-Pesa.` });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'BELOW_MIN') toast.push({ tone: 'error', title: 'Below minimum', description: `You need at least ${formatKes(summary.minPayoutCents)} to request a payout.` });
      else if (code === 'PAYOUT_PENDING') toast.push({ tone: 'error', title: 'Request pending', description: 'You already have a payout request pending.' });
      else toast.push({ tone: 'error', title: 'Could not request payout', description: 'Please try again.' });
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Referral commissions</h2>
        {summary.referralCode ? (
          <span className="rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {summary.referralCode}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Available" value={formatKes(summary.availableCents)} strong />
        <Stat label="Earned (lifetime)" value={formatKes(summary.earnedCents)} />
        <Stat label="Paid out" value={formatKes(summary.paidCents)} />
      </div>

      {summary.isMarketer ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Minimum payout {formatKes(summary.minPayoutCents)}. Requests are paid manually by an admin.
          </p>
          <Button onClick={onRequest} disabled={!canRequest || requestPayout.isPending} className="w-full sm:w-auto">
            {requestPayout.isPending ? 'Requesting…' : 'Request payout'}
          </Button>
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Recent commissions</h3>
        {items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No commissions yet. Share your referral link to start earning.</p>
        ) : (
          <div className="table-wrapper overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">From</th>
                  <th className="py-1 pr-3">Level</th>
                  <th className="py-1 pr-3 text-right">Deposit</th>
                  <th className="py-1 text-right">Commission</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="py-1.5 pr-3 text-gray-500 dark:text-gray-400">{formatDateTime(c.createdAtMs)}</td>
                    <td className="py-1.5 pr-3">{c.referredUsername ?? '—'}</td>
                    <td className="py-1.5 pr-3">{Math.round(c.rate * 100)}%</td>
                    <td className="py-1.5 pr-3 text-right text-gray-500 dark:text-gray-400">{formatKes(c.depositAmountCents)}</td>
                    <td className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100">{formatKes(c.commissionCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`mt-1 ${strong ? 'text-lg font-semibold' : 'text-base'} text-gray-900 dark:text-gray-100`}>{value}</div>
    </div>
  );
}

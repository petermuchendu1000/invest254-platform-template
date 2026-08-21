'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { ApiError } from '@/lib/api/client';
import { formatKes } from '@invest254/shared/money';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatRelativeTime } from '@/lib/format';
import { StatCard, TableWrap, Th, Td, Empty, Toolbar, FilterSelect, ConfirmButton } from '@/components/admin/ui';
import { useRowSelection, SelectAllCheckbox, RowCheckbox, BulkBar, downloadCsv, copyText } from '@/components/admin/BulkSelect';
import { RejectDialog } from '@/components/admin/RejectDialog';
import { useAffiliatePayouts, usePayoutAction, useBulkPayouts } from '@/lib/admin/hooks';
import type { AdminPayoutRow } from '@/lib/admin/types';

/*
 * AffiliatePayoutsPanel — the affiliate (GGR) commission payout queue, ported from the former
 * standalone /admin/affiliates page (consolidation A1) so NO function is lost: status filter,
 * per-page KPIs, row selection, bulk approve/reject, copy phones, CSV export, toasts. Enhancement:
 * single-row reject opens the RejectDialog (captures + persists a reason, migration 0098) instead of
 * a bare confirm. The reject dialog is rendered once at panel level (never inside a table row).
 */

const STATUS_OPTIONS = [
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
];

// Approve/reject act on payouts that haven't yet been dispatched.
const ACTIONABLE = new Set(['requested']);

export function AffiliatePayoutsPanel() {
  const [status, setStatus] = useState('requested');
  const q = useAffiliatePayouts(status || undefined);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const sel = useRowSelection(rows, (r) => r.payoutId);
  const bulk = useBulkPayouts();
  const rowAction = usePayoutAction();
  const toast = useToast();
  const [rejectingRow, setRejectingRow] = useState<AdminPayoutRow | null>(null);

  const totals = useMemo(() => {
    const amount = rows.reduce((s, r) => s + r.amountCents, 0);
    const awaiting = rows.filter((r) => ACTIONABLE.has(r.status.toLowerCase()));
    return { count: rows.length, amount, awaitingCount: awaiting.length, awaitingAmount: awaiting.reduce((s, r) => s + r.amountCents, 0) };
  }, [rows]);

  const selInfo = useMemo(() => {
    const amount = sel.selectedRows.reduce((s, r) => s + r.amountCents, 0);
    const actionable = sel.selectedRows.filter((r) => ACTIONABLE.has(r.status.toLowerCase()));
    return { amount, actionableIds: actionable.map((r) => r.payoutId), actionableAmount: actionable.reduce((s, r) => s + r.amountCents, 0) };
  }, [sel.selectedRows]);

  function runBulk(action: 'approve' | 'reject') {
    const payoutIds = selInfo.actionableIds;
    if (payoutIds.length === 0) {
      toast.push({ tone: 'error', title: 'Nothing actionable', description: 'Only requested payouts can be approved or rejected.' });
      return;
    }
    bulk.mutate(
      { action, payoutIds },
      {
        onSuccess: (res) => {
          toast.push({
            tone: res.failCount ? 'error' : 'success',
            title: `${res.okCount}/${res.total} ${action === 'approve' ? 'approved' : 'rejected'}`,
            description: res.failCount ? `${res.failCount} could not be actioned.` : action === 'approve' ? 'M-Pesa transfers dispatched.' : 'Commission holds released.',
          });
          sel.clear();
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Bulk action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  function rejectOne(reason?: string) {
    const r = rejectingRow;
    if (!r) return;
    rowAction.mutate(
      { id: r.payoutId, action: 'reject', ...(reason ? { reason } : {}) },
      {
        onSuccess: () => { toast.push({ tone: 'success', title: 'Payout rejected', description: 'Commission hold released.' }); setRejectingRow(null); },
        onError: (e) => toast.push({ tone: 'error', title: 'Action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  async function copyPhones() {
    const ok = await copyText(sel.selectedRows.map((r) => r.phone).join('\n'));
    toast.push({ tone: ok ? 'success' : 'error', title: ok ? 'Phone numbers copied' : 'Copy failed', description: `${sel.count} number(s)` });
  }
  function exportCsv() {
    downloadCsv(
      `affiliate-payouts-${status || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`,
      sel.selectedRows.map((r) => ({
        payoutId: r.payoutId, affiliateId: r.affiliateId, username: r.username, phone: r.phone,
        amountKES: (r.amountCents / 100).toFixed(2), status: r.status,
        approvedBy: r.approvedBy ?? '', requestedAt: new Date(r.createdAtMs).toISOString(),
      })),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-fg">Affiliate commission payouts (GGR)</h3>
          <p className="text-xs text-muted">Approval dispatches the M-Pesa B2C transfer; rejection releases the hold.</p>
        </div>
        <Toolbar>
          <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        </Toolbar>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load payouts" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="Nothing here" description={status === 'requested' ? 'No payouts awaiting review.' : 'No payouts match this filter.'} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Payouts shown" value={totals.count} />
            <StatCard label="Total value" money={totals.amount} />
            <StatCard label="Awaiting review" value={totals.awaitingCount} tone={totals.awaitingCount > 0 ? 'warn' : 'default'} />
            <StatCard label="Awaiting value" money={totals.awaitingAmount} tone={totals.awaitingCount > 0 ? 'warn' : 'default'} hint="held, pending payout" />
          </div>

          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th className="w-8"><SelectAllCheckbox allSelected={sel.allSelected} someSelected={sel.someSelected} onChange={sel.setAll} /></Th>
                <Th>Marketer</Th>
                <Th>Amount</Th>
                <Th>Phone</Th>
                <Th>Status</Th>
                <Th>Approved by</Th>
                <Th>Requested</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.payoutId} r={r} checked={sel.isSelected(r.payoutId)} onToggle={() => sel.toggle(r.payoutId)} onReject={() => setRejectingRow(r)} />
              ))}
            </tbody>
          </TableWrap>
          {q.hasNextPage ? (
            <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}

          <BulkBar
            count={sel.count}
            onClear={sel.clear}
            summary={<>Total <Money cents={selInfo.amount} /> · {selInfo.actionableIds.length} actionable (<Money cents={selInfo.actionableAmount} />)</>}
          >
            <ConfirmButton label={`Approve ${selInfo.actionableIds.length}`} confirmLabel="Pay out all" variant="primary" busy={bulk.isPending} disabled={selInfo.actionableIds.length === 0} onConfirm={() => runBulk('approve')} />
            <ConfirmButton label={`Reject ${selInfo.actionableIds.length}`} confirmLabel="Reject all" variant="outline" busy={bulk.isPending} disabled={selInfo.actionableIds.length === 0} onConfirm={() => runBulk('reject')} />
            <Button size="sm" variant="outline" onClick={copyPhones}>Copy phones</Button>
            <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
          </BulkBar>
        </>
      )}

      <RejectDialog
        open={!!rejectingRow}
        onClose={() => setRejectingRow(null)}
        busy={rowAction.isPending}
        title="Reject affiliate payout"
        subject={rejectingRow ? `@${rejectingRow.username} · ${formatKes(rejectingRow.amountCents)}` : undefined}
        consequence={
          <>
            No money is sent. The reserved commission is released back to{' '}
            <span className="font-medium text-fg">@{rejectingRow?.username}</span>&apos;s available balance, so they can
            request a new payout. This only affects a <span className="font-medium text-fg">requested</span> (pre-dispatch) payout.
          </>
        }
        onConfirm={rejectOne}
      />
    </div>
  );
}

function Row({ r, checked, onToggle, onReject }: { r: AdminPayoutRow; checked: boolean; onToggle: () => void; onReject: () => void }) {
  const action = usePayoutAction();
  const toast = useToast();
  const canAct = ACTIONABLE.has(r.status.toLowerCase());

  function approve() {
    action.mutate(
      { id: r.payoutId, action: 'approve' },
      {
        onSuccess: () => toast.push({ tone: 'success', title: 'Payout approved', description: 'M-Pesa transfer dispatched.' }),
        onError: (e) => toast.push({ tone: 'error', title: 'Action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <tr className={`border-b border-border last:border-0 ${checked ? 'bg-accent/5' : ''}`}>
      <Td><RowCheckbox checked={checked} onChange={onToggle} label={`Select ${r.username}`} /></Td>
      <Td>
        <span className="font-medium">@{r.username}</span>
        <span className="ml-2 font-mono text-xs text-muted">{r.affiliateId.slice(0, 8)}…</span>
      </Td>
      <Td className="font-medium tabular-nums"><Money cents={r.amountCents} /></Td>
      <Td className="tabular-nums">{r.phone}</Td>
      <Td><StatusBadge status={r.status} /></Td>
      <Td className="font-mono text-xs text-muted">{r.approvedBy ? `${r.approvedBy.slice(0, 8)}…` : '—'}</Td>
      <Td className="whitespace-nowrap text-xs text-muted">{formatRelativeTime(r.createdAtMs)} ago</Td>
      <Td className="text-right">
        {canAct ? (
          <span className="inline-flex items-center justify-end gap-1.5">
            <ConfirmButton label="Approve" confirmLabel="Pay out" variant="primary" busy={action.isPending} onConfirm={approve} />
            <Button size="sm" variant="outline" disabled={action.isPending} onClick={onReject}>Reject</Button>
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </Td>
    </tr>
  );
}

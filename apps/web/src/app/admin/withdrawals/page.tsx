'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { parseWithdrawalDeepLink } from '@/lib/admin/deeplink';
import Link from 'next/link';
import { WithdrawalAlertsToggle } from '@/components/admin/WithdrawalAlertsToggle';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatExact, formatRelativeTime } from '@/lib/format';
import { PageHeader, StatCard, Section, TableWrap, Th, Td, Empty, Toolbar, FilterSelect, ConfirmButton, PasswordConfirmButton } from '@/components/admin/ui';
import { useRowSelection, SelectAllCheckbox, RowCheckbox, BulkBar, downloadCsv, copyText } from '@/components/admin/BulkSelect';
import { useWithdrawals, useWithdrawalAction, useWithdrawalsEnabled, useSetWithdrawalsEnabled, useBulkWithdrawals } from '@/lib/admin/hooks';
import type { AdminWithdrawalRow } from '@/lib/admin/types';

// Filter values are the ACTUAL transaction statuses in the DB (a withdrawal is created 'pending',
// becomes 'processing' on approval/B2C dispatch, 'success' when paid, 'reversed' when rejected,
// 'failed' if the B2C fails). The labels are the operator-facing names.
const STATUS_OPTIONS = [
  { value: 'pending', label: 'Requested' },
  { value: 'processing', label: 'Approved (paying out)' },
  { value: 'success', label: 'Paid' },
  { value: 'reversed', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
  { value: '', label: 'All' },
];

// A withdrawal is actionable (approve / reject) only while it is still awaiting moderation.
const ACTIONABLE = new Set(['pending', 'requested']);
// "Mark as paid" applies while the payout is not yet finalised — an awaiting row OR one stuck in
// 'processing' because the provider's B2C result callback never arrived (Mega Pay / Daraja failure).
const MARKPAYABLE = new Set(['pending', 'requested', 'processing']);

/** Clickable player identity → user detail page. */
function UserCell({ userId, username }: { userId: string; username: string }) {
  return (
    <Link href={`/admin/users/${userId}`} className="group inline-flex flex-col leading-tight">
      <span className="font-medium text-accent group-hover:underline">@{username || 'unknown'}</span>
      <span className="font-mono text-[10px] text-muted">{userId.slice(0, 8)}…</span>
    </Link>
  );
}

/** Phone that dials on tap (mobile) and is copy-friendly on desktop. */
function PhoneCell({ phone, receipt }: { phone: string; receipt: string | null }) {
  return (
    <span className="flex flex-col leading-tight">
      <a href={`tel:${phone}`} className="tabular-nums text-fg hover:text-accent hover:underline">{phone}</a>
      {receipt ? <span className="font-mono text-[10px] text-muted">{receipt}</span> : null}
    </span>
  );
}

/** Exact timestamp (to the second) with a relative label underneath. */
function TimeCell({ ms }: { ms: number | null }) {
  if (ms == null) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col leading-tight">
      <span className="whitespace-nowrap text-xs font-medium text-fg" title={formatExact(ms)}>{formatExact(ms)}</span>
      <span className="text-[10px] text-muted">{formatRelativeTime(ms)} ago</span>
    </span>
  );
}

/** Lifetime money figure with a count / context hint underneath. */
function StackCell({ cents, hint, tone }: { cents: number; hint: string; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg';
  return (
    <span className="flex flex-col items-end leading-tight text-right">
      <span className={`text-sm font-semibold tabular-nums ${color}`}><Money cents={cents} /></span>
      <span className="text-[10px] text-muted">{hint}</span>
    </span>
  );
}

export default function WithdrawalsPage() {
  const [status, setStatus] = useState('pending');
  const q = useWithdrawals(status || undefined);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const sel = useRowSelection(rows, (r) => r.txId);
  const bulk = useBulkWithdrawals();
  const toast = useToast();

  // Deep link from a push notification (Issue 1): ?highlight=<txId>&do=<approve|reject>. docs/42 UI-4 —
  // a link NEVER acts: it only highlights the row and pre-opens a confirmation; the click executes.
  // (It used to reject on page load, so any link or prefetch could reject a withdrawal.)
  const deepAction = useWithdrawalAction();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [deepIntent, setDeepIntent] = useState<'approve' | 'reject' | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const d = parseWithdrawalDeepLink(window.location.search);
    setHighlightId(d.highlight);
    setDeepIntent(d.intent);
    if (d.intent) window.history.replaceState(null, '', window.location.pathname + d.cleanedSearch);
  }, []);
  const deepRow = useMemo(() => rows.find((r) => r.txId === highlightId) ?? null, [rows, highlightId]);
  function confirmDeepReject() {
    if (!highlightId) return;
    deepAction.mutate(
      { id: highlightId, action: 'reject' },
      {
        onSuccess: () => { setDeepIntent(null); toast.push({ tone: 'success', title: 'Withdrawal rejected', description: 'Funds returned to the player.' }); },
        onError: (e) => toast.push({ tone: 'error', title: 'Action failed', description: e instanceof ApiError ? e.message : 'Use the highlighted row to try again.' }),
      },
    );
  }

  // Summary over the rows loaded so far (labelled "loaded" so partial pages aren't mistaken for totals).
  const totals = useMemo(() => {
    const amount = rows.reduce((s, r) => s + r.amountCents, 0);
    const awaiting = rows.filter((r) => ACTIONABLE.has(r.status.toLowerCase()));
    const awaitingAmount = awaiting.reduce((s, r) => s + r.amountCents, 0);
    return { count: rows.length, amount, awaitingCount: awaiting.length, awaitingAmount };
  }, [rows]);

  // Live insight into the current SELECTION (drives the bulk bar + guards the money actions).
  const selInfo = useMemo(() => {
    const amount = sel.selectedRows.reduce((s, r) => s + r.amountCents, 0);
    const actionable = sel.selectedRows.filter((r) => ACTIONABLE.has(r.status.toLowerCase()));
    return { amount, actionableIds: actionable.map((r) => r.txId), actionableAmount: actionable.reduce((s, r) => s + r.amountCents, 0) };
  }, [sel.selectedRows]);

  function runBulk(action: 'approve' | 'reject', password?: string) {
    const txIds = selInfo.actionableIds;
    if (txIds.length === 0) {
      toast.push({ tone: 'error', title: 'Nothing actionable', description: 'Selected withdrawals are already processed.' });
      return;
    }
    bulk.mutate(
      { action, txIds, ...(password ? { password } : {}) },
      {
        onSuccess: (res) => {
          toast.push({
            tone: res.failCount ? 'error' : 'success',
            title: `${res.okCount}/${res.total} ${action === 'approve' ? 'approved' : 'rejected'}`,
            description: res.failCount ? `${res.failCount} could not be actioned.` : action === 'approve' ? 'M-Pesa payouts dispatched.' : 'Funds returned to players.',
          });
          sel.clear();
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Bulk action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  async function copyPhones() {
    const ok = await copyText(sel.selectedRows.map((r) => r.phone).join('\n'));
    toast.push({ tone: ok ? 'success' : 'error', title: ok ? 'Phone numbers copied' : 'Copy failed', description: `${sel.count} number(s)` });
  }
  function exportCsv() {
    downloadCsv(
      `withdrawals-${status || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`,
      sel.selectedRows.map((r) => ({
        txId: r.txId, username: r.username, phone: r.phone,
        amountKES: (r.amountCents / 100).toFixed(2), status: r.status,
        balanceKES: (r.balanceCents / 100).toFixed(2),
        lifetimeDepositsKES: (r.totalDepositsCents / 100).toFixed(2),
        lifetimeWithdrawalsKES: (r.totalWithdrawalsCents / 100).toFixed(2),
        requestedAt: r.createdAtMs ? new Date(r.createdAtMs).toISOString() : '',
      })),
    );
  }

  return (
    <>
      <PageHeader
        title="Withdrawals"
        subtitle="Review and action player withdrawal requests with full context — identity, balance and lifetime deposit/withdrawal history. Approval dispatches the M-Pesa B2C payout; rejection reverses the hold. Select rows for bulk approve/reject, copy or export."
        actions={
          <Toolbar>
            <WithdrawalAlertsToggle />
            <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          </Toolbar>
        }
      />

      <WithdrawalsSwitch />

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load withdrawals" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="Nothing here" description={status === 'pending' ? 'No withdrawals awaiting review.' : 'No withdrawals match this filter.'} />
      ) : (
        <>
          {deepIntent ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
              <div>
                <p className="font-medium">
                  {deepIntent === 'reject' ? 'Reject this withdrawal?' : 'Approve from the highlighted row'}
                </p>
                <p className="text-muted">
                  {deepRow
                    ? <>@{deepRow.username} · <Money cents={deepRow.amountCents} /> · {deepRow.phone}{ACTIONABLE.has(deepRow.status.toLowerCase()) ? '' : ` · already ${deepRow.status}`}</>
                    : 'You opened this from an alert. The request is highlighted below when it is on this page.'}
                  {deepIntent === 'approve' ? ' Approving pays out real money and needs the system owner password.' : ' Rejecting returns the held funds to the player.'}
                </p>
              </div>
              <span className="inline-flex gap-2">
                {deepIntent === 'reject' && (!deepRow || ACTIONABLE.has(deepRow.status.toLowerCase())) ? (
                  <ConfirmButton label="Reject withdrawal" confirmLabel="Confirm reject" variant="outline" busy={deepAction.isPending} onConfirm={confirmDeepReject} />
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setDeepIntent(null)}>Dismiss</Button>
              </span>
            </div>
          ) : null}

          <Section title="Loaded on this page">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Withdrawals shown" value={totals.count} />
              <StatCard label="Total value" money={totals.amount} />
              <StatCard label="Awaiting review" value={totals.awaitingCount} tone={totals.awaitingCount > 0 ? 'warn' : 'default'} />
              <StatCard label="Awaiting value" money={totals.awaitingAmount} tone={totals.awaitingCount > 0 ? 'warn' : 'default'} hint="held, pending payout" />
            </div>
          </Section>

          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th className="w-8"><SelectAllCheckbox allSelected={sel.allSelected} someSelected={sel.someSelected} onChange={sel.setAll} /></Th>
                <Th>Player</Th>
                <Th className="text-right">Amount</Th>
                <Th>M-Pesa</Th>
                <Th>Status</Th>
                <Th className="text-right">Balance</Th>
                <Th className="text-right">Deposits</Th>
                <Th className="text-right">Withdrawals</Th>
                <Th className="text-right">Net cash</Th>
                <Th>Requested</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.txId} r={r} checked={sel.isSelected(r.txId)} onToggle={() => sel.toggle(r.txId)} highlighted={r.txId === highlightId} />
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
            <PasswordConfirmButton label={`Approve ${selInfo.actionableIds.length}`} confirmLabel="Authorize payout" variant="primary" busy={bulk.isPending} disabled={selInfo.actionableIds.length === 0} onConfirm={(pw) => runBulk('approve', pw)} />
            <ConfirmButton label={`Reject ${selInfo.actionableIds.length}`} confirmLabel="Reject all" variant="outline" busy={bulk.isPending} disabled={selInfo.actionableIds.length === 0} onConfirm={() => runBulk('reject')} />
            <Button size="sm" variant="outline" onClick={copyPhones}>Copy phones</Button>
            <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
          </BulkBar>
        </>
      )}
    </>
  );
}

/** Owner/admin kill switch: halt or resume ALL withdrawals for this brand (override). */
function WithdrawalsSwitch() {
  const q = useWithdrawalsEnabled();
  const setEnabled = useSetWithdrawalsEnabled();
  const toast = useToast();
  const enabled = q.data?.enabled ?? true;

  if (q.isLoading) return <div className="mb-4"><Skeleton className="h-16 w-full" /></div>;

  const flip = () =>
    setEnabled.mutate(!enabled, {
      onSuccess: (r) =>
        toast.push({
          tone: r.enabled ? 'success' : 'error',
          title: r.enabled ? 'Withdrawals enabled' : 'Withdrawals DISABLED',
          description: r.enabled ? 'Payouts resume for this brand.' : 'All new withdrawals (players + marketers) are halted.',
        }),
      onError: (e) => toast.push({ tone: 'error', title: "Couldn't change setting", description: e instanceof ApiError ? e.message : 'Try again.' }),
    });

  return (
    <div className={`mb-4 flex items-center justify-between gap-3 rounded-2xl border p-4 ${enabled ? 'border-up/30 bg-up/5' : 'border-down/40 bg-down/10'}`}>
      <div className="flex flex-col">
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className={`inline-flex h-2.5 w-2.5 rounded-full ${enabled ? 'bg-up' : 'bg-down'}`} />
          {enabled ? 'Withdrawals are ENABLED' : 'Withdrawals are DISABLED'}
        </span>
        <span className="mt-0.5 max-w-2xl text-xs text-muted">
          {enabled
            ? 'Payouts are processing normally. Turn OFF to immediately halt ALL withdrawals for this brand — player requests and marketer instant transfers — to override a malfunction or prevent payouts beyond the pool.'
            : 'All new withdrawals are refused for this brand (players + marketers). Existing pending requests can still be reviewed manually. Turn ON to resume payouts.'}
        </span>
      </div>
      <button
        type="button"
        onClick={flip}
        disabled={setEnabled.isPending}
        aria-pressed={enabled}
        aria-label={enabled ? 'Disable withdrawals' : 'Enable withdrawals'}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-50 ${enabled ? 'bg-up' : 'bg-down'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

function Row({ r, checked, onToggle, highlighted = false }: { r: AdminWithdrawalRow; checked: boolean; onToggle: () => void; highlighted?: boolean }) {
  const action = useWithdrawalAction();
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlighted]);
  const toast = useToast();
  const canAct = ACTIONABLE.has(r.status.toLowerCase());
  const canMarkPaid = MARKPAYABLE.has(r.status.toLowerCase());
  // Net cash the house is up on this player: lifetime deposits minus lifetime paid withdrawals.
  const netCents = r.totalDepositsCents - r.totalWithdrawalsCents;

  function run(act: 'approve' | 'reject' | 'mark-paid', password?: string) {
    action.mutate(
      { id: r.txId, action: act, ...(password ? { password } : {}) },
      {
        onSuccess: () =>
          toast.push({
            tone: 'success',
            title: act === 'approve' ? 'Withdrawal approved' : act === 'mark-paid' ? 'Marked as paid' : 'Withdrawal rejected',
            description: act === 'approve' ? 'M-Pesa payout dispatched.'
              : act === 'mark-paid' ? 'Recorded as paid — the player now sees this withdrawal as complete.'
                : 'Funds returned to the player.',
          }),
        onError: (e) =>
          toast.push({ tone: 'error', title: 'Action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <tr ref={rowRef} aria-current={highlighted ? 'true' : undefined} className={`border-b border-border last:border-0 hover:bg-surface-2/50 ${checked ? 'bg-accent/5' : ''} ${highlighted ? 'outline outline-2 -outline-offset-2 outline-accent' : ''}`}>
      <Td><RowCheckbox checked={checked} onChange={onToggle} label={`Select ${r.username}`} /></Td>
      <Td><UserCell userId={r.userId} username={r.username} /></Td>
      <Td className="text-right font-semibold tabular-nums"><Money cents={r.amountCents} /></Td>
      <Td><PhoneCell phone={r.phone} receipt={r.mpesaReceipt} /></Td>
      <Td><StatusBadge status={r.status} /></Td>
      <Td className="text-right">
        <StackCell cents={r.balanceCents} hint="current" />
      </Td>
      <Td className="text-right">
        <StackCell
          cents={r.totalDepositsCents}
          tone="up"
          hint={r.depositCount === 0
            ? 'never funded'
            : `${r.depositCount} dep · since ${r.firstDepositAtMs ? formatExact(r.firstDepositAtMs).slice(0, 10) : '—'}`}
        />
      </Td>
      <Td className="text-right">
        <StackCell cents={r.totalWithdrawalsCents} tone="down" hint={`${r.withdrawalCount} paid`} />
      </Td>
      <Td className="text-right">
        <StackCell cents={netCents} tone={netCents >= 0 ? 'up' : 'down'} hint={netCents >= 0 ? 'net depositor' : 'net winner'} />
      </Td>
      <Td><TimeCell ms={r.createdAtMs} /></Td>
      <Td className="text-right">
        {canAct || canMarkPaid ? (
          <span className="inline-flex items-center justify-end gap-1.5">
            {canAct ? (
              <PasswordConfirmButton label="Approve" confirmLabel="Authorize payout" variant="primary" busy={action.isPending} onConfirm={(pw) => run('approve', pw)} />
            ) : null}
            {canAct ? (
              <ConfirmButton label="Reject" confirmLabel="Reject" variant="outline" busy={action.isPending} onConfirm={() => run('reject')} />
            ) : null}
            {canMarkPaid ? (
              <PasswordConfirmButton
                label="Mark paid"
                confirmLabel="Confirm paid"
                variant={canAct ? 'outline' : 'primary'}
                busy={action.isPending}
                onConfirm={(pw) => run('mark-paid', pw)}
              />
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </Td>
    </tr>
  );
}

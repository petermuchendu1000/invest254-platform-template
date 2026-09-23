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
import { formatExact, formatAgo } from '@/lib/format';
import { PageHeader, TableWrap, Th, Td, Empty, Toolbar, FilterSelect, ConfirmButton, PasswordConfirmButton } from '@/components/admin/ui';
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
    <Link href={`/admin/users/${userId}`} className="font-medium text-accent hover:underline">@{username || 'unknown'}</Link>
  );
}

/** Exact timestamp (to the second) with a relative label underneath. */
function TimeCell({ ms }: { ms: number | null }) {
  if (ms == null) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col leading-tight">
      <span className="whitespace-nowrap text-xs font-medium text-fg" title={formatExact(ms)}>{formatExact(ms)}</span>
      <span className="text-[10px] text-muted">{formatAgo(ms)}</span>
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
        subtitle="Approve to pay the player by M-Pesa, or reject to return the money to their balance."
        actions={<WithdrawalAlertsToggle />}
      />

      <WithdrawalsSwitch />

      <Toolbar>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        {rows.length > 0 ? (
          <span className="text-sm text-muted">
            {totals.awaitingCount > 0
              ? <><b className="font-semibold text-warn">{totals.awaitingCount} awaiting review</b> · <Money cents={totals.awaitingAmount} /> held</>
              : <>{totals.count} shown · <Money cents={totals.amount} /></>}
            {q.hasNextPage ? ' (more below)' : ''}
          </span>
        ) : null}
      </Toolbar>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load withdrawals" description="Check your connection, then reload the page." />
      ) : rows.length === 0 ? (
        <Empty title={status === 'pending' ? 'No withdrawals waiting' : 'Nothing here'} description={status === 'pending' ? 'New requests appear here as players ask to withdraw.' : 'No withdrawals match this filter.'} />
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

          {/* UI-C: desktop table with the actions pinned to the right edge (Reject / Mark paid were
              cut off at 1440px), and a card list on phones (the table needed sideways scrolling to act). */}
          <div className="hidden md:block">
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <Th className="w-8"><SelectAllCheckbox allSelected={sel.allSelected} someSelected={sel.someSelected} onChange={sel.setAll} /></Th>
                  <Th>Player</Th>
                  <Th numeric>Amount</Th>
                  <Th>Status</Th>
                  <Th numeric>Balance</Th>
                  <Th numeric>Lifetime</Th>
                  <Th>Requested</Th>
                  <Th className="sticky right-0 bg-surface text-right shadow-[-8px_0_12px_-10px_rgba(0,0,0,0.6)]">Action</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.txId} r={r} checked={sel.isSelected(r.txId)} onToggle={() => sel.toggle(r.txId)} highlighted={r.txId === highlightId} />
                ))}
              </tbody>
            </TableWrap>
          </div>
          <ul className="flex flex-col gap-3 md:hidden" aria-label="Withdrawals">
            {rows.map((r) => (
              <CardRow key={r.txId} r={r} checked={sel.isSelected(r.txId)} onToggle={() => sel.toggle(r.txId)} highlighted={r.txId === highlightId} />
            ))}
          </ul>
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

  // UI-C: a compact status row (it used to be a large banner bigger than the queue it controls).
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${enabled ? 'border-border bg-surface' : 'border-down/40 bg-down/10'}`}>
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className={`inline-flex h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-up' : 'bg-down'}`} />
          {enabled ? 'Withdrawals are on for this brand' : 'Withdrawals are OFF for this brand'}
        </span>
        <span className="mt-0.5 text-xs text-muted">
          {enabled
            ? 'Turn off to stop all new withdrawals (players and marketers) straight away.'
            : 'New requests are refused. You can still review the pending ones below.'}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        onClick={flip}
        disabled={setEnabled.isPending}
        aria-checked={enabled}
        aria-label={enabled ? 'Turn withdrawals off' : 'Turn withdrawals on'}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${enabled ? 'bg-up' : 'bg-down'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

/** Approve / reject / mark-paid for one withdrawal (shared by the table row and the phone card). */
function useRowActions(r: AdminWithdrawalRow) {
  const action = useWithdrawalAction();
  const toast = useToast();
  const canAct = ACTIONABLE.has(r.status.toLowerCase());
  const canMarkPaid = MARKPAYABLE.has(r.status.toLowerCase());
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
  const node = canAct || canMarkPaid ? (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {canAct ? <PasswordConfirmButton label="Approve" confirmLabel="Authorize payout" variant="primary" busy={action.isPending} onConfirm={(pw) => run('approve', pw)} /> : null}
      {canAct ? <ConfirmButton label="Reject" confirmLabel="Reject" variant="outline" busy={action.isPending} onConfirm={() => run('reject')} /> : null}
      {canMarkPaid ? (
        <PasswordConfirmButton label="Mark paid" confirmLabel="Confirm paid" variant={canAct ? 'ghost' : 'primary'} busy={action.isPending} onConfirm={(pw) => run('mark-paid', pw)} />
      ) : null}
    </span>
  ) : <span className="text-xs text-muted">—</span>;
  return node;
}

/** Lifetime cash for the player: deposited, paid out and the net (coloured only when it is not zero). */
function Lifetime({ r }: { r: AdminWithdrawalRow }) {
  const net = r.totalDepositsCents - r.totalWithdrawalsCents;
  return (
    <span className="flex flex-col items-end text-xs leading-5">
      <span title={r.depositCount ? `${r.depositCount} deposit(s) since ${r.firstDepositAtMs ? formatExact(r.firstDepositAtMs).slice(0, 11) : '—'}` : 'never deposited'}>
        <span className="text-muted">In </span><Money cents={r.totalDepositsCents} />
      </span>
      <span title={`${r.withdrawalCount} withdrawal(s) paid`}><span className="text-muted">Out </span><Money cents={r.totalWithdrawalsCents} /></span>
      <span className={net > 0 ? 'text-up' : net < 0 ? 'text-down' : 'text-muted'} title={net >= 0 ? 'net depositor' : 'net winner'}>
        <span className="text-muted">Net </span><Money cents={net} />
      </span>
    </span>
  );
}

function PlayerCell({ r }: { r: AdminWithdrawalRow }) {
  return (
    <span className="flex flex-col leading-tight">
      <UserCell userId={r.userId} username={r.username} />
      <a href={`tel:${r.phone}`} className="mt-0.5 text-xs tabular-nums text-muted hover:text-accent hover:underline">{r.phone}</a>
      {r.mpesaReceipt ? <span className="font-mono text-[10px] text-muted">{r.mpesaReceipt}</span> : null}
    </span>
  );
}

function CardRow({ r, checked, onToggle, highlighted = false }: { r: AdminWithdrawalRow; checked: boolean; onToggle: () => void; highlighted?: boolean }) {
  const actions = useRowActions(r);
  return (
    <li className={`rounded-2xl border bg-surface p-4 ${highlighted ? 'border-accent' : checked ? 'border-accent/50' : 'border-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <RowCheckbox checked={checked} onChange={onToggle} label={`Select ${r.username}`} />
          <PlayerCell r={r} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-lg font-semibold"><Money cents={r.amountCents} /></span>
          <StatusBadge status={r.status} />
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted">Balance <Money cents={r.balanceCents} className="text-fg" /><br />Requested {r.createdAtMs ? formatAgo(r.createdAtMs) : '—'}</span>
        <Lifetime r={r} />
      </div>
      <div className="mt-3 flex justify-end">{actions}</div>
    </li>
  );
}

function Row({ r, checked, onToggle, highlighted = false }: { r: AdminWithdrawalRow; checked: boolean; onToggle: () => void; highlighted?: boolean }) {
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlighted]);
  const actions = useRowActions(r);
  return (
    <tr ref={rowRef} aria-current={highlighted ? 'true' : undefined} className={`group border-b border-border last:border-0 hover:bg-surface-2/50 ${checked ? 'bg-accent/5' : ''} ${highlighted ? 'outline outline-2 -outline-offset-2 outline-accent' : ''}`}>
      <Td><RowCheckbox checked={checked} onChange={onToggle} label={`Select ${r.username}`} /></Td>
      <Td><PlayerCell r={r} /></Td>
      <Td numeric className="font-semibold"><Money cents={r.amountCents} /></Td>
      <Td><StatusBadge status={r.status} /></Td>
      <Td numeric><Money cents={r.balanceCents} /></Td>
      <Td numeric><Lifetime r={r} /></Td>
      <Td><TimeCell ms={r.createdAtMs} /></Td>
      <Td className="sticky right-0 bg-surface text-right shadow-[-8px_0_12px_-10px_rgba(0,0,0,0.6)] group-hover:bg-surface-2">{actions}</Td>
    </tr>
  );
}

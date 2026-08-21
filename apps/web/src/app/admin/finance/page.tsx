'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { formatExact, formatRelativeTime } from '@/lib/format';
import { PageHeader, StatCard, Section, TableWrap, Th, Td, Empty, Toolbar, FilterSelect } from '@/components/admin/ui';
import { useRowSelection, SelectAllCheckbox, RowCheckbox, BulkBar, downloadCsv, copyText } from '@/components/admin/BulkSelect';
import { useToast } from '@/lib/toast/ToastProvider';
import { useDepositsReconcile, useTransactions, useOverview } from '@/lib/admin/hooks';
import type { AdminTransactionRow } from '@/lib/admin/types';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

const KIND_OPTIONS = [
  { value: '', label: 'Deposits & withdrawals' },
  { value: 'deposit', label: 'Deposits only' },
  { value: 'withdrawal', label: 'Withdrawals only' },
];

/** Per-status tone for reconciliation tiles. */
function bucketTone(status: string): 'default' | 'up' | 'down' | 'warn' {
  const s = status.toLowerCase();
  if (s === 'success') return 'up';
  if (s === 'failed') return 'down';
  if (s === 'pending' || s === 'processing') return 'warn';
  return 'default';
}

/** Clickable player identity cell → user detail. */
function UserCell({ userId, username }: { userId: string; username: string }) {
  return (
    <Link href={`/admin/users/${userId}`} className="group inline-flex flex-col leading-tight">
      <span className="font-medium text-accent group-hover:underline">@{username || 'unknown'}</span>
      <span className="font-mono text-[10px] text-muted">{userId.slice(0, 8)}…</span>
    </Link>
  );
}

/** A phone number that dials on tap (mobile) and is copy-friendly on desktop. */
function PhoneCell({ phone }: { phone: string | null }) {
  if (!phone) return <span className="text-muted">—</span>;
  return (
    <a href={`tel:${phone}`} className="tabular-nums text-fg hover:text-accent hover:underline">
      {phone}
    </a>
  );
}

/** Exact timestamp (to the second) with a relative label underneath. */
function TimeCell({ ms }: { ms: number }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="whitespace-nowrap text-xs font-medium text-fg" title={formatExact(ms)}>
        {formatExact(ms)}
      </span>
      <span className="text-[10px] text-muted">{formatRelativeTime(ms)} ago</span>
    </span>
  );
}

export default function FinancePage() {
  const [txKind, setTxKind] = useState('');
  const [txStatus, setTxStatus] = useState('');

  const overview = useOverview();
  const recon = useDepositsReconcile();
  const txns = useTransactions({ ...(txKind ? { kind: txKind } : {}), ...(txStatus ? { status: txStatus } : {}) });

  const txRows = useMemo(() => txns.data?.pages.flatMap((p) => p.items) ?? [], [txns.data]);

  const sel = useRowSelection(txRows, (r) => r.txId);
  const toast = useToast();
  const selInfo = useMemo(() => {
    let deposits = 0, withdrawals = 0, depN = 0, wdN = 0;
    for (const r of sel.selectedRows) {
      if (r.kind === 'deposit') { deposits += r.amountCents; depN += 1; } else { withdrawals += r.amountCents; wdN += 1; }
    }
    return { deposits, withdrawals, depN, wdN };
  }, [sel.selectedRows]);
  async function copyPhones() {
    const phones = [...new Set(sel.selectedRows.map((r) => r.phone).filter((p): p is string => !!p))];
    const ok = await copyText(phones.join('\n'));
    toast.push({ tone: ok ? 'success' : 'error', title: ok ? 'Phone numbers copied' : 'Copy failed', description: `${phones.length} unique number(s)` });
  }
  function exportCsv() {
    downloadCsv(
      `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      sel.selectedRows.map((r) => ({
        txId: r.txId, username: r.username, kind: r.kind,
        amountKES: (r.amountCents / 100).toFixed(2), status: r.status,
        phone: r.phone ?? '', provider: r.provider ?? '',
        receipt: r.mpesaReceipt ?? r.checkoutRequestId ?? '',
        time: r.createdAtMs ? new Date(r.createdAtMs).toISOString() : '',
      })),
    );
  }

  const summary = recon.data?.summary ?? [];

  const fin = overview.data?.finance;
  const netCents = fin ? fin.depositsCents - fin.withdrawalsCents : 0;

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle="Every deposit and withdrawal with the player, exact time, amount and status — plus M-Pesa reconciliation for stuck STK pushes."
      />

      {/* Money KPIs — the operator's at-a-glance cash position. */}
      <Section title="Cash position">
        {overview.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Deposits (success)" money={fin?.depositsCents ?? 0} tone="up" />
              <StatCard label="Withdrawals (M-Pesa)" money={fin?.withdrawalsCents ?? 0} tone="down" hint="real cash out" />
              <StatCard label="Net cash in" money={netCents} tone={netCents >= 0 ? 'up' : 'down'} hint="deposits − real withdrawals" />
              <StatCard label="Wallet liability" money={fin?.walletLiabilityCents ?? 0} hint="owed to players" />
            </div>
            {/* Pending-withdrawal MODERATION lives in the Withdrawals queue (single owner) — link, don't duplicate the KPI. */}
            <Link href="/admin/withdrawals" className="self-start text-xs font-medium text-accent hover:underline">
              {fin?.pendingWithdrawals ?? 0} withdrawal{(fin?.pendingWithdrawals ?? 0) === 1 ? '' : 's'} awaiting moderation → Withdrawals queue
            </Link>
          </div>
        )}
      </Section>

      {/* Reconciliation summary — deposits grouped by status */}
      <Section title="Deposit reconciliation">
        {recon.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : recon.isError ? (
          <Empty title="Couldn't load reconciliation" description="Try again shortly." />
        ) : summary.length === 0 ? (
          <Empty title="No deposits yet" description="Reconciliation appears once deposits are recorded." />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {summary.map((b) => (
              <StatCard
                key={b.status}
                label={b.status}
                money={b.amountCents}
                hint={`${b.count} ${b.count === 1 ? 'deposit' : 'deposits'}`}
                tone={bucketTone(b.status)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* Unified transactions explorer — deposits + withdrawals, deep + clickable */}
      <Section title="All transactions">
        <Toolbar>
          <FilterSelect label="Type" value={txKind} onChange={setTxKind} options={KIND_OPTIONS} />
          <FilterSelect label="Status" value={txStatus} onChange={setTxStatus} options={STATUS_OPTIONS} />
        </Toolbar>
        {txns.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : txns.isError ? (
          <Empty title="Couldn't load transactions" description="Try again shortly." />
        ) : txRows.length === 0 ? (
          <Empty title="No transactions" description="No transactions match this filter." />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <Th className="w-8"><SelectAllCheckbox allSelected={sel.allSelected} someSelected={sel.someSelected} onChange={sel.setAll} /></Th>
                  <Th>Player</Th>
                  <Th>Type</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Phone</Th>
                  <Th>Provider</Th>
                  <Th>Receipt / ref</Th>
                  <Th className="text-right">Time</Th>
                </tr>
              </thead>
              <tbody>
                {txRows.map((r) => (
                  <TxRow key={r.txId} r={r} checked={sel.isSelected(r.txId)} onToggle={() => sel.toggle(r.txId)} />
                ))}
              </tbody>
            </TableWrap>
            {txns.hasNextPage ? (
              <Button variant="outline" size="sm" onClick={() => txns.fetchNextPage()} disabled={txns.isFetchingNextPage}>
                {txns.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
            <BulkBar
              count={sel.count}
              onClear={sel.clear}
              summary={<>{selInfo.depN} dep <Money cents={selInfo.deposits} /> · {selInfo.wdN} wd <Money cents={selInfo.withdrawals} /></>}
            >
              <Button size="sm" variant="outline" onClick={copyPhones}>Copy phones</Button>
              <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
            </BulkBar>
          </>
        )}
      </Section>
    </>
  );
}

function TxRow({ r, checked, onToggle }: { r: AdminTransactionRow; checked: boolean; onToggle: () => void }) {
  const isDeposit = r.kind === 'deposit';
  return (
    <tr className={`border-b border-border last:border-0 hover:bg-surface-2/50 ${checked ? 'bg-accent/5' : ''}`}>
      <Td><RowCheckbox checked={checked} onChange={onToggle} label={`Select ${r.username}`} /></Td>
      <Td>
        <UserCell userId={r.userId} username={r.username} />
      </Td>
      <Td>
        <span
          className={
            'inline-flex rounded-md px-2 py-0.5 text-xs font-medium ' +
            (isDeposit ? 'bg-up/10 text-up' : 'bg-down/10 text-down')
          }
        >
          {isDeposit ? 'Deposit' : 'Withdrawal'}
        </span>
      </Td>
      <Td className="text-right font-medium tabular-nums">
        <Money cents={r.amountCents} />
      </Td>
      <Td>
        <StatusBadge status={r.status} />
      </Td>
      <Td>
        <PhoneCell phone={r.phone} />
      </Td>
      <Td className="text-xs capitalize text-muted">{r.provider ?? '—'}</Td>
      <Td className="font-mono text-[11px] text-muted">
        {r.mpesaReceipt ?? r.checkoutRequestId ?? '—'}
        {r.resultDesc ? <span className="block text-[10px] text-muted/70">{r.resultDesc}</span> : null}
      </Td>
      <Td className="text-right">
        <TimeCell ms={r.createdAtMs} />
      </Td>
    </tr>
  );
}


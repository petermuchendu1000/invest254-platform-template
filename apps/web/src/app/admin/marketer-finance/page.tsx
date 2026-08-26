'use client';

import { useState } from 'react';
import { formatKes, kesToCents } from '@invest254/shared/money';
import { PageHeader, Section, TableWrap, Th, Td, Toolbar, FilterSelect, Empty } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Money } from '@/components/ui/Money';
import { RejectDialog } from '@/components/admin/RejectDialog';
import { AffiliatePayoutsPanel } from '@/components/admin/panels/AffiliatePayoutsPanel';
import { MarketersPanel } from '@/components/admin/panels/MarketersPanel';
import {
  useCommissionPayouts,
  useCommissionPayoutAction,
  useMarketers,
  useMarketerExpenses,
  useAddMarketerExpense,
} from '@/lib/admin/hooks';
import type { AdminCommissionPayoutRow } from '@/lib/admin/types';

/*
 * Marketer & affiliate finance — the single, consolidated home for every marketer/affiliate money
 * flow (consolidation A1). Tabs: Referral payouts, Marketer wallets, Expenses, Affiliate payouts.
 * The Affiliate and Marketer tabs render the full ported panels (all functions preserved); Referral
 * payouts + Expenses live here. The former standalone /admin/affiliates and /admin/marketers pages
 * are removed in favour of this hub.
 */

type Tab = 'referral' | 'wallets' | 'expenses' | 'affiliate';

const TABS: { id: Tab; label: string }[] = [
  { id: 'referral', label: 'Referral payouts' },
  { id: 'wallets', label: 'Marketer wallets' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'affiliate', label: 'Affiliate payouts' },
];

const PAYOUT_STATUSES = [
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'paid'
      ? 'bg-up/15 text-up'
      : status === 'approved'
        ? 'bg-accent/15 text-accent'
        : status === 'requested'
          ? 'bg-warn/15 text-warn'
          : status === 'rejected'
            ? 'bg-down/15 text-down'
            : 'bg-surface-2 text-muted';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${tone}`}>{status}</span>;
}

/** Money-amount text input (KES). */
function KesInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Input
      name="amount"
      inputMode="decimal"
      placeholder={placeholder ?? 'Amount (KES)'}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
      className="w-32"
    />
  );
}

export default function MarketerFinancePage() {
  const [tab, setTab] = useState<Tab>('referral');
  return (
    <>
      <PageHeader
        title="Marketer & affiliate finance"
        subtitle="Payout queues, marketer wallets, and the expense ledger — every marketer money flow in one place."
      />

      <div className="flex gap-1 rounded-xl border border-border bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
              tab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'referral' && <ReferralPayouts />}
      {tab === 'wallets' && <MarketersPanel />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'affiliate' && <AffiliatePayoutsPanel />}
    </>
  );
}

/* ── Deposit-referral commission payouts ────────────────────────────────────────────────────── */
function ReferralPayouts() {
  const [status, setStatus] = useState('requested');
  const q = useCommissionPayouts(status);
  const action = useCommissionPayoutAction();
  const rows: AdminCommissionPayoutRow[] = q.data?.items ?? [];
  const [rejecting, setRejecting] = useState<AdminCommissionPayoutRow | null>(null);

  const markPaid = (r: AdminCommissionPayoutRow) => {
    const input = window.prompt('M-Pesa / bank reference for this payment (optional):');
    const ref = input && input.trim() ? input.trim() : undefined;
    action.mutate({ id: r.id, action: 'paid', ...(ref ? { ref } : {}) });
  };

  return (
    <Section title="Deposit-referral commission payouts">
      <Toolbar>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={PAYOUT_STATUSES} />
        <span className="text-xs text-muted">{rows.length} shown</span>
      </Toolbar>
      <TableWrap>
        <thead>
          <tr>
            <Th>Marketer</Th>
            <Th>Phone</Th>
            <Th className="text-right">Amount</Th>
            <Th>Status</Th>
            <Th>Requested</Th>
            <Th>Paid ref</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <Td><span className="font-medium text-fg">{r.username ?? r.beneficiaryUser.slice(0, 8)}</span></Td>
              <Td className="text-muted">{r.phone ?? '—'}</Td>
              <Td className="text-right"><Money cents={r.amountCents} /></Td>
              <Td><StatusPill status={r.status} /></Td>
              <Td className="text-muted">{fmtDate(r.requestedAtMs)}</Td>
              <Td className="text-muted">{r.paidRef ?? '—'}</Td>
              <Td className="text-right">
                <span className="flex justify-end gap-1.5">
                  {r.status === 'requested' ? (
                    <>
                      <Button size="sm" variant="up" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, action: 'approve' })}>Approve</Button>
                      <Button size="sm" variant="down" disabled={action.isPending} onClick={() => setRejecting(r)}>Reject</Button>
                    </>
                  ) : r.status === 'approved' ? (
                    <>
                      <Button size="sm" variant="up" disabled={action.isPending} onClick={() => markPaid(r)}>Mark paid</Button>
                      <Button size="sm" variant="down" disabled={action.isPending} onClick={() => setRejecting(r)}>Reject</Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </span>
              </Td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><Td className="text-muted">{q.isLoading ? 'Loading…' : 'No commission payouts for this status.'}</Td></tr> : null}
        </tbody>
      </TableWrap>
      <RejectDialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        busy={action.isPending}
        title="Reject commission payout"
        subject={rejecting ? `${rejecting.username ?? rejecting.beneficiaryUser.slice(0, 8)} · ${formatKes(rejecting.amountCents)}` : undefined}
        consequence={
          <>
            No money is sent. The amount is no longer held, so it returns to the marketer&apos;s{' '}
            <span className="font-medium text-fg">available</span> commission balance and they can request a new
            payout. Works on <span className="font-medium text-fg">requested</span> or{' '}
            <span className="font-medium text-fg">approved</span> payouts.
          </>
        }
        onConfirm={(reason) =>
          rejecting &&
          action.mutate({ id: rejecting.id, action: 'reject', ...(reason ? { reason } : {}) }, { onSuccess: () => setRejecting(null) })
        }
      />
    </Section>
  );
}

/* ── Expenses ───────────────────────────────────────────────────────────────────────────────── */
const EXPENSE_CATEGORIES = ['advance', 'airtime', 'data_bundles', 'promo', 'salary', 'bonus', 'other'];

function Expenses() {
  const marketersQ = useMarketers();
  const marketers = marketersQ.data ?? [];
  const [marketerId, setMarketerId] = useState('');
  const expenses = useMarketerExpenses(marketerId);
  const add = useAddMarketerExpense(marketerId);
  const [category, setCategory] = useState('advance');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = kesToCents(Number(amount));
    if (!marketerId || c <= 0) return;
    add.mutate({ category, amountCents: c, ...(note ? { note } : {}) }, { onSuccess: () => { setAmount(''); setNote(''); } });
  };

  return (
    <Section title="Marketer expenses">
      <Toolbar>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <span>Marketer</span>
          <select value={marketerId} onChange={(e) => setMarketerId(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent">
            <option value="">Select a marketer…</option>
            {marketers.map((m) => (
              <option key={m.id} value={m.affiliate_user_id ?? ''} disabled={!m.affiliate_user_id}>
                {m.name} · {m.phone}{m.affiliate_user_id ? '' : ' (no website account)'}
              </option>
            ))}
          </select>
        </label>
        {marketerId ? <span className="text-xs text-muted">Total logged: <Money cents={expenses.data?.totalCents ?? 0} className="text-fg" /></span> : null}
      </Toolbar>

      {!marketerId ? (
        <Empty title="Select a marketer" description="Choose a marketer to view and log expenses against their account." />
      ) : (
        <>
          <form className="flex flex-wrap items-end gap-2 rounded-2xl border border-border bg-surface p-3" onSubmit={submit}>
            <label className="flex flex-col gap-1 text-xs text-muted">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent">
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <KesInput value={amount} onChange={setAmount} />
            <Input name="note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-56 max-w-full" />
            <Button type="submit" size="sm" disabled={add.isPending || !amount}>Log expense</Button>
          </form>

          <TableWrap>
            <thead><tr><Th>Category</Th><Th className="text-right">Amount</Th><Th>Note</Th><Th>When</Th></tr></thead>
            <tbody>
              {(expenses.data?.items ?? []).map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <Td className="capitalize">{e.category.replace(/_/g, ' ')}</Td>
                  <Td className="text-right"><Money cents={e.amountCents} /></Td>
                  <Td className="text-muted">{e.note ?? '—'}</Td>
                  <Td className="text-muted">{fmtDate(e.createdAtMs)}</Td>
                </tr>
              ))}
              {(expenses.data?.items ?? []).length === 0 ? <tr><Td className="text-muted">{expenses.isLoading ? 'Loading…' : 'No expenses logged.'}</Td></tr> : null}
            </tbody>
          </TableWrap>
        </>
      )}
    </Section>
  );
}

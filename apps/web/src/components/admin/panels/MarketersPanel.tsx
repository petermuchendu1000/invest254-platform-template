'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatDateTime } from '@/lib/format';
import { TableWrap, Th, Td, Empty, Toolbar, FilterSelect, ConfirmButton, StatCard, Section } from '@/components/admin/ui';
import {
  useMarketers,
  useMarketer,
  useMarketerStatement,
  useCreateMarketer,
  useUpdateMarketer,
  useMarketerCredit,
  useMarketerWithdraw,
  useMarketerFuliza,
  useMarketerAirtime,
  useMarketerPin,
  useMarketerStatus,
  useBulkMarketers,
} from '@/lib/admin/hooks';
import { useRowSelection, SelectAllCheckbox, RowCheckbox, BulkBar, downloadCsv, copyText } from '@/components/admin/BulkSelect';
import type { AdminMarketerRow } from '@/lib/admin/types';

/*
 * MarketersPanel — full marketer wallet management, ported verbatim from the former standalone
 * /admin/marketers page (consolidation A1) so NO function is lost: status filter, floats KPIs, row
 * selection, bulk status/credit, copy phones, CSV export, create modal, and the full Manage modal
 * (edit, wallet pay/withdraw, Fuliza/airtime, PIN, status, statement). Only the PageHeader was
 * replaced with an inline header so it can live inside the finance hub's "Marketer wallets" tab.
 */

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'disabled', label: 'Disabled' },
];

/** Parse a KES amount (shillings) into POSITIVE cents; null when empty/invalid/non-positive. */
function kesToCents(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** Parse a KES amount into NON-NEGATIVE cents (floats can be cleared to 0); null when empty/invalid/negative. */
function kesToNonNegCents(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
}

export function MarketersPanel() {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useMarketers();
  const rows = useMemo(() => {
    const all = q.data ?? [];
    return status ? all.filter((m) => m.status === status) : all;
  }, [q.data, status]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, m) => ({
          balance: acc.balance + m.balance_cents,
          fuliza: acc.fuliza + m.available_fuliza_cents,
          airtime: acc.airtime + m.airtime_balance_cents,
        }),
        { balance: 0, fuliza: 0, airtime: 0 },
      ),
    [rows],
  );

  const sel = useRowSelection(rows, (m) => m.id);
  const bulk = useBulkMarketers();
  const toast = useToast();
  const [crediting, setCrediting] = useState(false);
  const selBalance = useMemo(() => sel.selectedRows.reduce((s, m) => s + m.balance_cents, 0), [sel.selectedRows]);

  function runStatus(action: 'activate' | 'suspend' | 'disable') {
    const marketerIds = sel.selectedRows.map((m) => m.id);
    bulk.mutate(
      { action, marketerIds },
      {
        onSuccess: (res) => {
          toast.push({ tone: res.failCount ? 'error' : 'success', title: `${res.okCount}/${res.total} updated`, description: res.failCount ? `${res.failCount} could not be updated.` : `Marketers set to ${action === 'activate' ? 'active' : action === 'suspend' ? 'suspended' : 'disabled'}.` });
          sel.clear();
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Bulk action failed', description: errMsg(e) }),
      },
    );
  }
  async function copyPhones() {
    const ok = await copyText(sel.selectedRows.map((m) => m.phone).join('\n'));
    toast.push({ tone: ok ? 'success' : 'error', title: ok ? 'Phone numbers copied' : 'Copy failed', description: `${sel.count} number(s)` });
  }
  function exportCsv() {
    downloadCsv(
      `marketers-${status || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`,
      sel.selectedRows.map((m) => ({
        id: m.id, name: m.name, phone: m.phone, status: m.status,
        balanceKES: (m.balance_cents / 100).toFixed(2),
        fulizaKES: (m.available_fuliza_cents / 100).toFixed(2),
        airtimeKES: (m.airtime_balance_cents / 100).toFixed(2),
      })),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-fg">Marketer wallets</h3>
          <p className="text-xs text-muted">Wallets, Fuliza, airtime, PINs and status for marketers who receive payments.</p>
        </div>
        <Toolbar>
          <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          <Button size="sm" onClick={() => setCreating(true)}>New marketer</Button>
        </Toolbar>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Outstanding balances" money={totals.balance} hint={`${rows.length} marketer${rows.length === 1 ? '' : 's'}`} />
        <StatCard label="Available Fuliza" money={totals.fuliza} />
        <StatCard label="Airtime float" money={totals.airtime} />
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load marketers" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No marketers yet" description="Create one to start paying marketers." />
      ) : (
        <>
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <Th className="w-8"><SelectAllCheckbox allSelected={sel.allSelected} someSelected={sel.someSelected} onChange={sel.setAll} /></Th>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Balance</Th>
              <Th>Fuliza</Th>
              <Th>Airtime</Th>
              <Th>Status</Th>
              <Th className="text-right">Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={`border-b border-border last:border-0 ${sel.isSelected(m.id) ? 'bg-accent/5' : ''}`}>
                <Td><RowCheckbox checked={sel.isSelected(m.id)} onChange={() => sel.toggle(m.id)} label={`Select ${m.name}`} /></Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
                      {m.initials}
                    </span>
                    <span className="font-medium">{m.name}</span>
                  </span>
                </Td>
                <Td className="tabular-nums">{m.phone}</Td>
                <Td className="font-medium tabular-nums"><Money cents={m.balance_cents} /></Td>
                <Td className="tabular-nums"><Money cents={m.available_fuliza_cents} /></Td>
                <Td className="tabular-nums"><Money cents={m.airtime_balance_cents} /></Td>
                <Td><StatusBadge status={m.status} /></Td>
                <Td className="text-right">
                  <Button variant="outline" size="sm" onClick={() => setSelected(m.id)}>Manage</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <BulkBar count={sel.count} onClear={sel.clear} summary={<>Balance <Money cents={selBalance} /></>}>
          <ConfirmButton label="Activate" confirmLabel="Activate all" variant="up" busy={bulk.isPending} onConfirm={() => runStatus('activate')} />
          <ConfirmButton label="Suspend" confirmLabel="Suspend all" variant="outline" busy={bulk.isPending} onConfirm={() => runStatus('suspend')} />
          <ConfirmButton label="Disable" confirmLabel="Disable all" variant="down" busy={bulk.isPending} onConfirm={() => runStatus('disable')} />
          <Button size="sm" variant="secondary" onClick={() => setCrediting(true)}>Credit…</Button>
          <Button size="sm" variant="outline" onClick={copyPhones}>Copy phones</Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>Export CSV</Button>
        </BulkBar>
        </>
      )}

      <BulkCreditModal open={crediting} marketerIds={sel.selectedRows.map((m) => m.id)} onClose={() => setCrediting(false)} onDone={sel.clear} />
      <CreateMarketerModal open={creating} onClose={() => setCreating(false)} />
      <ManageMarketerModal id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ── Create ──

function CreateMarketerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateMarketer();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  function submit() {
    create.mutate(
      { name: name.trim(), phone: phone.trim() },
      {
        onSuccess: (m) => {
          toast.push({ tone: 'success', title: 'Marketer saved', description: `${m.name} (${m.phone}) is ready. Set their PIN next.` });
          setName('');
          setPhone('');
          onClose();
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: errMsg(e) }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="New marketer">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-semibold tracking-tight">New marketer</h2>
        <p className="text-xs text-muted">If this phone already belongs to a marketer, their name is updated (wallet is preserved).</p>
        <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Peter Muchendu" required />
        <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0722000001" required />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || !name.trim() || !phone.trim()}>
            {create.isPending ? 'Saving…' : 'Save marketer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Manage (detail) ──

function ManageMarketerModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useMarketer(id);
  const m = q.data;
  return (
    <Modal open={!!id} onClose={onClose} title="Manage marketer">
      <div className="flex flex-col gap-5 p-5">
        {q.isLoading || !m ? (
          <Skeleton className="h-60 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold">
                  {m.initials}
                </span>
                <span className="flex flex-col">
                  <span className="font-semibold">{m.name}</span>
                  <span className="text-xs text-muted tabular-nums">{m.phone}</span>
                </span>
              </span>
              <StatusBadge status={m.status} />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <StatCard label="Balance" money={m.balance_cents} />
              <StatCard label="Fuliza" money={m.available_fuliza_cents} />
              <StatCard label="Airtime" money={m.airtime_balance_cents} />
            </div>

            <EditMarketerAction m={m} />
            <WalletActions m={m} />
            <FloatActions m={m} />
            <PinAction m={m} />
            <StatusAction m={m} />
            <Statement id={m.id} />
          </>
        )}
      </div>
    </Modal>
  );
}

function EditMarketerAction({ m }: { m: AdminMarketerRow }) {
  const update = useUpdateMarketer();
  const toast = useToast();
  const [name, setName] = useState(m.name);
  const [phone, setPhone] = useState(m.phone);
  const inputCls = 'h-9 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent';
  function save() {
    const body: { id: string; name?: string; phone?: string } = { id: m.id };
    if (name.trim() && name.trim() !== m.name) body.name = name.trim();
    if (phone.trim() && phone.trim() !== m.phone) body.phone = phone.trim();
    if (body.name === undefined && body.phone === undefined) { toast.push({ tone: 'info', title: 'No changes' }); return; }
    update.mutate(body, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Marketer updated', description: 'Name/phone saved.' }),
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: (e as Error).message }),
    });
  }
  return (
    <div className="flex flex-col gap-2 rounded-brand border border-border p-3">
      <span className="text-sm font-semibold">Edit details</span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputCls} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Phone" className={inputCls} />
        <Button size="sm" onClick={save} disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}

function WalletActions({ m }: { m: AdminMarketerRow }) {
  const credit = useMarketerCredit(m.id);
  const withdraw = useMarketerWithdraw(m.id);
  const toast = useToast();
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const [wdAmount, setWdAmount] = useState('');

  function runCredit() {
    const cents = kesToCents(payAmount);
    if (!cents) return;
    credit.mutate(
      { amountCents: cents, ...(payRef.trim() ? { ref: payRef.trim() } : {}) },
      {
        onSuccess: () => {
          toast.push({ tone: 'success', title: 'Payment credited', description: `${m.first_name}'s wallet was topped up.` });
          setPayAmount('');
          setPayRef('');
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Credit failed', description: errMsg(e) }),
      },
    );
  }

  function runWithdraw() {
    const cents = kesToCents(wdAmount);
    if (!cents) return;
    withdraw.mutate(
      { amountCents: cents },
      {
        onSuccess: (r) => {
          toast.push({
            tone: 'success',
            title: r.idempotent ? 'Already recorded' : 'Withdrawal recorded',
            description: `New balance: KES ${(r.balance_cents / 100).toLocaleString()}.`,
          });
          setWdAmount('');
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Withdrawal failed', description: errMsg(e) }),
      },
    );
  }

  return (
    <Section title="Wallet">
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-28 flex-1">
            <Input label="Pay (KES)" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="min-w-28 flex-1">
            <Input label="Reference" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="e.g. INV-001" optional />
          </div>
          <Button size="sm" onClick={runCredit} disabled={credit.isPending || !kesToCents(payAmount)}>
            {credit.isPending ? 'Paying…' : 'Pay'}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
          <div className="min-w-28 flex-1">
            <Input label="Withdraw (KES)" inputMode="decimal" value={wdAmount} onChange={(e) => setWdAmount(e.target.value)} placeholder="0.00" />
          </div>
          <ConfirmButton
            label="Withdraw"
            confirmLabel="Confirm withdrawal"
            variant="outline"
            busy={withdraw.isPending}
            disabled={!kesToCents(wdAmount)}
            onConfirm={runWithdraw}
          />
        </div>
      </div>
    </Section>
  );
}

function FloatActions({ m }: { m: AdminMarketerRow }) {
  const fuliza = useMarketerFuliza(m.id);
  const airtime = useMarketerAirtime(m.id);
  const toast = useToast();
  const [f, setF] = useState('');
  const [a, setA] = useState('');

  function run(kind: 'fuliza' | 'airtime') {
    const cents = kesToNonNegCents(kind === 'fuliza' ? f : a);
    if (cents === null) return;
    const mut = kind === 'fuliza' ? fuliza : airtime;
    mut.mutate(cents, {
      onSuccess: () => {
        toast.push({ tone: 'success', title: kind === 'fuliza' ? 'Fuliza updated' : 'Airtime updated' });
        if (kind === 'fuliza') setF('');
        else setA('');
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: errMsg(e) }),
    });
  }

  return (
    <Section title="Floats">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-border bg-surface p-3">
        <div className="min-w-28 flex-1">
          <Input label="Set Fuliza (KES)" inputMode="decimal" value={f} onChange={(e) => setF(e.target.value)} placeholder="0.00" hint="Set to 0 to clear." />
        </div>
        <Button size="sm" variant="secondary" onClick={() => run('fuliza')} disabled={fuliza.isPending || kesToNonNegCents(f) === null}>
          Set
        </Button>
        <div className="min-w-28 flex-1">
          <Input label="Set airtime (KES)" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} placeholder="0.00" hint="Set to 0 to clear." />
        </div>
        <Button size="sm" variant="secondary" onClick={() => run('airtime')} disabled={airtime.isPending || kesToNonNegCents(a) === null}>
          Set
        </Button>
      </div>
    </Section>
  );
}

function PinAction({ m }: { m: AdminMarketerRow }) {
  const pin = useMarketerPin(m.id);
  const toast = useToast();
  const [p, setP] = useState('');
  const valid = /^\d{4}$/.test(p);

  function run() {
    pin.mutate(p, {
      onSuccess: () => {
        toast.push({ tone: 'success', title: 'PIN set', description: `Share it with ${m.first_name} privately.` });
        setP('');
      },
      onError: (e) => toast.push({ tone: 'error', title: 'PIN failed', description: errMsg(e) }),
    });
  }

  return (
    <Section title="Login PIN">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-border bg-surface p-3">
        <div className="min-w-28 flex-1">
          <Input
            label="Set / reset PIN"
            inputMode="numeric"
            maxLength={4}
            value={p}
            onChange={(e) => setP(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="4 digits"
            hint="The marketer uses phone + this 4-digit PIN to log in."
          />
        </div>
        <Button size="sm" variant="secondary" onClick={run} disabled={pin.isPending || !valid}>
          {pin.isPending ? 'Setting…' : 'Set PIN'}
        </Button>
      </div>
    </Section>
  );
}

function StatusAction({ m }: { m: AdminMarketerRow }) {
  const setStatus = useMarketerStatus(m.id);
  const toast = useToast();
  const next: { label: string; status: 'active' | 'suspended' | 'disabled'; variant: 'outline' | 'down' | 'up' }[] =
    m.status === 'active'
      ? [
          { label: 'Suspend', status: 'suspended', variant: 'outline' },
          { label: 'Disable', status: 'disabled', variant: 'down' },
        ]
      : [{ label: 'Reactivate', status: 'active', variant: 'up' }];

  function run(status: 'active' | 'suspended' | 'disabled') {
    setStatus.mutate(status, {
      onSuccess: () => toast.push({ tone: 'success', title: `Marketer ${status}` }),
      onError: (e) => toast.push({ tone: 'error', title: 'Status change failed', description: errMsg(e) }),
    });
  }

  return (
    <Section title="Status">
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-3">
        <span className="flex-1 text-xs text-muted">
          Suspended or disabled marketers cannot log in to the marketer app.
        </span>
        {next.map((n) => (
          <ConfirmButton
            key={n.status}
            label={n.label}
            confirmLabel={`Confirm ${n.label.toLowerCase()}`}
            variant={n.variant}
            busy={setStatus.isPending}
            onConfirm={() => run(n.status)}
          />
        ))}
      </div>
    </Section>
  );
}

function Statement({ id }: { id: string }) {
  const q = useMarketerStatement(id);
  const rows = q.data ?? [];
  return (
    <Section title="Statement">
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <Empty title="No ledger entries" description="Credits and withdrawals will appear here." />
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <Th>Type</Th>
              <Th>Amount</Th>
              <Th>Balance after</Th>
              <Th>Ref</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <Td className="font-medium">{r.entry_type}</Td>
                <Td className="tabular-nums"><Money cents={r.amount_cents} /></Td>
                <Td className="tabular-nums"><Money cents={r.balance_after_cents} /></Td>
                <Td className="text-xs text-muted">{r.ref ?? '—'}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{formatDateTime(Date.parse(r.created_at))}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Section>
  );
}

// ── Bulk credit (many marketers, one flat amount) ──
function BulkCreditModal({ open, marketerIds, onClose, onDone }: { open: boolean; marketerIds: string[]; onClose: () => void; onDone: () => void }) {
  const bulk = useBulkMarketers();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const cents = kesToCents(amount);

  function submit() {
    if (!cents) return;
    bulk.mutate(
      { action: 'credit', marketerIds, amountCents: cents, ...(ref.trim() ? { ref: ref.trim() } : {}) },
      {
        onSuccess: (res) => {
          toast.push({
            tone: res.failCount ? 'error' : 'success',
            title: `Credited ${res.okCount}/${res.total}`,
            description: res.failCount ? `${res.failCount} failed.` : `KES ${(cents / 100).toLocaleString()} to each marketer.`,
          });
          setAmount('');
          setRef('');
          onDone();
          onClose();
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Bulk credit failed', description: errMsg(e) }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Bulk credit">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-semibold tracking-tight">Credit {marketerIds.length} marketer{marketerIds.length === 1 ? '' : 's'}</h2>
        <p className="text-xs text-muted">Each selected marketer is credited the SAME amount. A reference makes it idempotent (safe to retry) — each marketer gets a distinct <span className="font-mono">{'{ref}:{id}'}</span> key.</p>
        <Input label="Amount each (KES)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
        <Input label="Reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. AUG-BONUS" optional />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={bulk.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={bulk.isPending || !cents || marketerIds.length === 0}>
            {bulk.isPending ? 'Crediting…' : `Credit ${cents ? `KES ${(cents / 100).toLocaleString()}` : ''} each`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

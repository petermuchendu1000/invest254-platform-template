'use client';

import * as React from 'react';
import { formatKes } from '@invest254/shared/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty, SearchInput, TableWrap, Th, Td } from '@/components/admin/ui';
import { Switch } from '@/components/platform/PaymentsIndex';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  useAddCharge, useBillingAccounts, useBillingPlans, useBillingSettings, useChangePlan, useCharges, useCreateInvoice, useInvoices,
  useSetExempt, useSetSubscriptionStatus, useSubEvents, useVoidCharge, type BillingAccount,
} from '@/lib/billing/api';
import { LINE_KIND, SUB_STATE, parseKes, subState } from '@/lib/billing/labels';
import { InvoiceList, SubPill, errMsg } from './parts';

/** Owner: every platform's subscription in one table — plan, standing, next invoice and what it owes. */
export function OwnerAccounts({ onManage }: { onManage: (platformId: string) => void }) {
  const acc = useBillingAccounts();
  const [q, setQ] = React.useState('');
  if (acc.isLoading) return <Skeleton className="h-72 w-full" />;
  const rows = (acc.data?.accounts ?? []).filter((a) => !q || a.platformName.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-3">
      <SearchInput value={q} onChange={setQ} placeholder="Find a platform" />
      {!rows.length ? <Empty title="No platforms" /> : (
        <TableWrap>
          <thead className="border-b border-border">
            <tr><Th>Platform</Th><Th>Plan</Th><Th>Status</Th><Th>Next invoice</Th><Th numeric>Monthly</Th><Th numeric>Balance due</Th><Th className="w-px" /></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((a) => (
              <tr key={a.platformId} className="cursor-pointer transition hover:bg-surface-2/60" onClick={() => onManage(a.platformId)}>
                <Td><div className="font-medium">{a.platformName}</div><div className="text-xs text-muted">{a.sites} brand{a.sites === 1 ? '' : 's'} · {a.users.toLocaleString('en-KE')} players</div></Td>
                <Td><div>{a.planName ?? a.planKey}</div>{a.customPrice ? <div className="text-xs text-muted">Custom price</div> : null}</Td>
                <Td>{a.billingExempt ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">Not billed</span> : <SubPill status={a.status} />}</Td>
                <Td className="whitespace-nowrap">{a.nextInvoiceAt ? formatDate(a.nextInvoiceAt) : '—'}</Td>
                <Td numeric>{a.priceCents == null ? 'Custom' : formatKes(a.priceCents + a.monthlyAddonsCents)}</Td>
                <Td numeric className={cn(a.overdueCents > 0 && 'font-semibold text-down')}>{a.balanceDueCents ? formatKes(a.balanceDueCents) : '—'}</Td>
                <Td><Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onManage(a.platformId); }}>Manage</Button></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}

type Pane = 'summary' | 'plan' | 'charge' | 'status';

/** Owner: one platform's billing in a panel — summary, invoices, pending charges, history — and every action. */
export function ManageAccount({ platformId, onClose, onNewInvoice }: { platformId: string | null; onClose: () => void; onNewInvoice: (platformId: string) => void }) {
  const acc = useBillingAccounts();
  const a = acc.data?.accounts.find((x) => x.platformId === platformId) ?? null;
  const [pane, setPane] = React.useState<Pane>('summary');
  React.useEffect(() => { setPane('summary'); }, [platformId]);
  if (!platformId) return null;
  return (
    <Modal open={!!platformId} onClose={onClose} size="lg" title={a ? a.platformName : 'Platform'}
      description={a ? <span className="flex flex-wrap items-center gap-2">{a.billingExempt ? 'Not billed' : <SubPill status={a.status} />}<span>{a.planName ?? a.planKey} · {a.priceCents == null ? 'custom price' : `${formatKes(a.priceCents)}/${a.billingPeriod ?? 'month'}`}</span></span> : undefined}>
      {!a ? <Skeleton className="h-60 w-full" /> : pane === 'plan' ? <PlanPane a={a} done={() => setPane('summary')} />
        : pane === 'charge' ? <ChargePane a={a} done={() => setPane('summary')} />
          : pane === 'status' ? <StatusPane a={a} done={() => setPane('summary')} />
            : <Summary a={a} go={setPane} onNewInvoice={() => onNewInvoice(a.platformId)} />}
    </Modal>
  );
}

function Summary({ a, go, onNewInvoice }: { a: BillingAccount; go: (p: Pane) => void; onNewInvoice: () => void }) {
  const invs = useInvoices({ platform: a.platformId, limit: 20 });
  const charges = useCharges(a.platformId);
  const events = useSubEvents(a.platformId);
  const voidCharge = useVoidCharge();
  const exempt = useSetExempt();
  const toast = useToast();
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Balance due', a.balanceDueCents ? formatKes(a.balanceDueCents) : 'Nothing', a.overdueCents > 0],
          ['Next invoice', a.nextInvoiceAt ? formatDate(a.nextInvoiceAt) : '—', false],
          ['Monthly add-ons', formatKes(a.monthlyAddonsCents), false],
          ['Last payment', a.lastPaymentAt ? formatDate(a.lastPaymentAt) : 'None yet', false],
        ].map(([k, v, bad]) => (
          <div key={String(k)} className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">{k}</dt><dd className={cn('mt-0.5 font-semibold tabular-nums', bad && 'text-down')}>{v}</dd></div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onNewInvoice}>New invoice</Button>
        <Button size="sm" variant="outline" onClick={() => go('charge')}>Add charge or credit</Button>
        <Button size="sm" variant="outline" onClick={() => go('plan')}>Change plan</Button>
        <Button size="sm" variant="outline" onClick={() => go('status')}>Change status</Button>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
        <span><span className="font-medium">Bill this platform</span><span className="block text-xs text-muted">Off = no invoices, no charges and no overdue handling (use for your own platform).</span></span>
        <Switch checked={!a.billingExempt} label="Bill this platform" disabled={exempt.isPending}
          onChange={(on) => exempt.mutate({ platformId: a.platformId, exempt: !on }, {
            onSuccess: () => toast.push({ tone: 'success', title: on ? 'Billing switched on' : 'Billing switched off' }),
            onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: errMsg(e) }),
          })} />
      </label>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Waiting for the next invoice</h3>
        {(charges.data?.charges ?? []).length === 0 ? <p className="text-sm text-muted">No pending charges or credits.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {charges.data!.charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0"><div className="truncate">{c.description}</div><div className="text-xs text-muted">{LINE_KIND[c.kind] ?? c.kind} · {formatDate(c.createdAt)}</div></div>
                <div className="flex items-center gap-2">
                  <span className={cn('whitespace-nowrap tabular-nums', c.amountCents < 0 && 'text-up')}>{formatKes(c.amountCents)}</span>
                  <button type="button" className="text-xs text-muted hover:text-down" disabled={voidCharge.isPending}
                    onClick={() => voidCharge.mutate(c.id, { onError: (e) => toast.push({ tone: 'error', title: 'Not removed', description: errMsg(e) }) })}
                    aria-label={`Remove ${c.description}`}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Invoices</h3>
        {invs.isLoading ? <Skeleton className="h-24 w-full" /> : <InvoiceList compact invoices={invs.data?.invoices ?? []} emptyTitle="No invoices yet" />}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">History</h3>
        <ol className="flex flex-col gap-2 border-l border-border pl-4 text-sm">
          {(events.data?.events ?? []).slice(0, 12).map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border" aria-hidden />
              <span className="font-medium">{eventText(e.reason, e.fromStatus, e.toStatus, e.amountCents)}</span>
              <span className="block text-xs text-muted">{formatDateTime(e.createdAtMs)}{e.actorId ? '' : ' · automatic'}</span>
            </li>
          ))}
          {!events.data?.events.length ? <li className="text-muted">No history yet.</li> : null}
        </ol>
      </section>
    </div>
  );
}

function eventText(reason: string, from: string | null, to: string | null, amount: number | null): string {
  const s = (x: string | null) => (x ? subState(x).label : '—');
  switch (reason) {
    case 'payment': return `Payment${amount ? ` of ${formatKes(amount)}` : ''}${from !== to ? ` — ${s(from)} → ${s(to)}` : ''}`;
    case 'plan_change': return 'Plan changed';
    case 'created': return 'Subscription started';
    case 'trial_converted': return 'Trial ended — first invoice sent';
    case 'past_due': return 'Invoice overdue';
    case 'grace': return 'Final notice (grace period started)';
    case 'suspended': return 'Suspended for non-payment';
    default: return from !== to ? `${s(from)} → ${s(to)}` : reason.replace(/_/g, ' ');
  }
}

function PlanPane({ a, done }: { a: BillingAccount; done: () => void }) {
  const plans = useBillingPlans();
  const change = useChangePlan();
  const toast = useToast();
  const [plan, setPlan] = React.useState(a.planKey);
  const [price, setPrice] = React.useState(a.customPrice && a.priceCents != null ? String(a.priceCents / 100) : '');
  const [sites, setSites] = React.useState('');
  const [users, setUsers] = React.useState('');
  const p = plans.data?.plans.find((x) => x.key === plan);
  const cents = price.trim() ? parseKes(price) : null;
  const bad = price.trim() !== '' && (cents == null || cents < 0);
  return (
    <div className="flex flex-col gap-4">
      <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
        {(plans.data?.plans ?? []).filter((x) => x.active || x.key === a.planKey).map((x) => (
          <option key={x.key} value={x.key}>{x.name} — {x.priceCents == null ? 'custom' : `${formatKes(x.priceCents)}/${x.billingPeriod}`}</option>
        ))}
      </Select>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Custom price (KES)" optional inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={p?.priceCents != null ? String(p.priceCents / 100) : 'Required for custom plans'} error={bad ? 'Enter an amount.' : undefined} />
        <Input label="Brand limit" optional inputMode="numeric" value={sites} onChange={(e) => setSites(e.target.value.replace(/\D/g, ''))} placeholder={p?.maxSites == null ? 'Unlimited' : String(p.maxSites)} />
        <Input label="Player limit" optional inputMode="numeric" value={users} onChange={(e) => setUsers(e.target.value.replace(/\D/g, ''))} placeholder={p?.maxUsers == null ? 'Unlimited' : String(p.maxUsers)} />
      </div>
      <p className="text-sm text-muted">The new price applies from the next invoice ({a.nextInvoiceAt ? formatDate(a.nextInvoiceAt) : 'next renewal'}). Invoices already sent don't change.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={done}>Back</Button>
        <Button disabled={bad || change.isPending} onClick={() => change.mutate({
          platformId: a.platformId, planKey: plan, customPriceCents: cents, customMaxSites: sites ? Number(sites) : null, customMaxUsers: users ? Number(users) : null,
        }, { onSuccess: () => { toast.push({ tone: 'success', title: 'Plan changed' }); done(); }, onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: errMsg(e) }) })}>Save plan</Button>
      </div>
    </div>
  );
}

function ChargePane({ a, done }: { a: BillingAccount; done: () => void }) {
  const add = useAddCharge();
  const toast = useToast();
  const [kind, setKind] = React.useState<'charge' | 'credit'>('charge');
  const [desc, setDesc] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const cents = parseKes(amount);
  const ok = !!desc.trim() && cents != null && cents > 0;
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Type" className="grid grid-cols-2 gap-2">
        {(['charge', 'credit'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={cn('rounded-xl border p-3 text-left text-sm transition', kind === k ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-2')}>
            <span className="font-medium">{k === 'charge' ? 'Charge' : 'Credit'}</span>
            <span className="block text-xs text-muted">{k === 'charge' ? 'Adds to the next invoice' : 'Takes off the next invoice'}</span>
          </button>
        ))}
      </div>
      <Input label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={kind === 'charge' ? 'e.g. Custom domain setup' : 'e.g. Goodwill credit for downtime'} maxLength={200} />
      <Input label="Amount (KES)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/^-/, ''))} />
      <p className="text-sm text-muted">It appears on {a.platformName}&rsquo;s next invoice. To bill it now, add it and then create an invoice with pending charges.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={done}>Back</Button>
        <Button disabled={!ok || add.isPending} onClick={() => add.mutate({ platformId: a.platformId, description: desc.trim(), amountCents: kind === 'credit' ? -cents! : cents! }, {
          onSuccess: () => { toast.push({ tone: 'success', title: kind === 'credit' ? 'Credit added' : 'Charge added' }); done(); },
          onError: (e) => toast.push({ tone: 'error', title: 'Not added', description: errMsg(e) }),
        })}>{kind === 'credit' ? 'Add credit' : 'Add charge'}</Button>
      </div>
    </div>
  );
}

function StatusPane({ a, done }: { a: BillingAccount; done: () => void }) {
  const set = useSetSubscriptionStatus();
  const toast = useToast();
  const [status, setStatus] = React.useState(a.status);
  const [reason, setReason] = React.useState('');
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">Normally you don&rsquo;t need this: statuses follow the invoices automatically. Use it to cancel, or to suspend or restore a platform by hand.</p>
      <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
        {Object.entries(SUB_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </Select>
      <p className="text-sm text-muted">{subState(status).meaning}{status === 'active' ? ' Setting Active starts a new service period today.' : ''}</p>
      <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown in the history" />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={done}>Back</Button>
        <Button variant={status === 'suspended' || status === 'cancelled' ? 'down' : 'primary'} disabled={status === a.status || !reason.trim() || set.isPending}
          onClick={() => set.mutate({ platformId: a.platformId, status, reason: reason.trim() }, {
            onSuccess: () => { toast.push({ tone: 'success', title: `Now ${subState(status).label.toLowerCase()}` }); done(); },
            onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: errMsg(e) }),
          })}>Set to {subState(status).label.toLowerCase()}</Button>
      </div>
    </div>
  );
}

/** Owner: a one-off invoice — lines (optionally per brand), pending charges, terms and a note, with a live total. */
export function NewInvoiceModal({ platformId, onClose, onCreated }: { platformId: string | null | 'pick'; onClose: () => void; onCreated: (id: string) => void }) {
  const acc = useBillingAccounts();
  const [pid, setPid] = React.useState('');
  const [lines, setLines] = React.useState([{ description: '', amount: '', quantity: '1' }]);
  const [includePending, setIncludePending] = React.useState(true);
  const [dueDays, setDueDays] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const create = useCreateInvoice();
  const settings = useBillingSettings();
  const toast = useToast();
  const target = platformId === 'pick' ? pid : platformId ?? '';
  const charges = useCharges(target || null);
  React.useEffect(() => { setLines([{ description: '', amount: '', quantity: '1' }]); setNotes(''); setDueDays(''); setIncludePending(true); setPid(''); }, [platformId]);
  const parsed = lines.map((l) => ({ description: l.description.trim(), unitCents: parseKes(l.amount), quantity: Math.max(1, Number(l.quantity) || 1) }));
  const filled = parsed.filter((l) => l.description || l.unitCents != null);
  const invalid = filled.some((l) => !l.description || l.unitCents == null || l.unitCents === 0);
  const pendingTotal = includePending ? (charges.data?.charges ?? []).reduce((s, c) => s + c.amountCents, 0) : 0;
  const total = filled.reduce((s, l) => s + (l.unitCents ?? 0) * l.quantity, 0) + pendingTotal;
  const taxBp = settings.data?.taxRateBp ?? 0;
  const tax = total > 0 ? Math.round((total * taxBp) / 10000 / 100) * 100 : 0;   // same rounding as the invoice (whole KES)
  const empty = !filled.length && !(includePending && (charges.data?.charges.length ?? 0) > 0);
  const name = acc.data?.accounts.find((x) => x.platformId === target)?.platformName;
  return (
    <Modal open={!!platformId} onClose={onClose} size="lg" title={name ? `New invoice for ${name}` : 'New invoice'}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!target || invalid || empty || create.isPending} onClick={() => create.mutate({
          platformId: target, lines: filled.map((l) => ({ description: l.description, unitCents: l.unitCents!, quantity: l.quantity })), includePending,
          dueDays: dueDays ? Number(dueDays) : null, ...(notes.trim() ? { notes: notes.trim() } : {}),
        }, { onSuccess: (inv) => { toast.push({ tone: 'success', title: `Invoice ${inv.number} sent`, description: 'The platform admins were notified.' }); onCreated(inv.id); },
          onError: (e) => toast.push({ tone: 'error', title: 'Not created', description: errMsg(e) }) })}>Send invoice · {formatKes(Math.max(0, total + tax))}</Button></>}>
      <div className="flex flex-col gap-4">
        {platformId === 'pick' ? (
          <Select label="Platform" value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">Choose a platform…</option>
            {(acc.data?.accounts ?? []).filter((x) => !x.billingExempt).map((x) => <option key={x.platformId} value={x.platformId}>{x.platformName}</option>)}
          </Select>
        ) : null}
        <div className="flex flex-col gap-2">
          <div className="hidden grid-cols-[1fr_80px_140px_32px] gap-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid"><span>Description</span><span>Qty</span><span>Unit price (KES)</span><span /></div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_64px] gap-2 sm:grid-cols-[1fr_80px_140px_32px]">
              <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                placeholder="e.g. Custom integration work" className="col-span-2 h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-accent sm:col-span-1" />
              <input aria-label={`Line ${i + 1} quantity`} inputMode="numeric" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, '') } : x)))}
                className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-right text-sm outline-none focus:border-accent" />
              <input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                placeholder="0" className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-right text-sm tabular-nums outline-none focus:border-accent" />
              <button type="button" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}
                className="hidden h-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-down disabled:opacity-30 sm:flex">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setLines([...lines, { description: '', amount: '', quantity: '1' }])} className="w-fit text-sm font-medium text-accent hover:underline">+ Add a line</button>
          {invalid ? <p className="text-sm text-down">Every line needs a description and a non-zero price. Use a negative price for a discount.</p> : null}
        </div>
        {tax > 0 ? <p className="text-sm text-muted">Subtotal {formatKes(total)} + {settings.data?.taxLabel ?? 'Tax'} {formatKes(tax)}</p> : null}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={includePending} onChange={(e) => setIncludePending(e.target.checked)} />
          <span>Include pending charges and credits{target ? ` (${charges.data?.charges.length ?? 0} · ${formatKes((charges.data?.charges ?? []).reduce((s, c) => s + c.amountCents, 0))})` : ''}</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <Input label="Due in (days)" optional inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value.replace(/\D/g, ''))} placeholder="Default terms" />
          <Input label="Note on the invoice" optional value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

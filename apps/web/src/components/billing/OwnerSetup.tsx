'use client';

import * as React from 'react';
import { formatKes } from '@invest254/shared/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { FilterSelect, SearchInput } from '@/components/admin/ui';
import { Switch } from '@/components/platform/PaymentsIndex';
import { useToast } from '@/lib/toast/ToastProvider';
import { cn } from '@/lib/cn';
import {
  useBillingAccounts, useBillingPlans, useBillingSettings, useInvoices, useSaveBillingSettings, useUpsertPlan,
  type BillingPlan, type BillingSettings,
} from '@/lib/billing/api';
import { bpToPct, limitText, parseKes } from '@/lib/billing/labels';
import { InvoiceList, errMsg } from './parts';

const STATUS_FILTERS = [
  { value: '', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }, { value: 'uncollectible', label: 'Written off' },
];

/** Owner: every invoice, filtered by state and platform, searchable by number. */
export function OwnerInvoices() {
  const [status, setStatus] = React.useState('');
  const [platform, setPlatform] = React.useState('');
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const acc = useBillingAccounts();
  const invs = useInvoices({ status, platform, q: debounced, limit: 200 });
  const list = invs.data?.invoices ?? [];
  const due = list.filter((i) => i.status === 'open').reduce((s, i) => s + i.amountDueCents, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Invoice status" className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value || 'all'} type="button" role="tab" aria-selected={status === f.value} onClick={() => setStatus(f.value)}
              className={cn('h-8 rounded-lg px-3 text-sm font-medium transition', status === f.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>{f.label}</button>
          ))}
        </div>
        <FilterSelect label="Platform" value={platform} onChange={setPlatform}
          options={[{ value: '', label: 'All platforms' }, ...(acc.data?.accounts ?? []).map((a) => ({ value: a.platformId, label: a.platformName }))]} />
        <SearchInput value={q} onChange={setQ} placeholder="Invoice number or platform" />
      </div>
      {!invs.isLoading && list.length ? <p className="text-sm text-muted">{list.length} invoice{list.length === 1 ? '' : 's'}{due ? <> · <b className="text-fg">{formatKes(due)}</b> still due</> : null}</p> : null}
      {invs.isLoading ? <Skeleton className="h-60 w-full" /> : (
        <InvoiceList invoices={list} showPlatform emptyTitle={status || platform || debounced ? 'No invoices match' : 'No invoices yet'}
          emptyText={status || platform || debounced ? 'Try another filter.' : 'Renewal invoices are sent automatically on each platform’s renewal date. You can also create one by hand.'} />
      )}
    </div>
  );
}

/** Owner: the plan catalogue — price, limits, how many platforms are on it; add and edit. */
export function OwnerPlans() {
  const plans = useBillingPlans();
  const [edit, setEdit] = React.useState<BillingPlan | 'new' | null>(null);
  if (plans.isLoading) return <Skeleton className="h-60 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEdit('new')}>Add plan</Button></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(plans.data?.plans ?? []).map((p) => (
          <div key={p.key} className={cn('flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4', !p.active && 'opacity-70')}>
            <div className="flex items-start justify-between gap-2">
              <div><div className="font-semibold">{p.name}</div><div className="font-mono text-xs text-muted">{p.key}</div></div>
              {!p.active ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">Hidden</span> : null}
            </div>
            <div className="text-2xl font-bold tabular-nums">{p.priceCents == null ? 'Custom' : formatKes(p.priceCents)}<span className="text-sm font-normal text-muted"> / {p.billingPeriod}</span></div>
            <ul className="text-sm text-muted"><li>{limitText(p.maxSites, 'brands')}</li><li>{limitText(p.maxUsers, 'players')}</li></ul>
            <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-muted">{p.platforms} platform{p.platforms === 1 ? '' : 's'}</span>
              <Button size="sm" variant="outline" onClick={() => setEdit(p)}>Edit</Button>
            </div>
          </div>
        ))}
      </div>
      <PlanModal plan={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function PlanModal({ plan, onClose }: { plan: BillingPlan | 'new' | null; onClose: () => void }) {
  const isNew = plan === 'new';
  const p = plan && plan !== 'new' ? plan : null;
  const [key, setKey] = React.useState(''); const [name, setName] = React.useState('');
  const [price, setPrice] = React.useState(''); const [sites, setSites] = React.useState(''); const [users, setUsers] = React.useState('');
  const [active, setActive] = React.useState(true);
  const save = useUpsertPlan(); const toast = useToast();
  React.useEffect(() => {
    setKey(p?.key ?? ''); setName(p?.name ?? ''); setPrice(p?.priceCents != null ? String(p.priceCents / 100) : '');
    setSites(p?.maxSites != null ? String(p.maxSites) : ''); setUsers(p?.maxUsers != null ? String(p.maxUsers) : ''); setActive(p?.active ?? true);
  }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const cents = price.trim() ? parseKes(price) : null;
  const keyOk = /^[a-z][a-z0-9_]{1,30}$/.test(key);
  const ok = keyOk && !!name.trim() && (price.trim() === '' || (cents != null && cents >= 0));
  return (
    <Modal open={!!plan} onClose={onClose} title={isNew ? 'Add a plan' : `Edit ${p?.name ?? ''}`} size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!ok || save.isPending} onClick={() => save.mutate({ key, name: name.trim(), priceCents: cents, maxSites: sites ? Number(sites) : null, maxUsers: users ? Number(users) : null, active }, {
          onSuccess: () => { toast.push({ tone: 'success', title: isNew ? 'Plan added' : 'Plan saved' }); onClose(); },
          onError: (e) => toast.push({ tone: 'error', title: 'Not saved', description: errMsg(e) }),
        })}>{isNew ? 'Add plan' : 'Save'}</Button></>}>
      <div className="flex flex-col gap-3">
        <Input label="Name" value={name} onChange={(e) => { setName(e.target.value); if (isNew) setKey(e.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p$1').slice(0, 31)); }} />
        <Input label="Key" value={key} onChange={(e) => setKey(e.target.value)} disabled={!isNew} hint="Used internally; can't change later." error={key && !keyOk ? 'Lowercase letters, digits and _ only.' : undefined} />
        <Input label="Monthly price (KES)" optional value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" hint="Leave empty for a custom price agreed per platform." />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Brand limit" optional inputMode="numeric" value={sites} onChange={(e) => setSites(e.target.value.replace(/\D/g, ''))} placeholder="Unlimited" />
          <Input label="Player limit" optional inputMode="numeric" value={users} onChange={(e) => setUsers(e.target.value.replace(/\D/g, ''))} placeholder="Unlimited" />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span><span className="font-medium">Offer this plan</span><span className="block text-xs text-muted">Hidden plans stay on the platforms that have them.</span></span>
          <Switch checked={active} onChange={setActive} label="Offer this plan" />
        </label>
        {!isNew && p && p.platforms > 0 ? <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">{p.platforms} platform{p.platforms === 1 ? ' is' : 's are'} on this plan. A new price applies from each one&rsquo;s next invoice.</p> : null}
      </div>
    </Modal>
  );
}

type Draft = Omit<BillingSettings, 'nextNumber' | 'updatedAt'>;
const FIELDS: (keyof Draft)[] = ['businessName', 'businessAddress', 'taxPin', 'billingEmail', 'billingPhone', 'invoicePrefix', 'daysUntilDue', 'taxRateBp', 'taxLabel', 'paymentInstructions', 'mpesaPayEnabled', 'footerNote', 'trialDays', 'pastDueDays', 'graceDays'];

/** Owner: billing settings — what invoices say, terms and tax, how platforms pay, and the overdue timeline. */
export function OwnerSettings() {
  const s = useBillingSettings();
  const save = useSaveBillingSettings();
  const toast = useToast();
  const [d, setD] = React.useState<Draft | null>(null);
  const [taxPct, setTaxPct] = React.useState('');
  React.useEffect(() => {
    if (s.data && !d) { const { nextNumber: _n, updatedAt: _u, ...rest } = s.data; setD(rest); setTaxPct(String(s.data.taxRateBp / 100)); }
  }, [s.data, d]);
  if (!s.data || !d) return <Skeleton className="h-96 w-full" />;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const tax = Math.round(Number(taxPct) * 100);
  const draft: Draft = { ...d, taxRateBp: Number.isFinite(tax) ? tax : d.taxRateBp };
  const changed = FIELDS.filter((k) => draft[k] !== (s.data as BillingSettings)[k]);
  const errors: Record<string, string> = {};
  if (!/^[A-Z0-9]{2,8}$/.test(draft.invoicePrefix)) errors.invoicePrefix = '2–8 capital letters or digits.';
  if (!(draft.daysUntilDue >= 0 && draft.daysUntilDue <= 90)) errors.daysUntilDue = '0–90 days.';
  if (!/^\d+(\.\d{1,2})?$/.test(taxPct) || tax > 5000) errors.tax = '0–50%.';
  if (!(draft.trialDays >= 0 && draft.trialDays <= 90)) errors.trialDays = '0–90 days.';
  if (!(draft.pastDueDays >= 0 && draft.pastDueDays <= 60)) errors.pastDueDays = '0–60 days.';
  if (!(draft.graceDays >= 0 && draft.graceDays <= 60)) errors.graceDays = '0–60 days.';
  if (!draft.businessName.trim()) errors.businessName = 'Required.';
  const num = (k: 'daysUntilDue' | 'trialDays' | 'pastDueDays' | 'graceDays') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value.replace(/\D/g, '') || '0'));
  const year = new Date().getFullYear();

  return (
    <div className="flex flex-col gap-6">
      <Group title="On your invoices" hint="Printed at the top and bottom of every invoice.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Business name" value={d.businessName} onChange={(e) => set('businessName', e.target.value)} error={errors.businessName} />
          <Input label="KRA PIN" optional value={d.taxPin} onChange={(e) => set('taxPin', e.target.value.toUpperCase())} placeholder="P051234567X" />
          <Input label="Billing email" optional type="email" value={d.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} />
          <Input label="Billing phone" optional value={d.billingPhone} onChange={(e) => set('billingPhone', e.target.value)} />
        </div>
        <TextArea label="Address" value={d.businessAddress} onChange={(v) => set('businessAddress', v)} rows={2} />
        <Input label="Footer note" optional value={d.footerNote} onChange={(e) => set('footerNote', e.target.value)} placeholder="e.g. Thank you for your business." />
      </Group>

      <Group title="Numbering, terms and tax">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Invoice prefix" value={d.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())} error={errors.invoicePrefix}
            hint={`Next: ${draft.invoicePrefix || '…'}-${year}-${String(s.data.nextNumber).padStart(5, '0')}`} />
          <Input label="Payment due after (days)" inputMode="numeric" value={String(d.daysUntilDue)} onChange={num('daysUntilDue')} error={errors.daysUntilDue} />
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <Input label="Tax rate (%)" inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} error={errors.tax} hint={tax > 0 ? `${bpToPct(tax)} added to every invoice` : 'No tax added'} />
            <Input label="Label" value={d.taxLabel} onChange={(e) => set('taxLabel', e.target.value)} />
          </div>
        </div>
      </Group>

      <Group title="How platforms pay">
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
          <span><span className="font-medium">M-Pesa Pay now</span><span className="block text-xs text-muted">Platform admins get a prompt on their phone; the money goes to the System M-Pesa account and the invoice is marked paid on its own.</span></span>
          <Switch checked={d.mpesaPayEnabled} onChange={(v) => set('mpesaPayEnabled', v)} label="M-Pesa Pay now" />
        </label>
        <TextArea label="Other ways to pay" value={d.paymentInstructions} onChange={(v) => set('paymentInstructions', v)} rows={3}
          placeholder={'e.g. Bank: KCB, A/C 1234567890, Branch: Moi Avenue\nUse the invoice number as the reference.'} hint="Shown on invoices. Record these payments on the invoice when they arrive." />
      </Group>

      <Group title="Trials and overdue invoices" hint="What happens, and when, if an invoice isn't paid.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Free trial (days)" inputMode="numeric" value={String(d.trialDays)} onChange={num('trialDays')} error={errors.trialDays} hint="For new platforms." />
          <Input label="Final notice after (days)" inputMode="numeric" value={String(d.pastDueDays)} onChange={num('pastDueDays')} error={errors.pastDueDays} hint="Days past the due date." />
          <Input label="Grace period (days)" inputMode="numeric" value={String(d.graceDays)} onChange={num('graceDays')} error={errors.graceDays} hint="Then brands go offline." />
        </div>
        <ol className="grid gap-2 text-sm sm:grid-cols-4" aria-label="Overdue timeline">
          {[
            ['Invoice sent', `Due in ${draft.daysUntilDue} day${draft.daysUntilDue === 1 ? '' : 's'}`, 'info'],
            ['Overdue', 'The day after the due date · reminder sent', 'warn'],
            ['Final notice', `${draft.pastDueDays} day${draft.pastDueDays === 1 ? '' : 's'} after the due date`, 'warn'],
            ['Suspended', `${draft.graceDays} day${draft.graceDays === 1 ? '' : 's'} later · brands offline until paid`, 'down'],
          ].map(([t, sub, tone], i) => (
            <li key={t} className="flex gap-2 rounded-xl border border-border p-3">
              <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                tone === 'down' ? 'bg-down/15 text-down' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-info/15 text-info')}>{i + 1}</span>
              <span><span className="font-medium">{t}</span><span className="block text-xs text-muted">{sub}</span></span>
            </li>
          ))}
        </ol>
      </Group>

      {changed.length ? (
      <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8" role="region" aria-label="Unsaved changes">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setD(null); }}>Discard</Button>
            <Button size="sm" disabled={!!Object.keys(errors).length || save.isPending} onClick={() => {
              const patch: Record<string, unknown> = {}; for (const k of changed) patch[k] = draft[k];
              save.mutate(patch as Partial<BillingSettings>, {
                onSuccess: () => { toast.push({ tone: 'success', title: 'Billing settings saved' }); setD(null); },
                onError: (e) => toast.push({ tone: 'error', title: 'Not saved', description: errMsg(e) }),
              });
            }}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </div>
      </div>
      ) : null}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-border pb-6 last:border-0 lg:grid-cols-[240px_1fr]">
      <div><h2 className="text-sm font-semibold">{title}</h2>{hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}</div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

function TextArea({ label, value, onChange, rows, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; rows: number; placeholder?: string; hint?: string }) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label} <span className="text-xs font-normal text-muted">(optional)</span></span>
      <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="rounded-brand border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent" />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}


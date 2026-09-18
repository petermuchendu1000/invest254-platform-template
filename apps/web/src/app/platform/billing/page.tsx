'use client';

/**
 * Billing console (Issue 2). System owner: manage every platform's plan, status and payments.
 * Platform admin: a clear, read-only summary of their own plan, status, next-due date and usage.
 * UX (SaaS billing best practice): explicit plan summary, unambiguous status badges, dunning shown
 * as a normal state with a one-step fix (record payment), usage-vs-limit meters.
 */
import { useMemo, useState } from 'react';
import { PageHeader, Section, StatCard, TableWrap, Th, Td } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import { usePlatforms } from '@/lib/platform/hooks';
import { usePlans, useSubscription, useMySubscription, useSetPlan, useSetSubStatus, useRecordPayment } from '@/lib/ops/hooks';
import type { PlatformSubscription, PlatformUsage } from '@/lib/ops/endpoints';
import { ApiError } from '@/lib/api/client';

const SUB_STATUS: Record<string, string> = {
  trial: 'border-accent/40 bg-accent/10 text-accent', active: 'border-up/40 bg-up/10 text-up',
  past_due: 'border-warn/40 bg-warn/10 text-warn', grace_period: 'border-warn/40 bg-warn/10 text-warn',
  suspended: 'border-down/40 bg-down/10 text-down', cancelled: 'border-border bg-surface-2 text-muted',
};
const badge = (s: string) => <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${SUB_STATUS[s] ?? 'border-border bg-surface-2 text-muted'}`}>{s.replace('_', ' ')}</span>;
const kes = (cents: number | null | undefined) => (cents == null ? 'Custom' : `KES ${(cents / 100).toLocaleString()}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

function UsageMeter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max == null ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  const over = max != null && used >= max;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs"><span className="text-muted">{label}</span><span className={over ? 'text-down font-medium' : 'text-fg'}>{used}{max == null ? '' : ` / ${max}`}{max == null ? ' (unlimited)' : ''}</span></div>
      {max != null ? <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"><div className={`h-full ${over ? 'bg-down' : pct > 80 ? 'bg-warn' : 'bg-up'}`} style={{ width: `${pct}%` }} /></div> : null}
    </div>
  );
}

export default function BillingPage() {
  const role = useSession((s) => s.user?.role);
  const isSystem = role === 'platform_superadmin';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing & subscriptions" subtitle={isSystem ? 'Manage every platform\'s plan, status and payments.' : 'Your platform\'s plan, status and usage.'} />
      {isSystem ? <SystemBilling /> : <MyBilling />}
    </div>
  );
}

function MyBilling() {
  const q = useMySubscription();
  const sub = q.data?.subscription; const usage = q.data?.usage;
  const plans = usePlans().data?.plans ?? [];
  const plan = plans.find((p) => p.key === sub?.planKey);
  if (q.isLoading) return <Card><div className="p-6 text-sm text-muted">Loading…</div></Card>;
  if (!sub || !usage) return <Card><div className="p-6 text-sm text-muted">No subscription found for your platform.</div></Card>;
  const dunning = sub.status === 'past_due' || sub.status === 'grace_period';
  const off = sub.status === 'suspended' || sub.status === 'cancelled';
  return (
    <div className="flex flex-col gap-4">
      {dunning ? <Card><div className="border-l-4 border-warn p-4 text-sm"><b>Payment needed.</b> Your subscription is {sub.status.replace('_', ' ')}. Settle with your System admin before {when(sub.graceEndsAt ?? sub.currentPeriodEnd)} to avoid suspension.</div></Card> : null}
      {off ? <Card><div className="border-l-4 border-down p-4 text-sm"><b>Platform {sub.status}.</b> Your brands are offline to players. Contact your System admin to reactivate.</div></Card> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Plan" value={plan?.name ?? sub.planKey} hint={kes(sub.customPriceCents ?? plan?.priceCents) + (plan?.priceCents || sub.customPriceCents ? '/mo' : '')} />
        <StatCard label="Status" value={sub.status.replace('_', ' ')} tone={sub.status === 'active' ? 'up' : off ? 'down' : dunning ? 'warn' : 'default'} />
        <StatCard label="Next due" value={when(sub.currentPeriodEnd)} hint={sub.status === 'trial' ? `trial ends ${when(sub.trialEndsAt)}` : ''} />
      </div>
      <Section title="Usage"><Card><div className="flex flex-col gap-4 p-4">
        <UsageMeter label="Sites" used={usage.sites} max={usage.maxSites} />
        <UsageMeter label="Users" used={usage.users} max={usage.maxUsers} />
      </div></Card></Section>
    </div>
  );
}

function SystemBilling() {
  const platformsQ = usePlatforms();
  const platforms = useMemo(() => platformsQ.data?.platforms ?? [], [platformsQ.data]);
  const [manage, setManage] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Section title="Platforms">
        {platformsQ.isLoading ? <Card><div className="p-6 text-sm text-muted">Loading…</div></Card>
          : platforms.length === 0 ? <Card><div className="p-6 text-sm text-muted">No platforms yet.</div></Card>
          : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr><Th>Platform</Th><Th>Status</Th><Th className="text-right">Actions</Th></tr></thead>
              <tbody>
                {platforms.map((p) => (
                  <tr key={p.platformId} className="border-t border-border">
                    <Td><div className="flex flex-col"><span className="font-medium">{p.name}</span><span className="text-xs text-muted">{p.slug}</span></div></Td>
                    <Td>{badge(p.status)}</Td>
                    <Td className="text-right"><Button size="sm" variant="outline" onClick={() => setManage({ id: p.platformId, name: p.name })}>Manage billing</Button></Td>
                  </tr>))}
              </tbody>
            </table>
          </TableWrap>)}
      </Section>
      {manage ? <ManageModal platformId={manage.id} name={manage.name} onClose={() => setManage(null)} /> : null}
    </div>
  );
}

function ManageModal({ platformId, name, onClose }: { platformId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const q = useSubscription(platformId); const plansQ = usePlans();
  const setPlan = useSetPlan(platformId); const setStatus = useSetSubStatus(platformId); const pay = useRecordPayment(platformId);
  const sub = q.data?.subscription as PlatformSubscription | null | undefined;
  const usage = q.data?.usage as PlatformUsage | null | undefined;
  const plans = plansQ.data?.plans ?? [];
  const [planKey, setPlanKey] = useState(''); const [customPrice, setCustomPrice] = useState(''); const [amount, setAmount] = useState('');
  const err = (e: unknown) => toast.push({ tone: 'error', title: 'Failed', description: e instanceof ApiError ? e.message : String(e) });
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.push({ tone: 'success', title: ok }); } catch (e) { err(e); } };
  const effPlan = planKey || sub?.planKey || 'starter';

  return (
    <Modal open onClose={onClose} title={`Billing — ${name}`}>
      {!sub || !usage ? <div className="p-4 text-sm text-muted">Loading…</div> : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">{badge(sub.status)}<span className="text-muted">plan: <b className="text-fg">{sub.planKey}</b></span><span className="text-muted">next due: {when(sub.currentPeriodEnd)}</span></div>
          <div className="flex flex-col gap-3"><UsageMeter label="Sites" used={usage.sites} max={usage.maxSites} /><UsageMeter label="Users" used={usage.users} max={usage.maxUsers} /></div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h4 className="text-sm font-semibold">Plan</h4>
            <select className="rounded-brand border border-border bg-surface px-3 py-2 text-sm" value={effPlan} onChange={(e) => setPlanKey(e.target.value)}>
              {plans.map((p) => <option key={p.key} value={p.key}>{p.name} — {p.priceCents == null ? 'custom' : kes(p.priceCents) + '/mo'} · {p.maxSites ?? '∞'} sites / {p.maxUsers ?? '∞'} users</option>)}
            </select>
            {effPlan === 'enterprise' ? <Input label="Custom price (KES/mo, optional)" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="e.g. 120000" /> : null}
            <div><Button size="sm" onClick={() => act(() => setPlan.mutateAsync({ planKey: effPlan, customPriceCents: customPrice ? Math.round(Number(customPrice) * 100) : null }), 'Plan updated')} disabled={setPlan.isPending}>Save plan</Button></div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h4 className="text-sm font-semibold">Record payment</h4>
            <div className="flex gap-2"><Input placeholder="Amount (KES)" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button onClick={() => act(() => pay.mutateAsync({ amountCents: Math.round(Number(amount || '0') * 100) }), 'Payment recorded → Active')} disabled={pay.isPending}>Mark paid</Button></div>
            <p className="text-xs text-muted">Records a payment, moves the platform to Active and extends the billing period.</p>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h4 className="text-sm font-semibold">Status</h4>
            <div className="flex flex-wrap gap-2">
              {sub.status !== 'active' ? <Button size="sm" variant="outline" onClick={() => act(() => setStatus.mutateAsync({ status: 'active' }), 'Activated')}>Activate</Button> : null}
              {sub.status !== 'suspended' ? <Button size="sm" variant="down" onClick={() => act(() => setStatus.mutateAsync({ status: 'suspended', reason: 'manual' }), 'Suspended (brands offline)')}>Suspend</Button> : null}
              {sub.status !== 'cancelled' ? <Button size="sm" variant="outline" onClick={() => act(() => setStatus.mutateAsync({ status: 'cancelled', reason: 'manual' }), 'Cancelled')}>Cancel</Button> : null}
            </div>
            <p className="text-xs text-muted">Suspend/Cancel takes the platform's brands offline for players; admins can still sign in.</p>
          </div>
        </div>)}
    </Modal>
  );
}

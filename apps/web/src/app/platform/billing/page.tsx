'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useCan } from '@/lib/auth/can';
import { PageHeader } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { PageTabs, useTabParam } from '@/components/admin/Tabs';
import { useToast } from '@/lib/toast/ToastProvider';
import { useRunBilling } from '@/lib/billing/api';
import { MyBilling } from '@/components/billing/MyBilling';
import { OwnerOverview } from '@/components/billing/OwnerOverview';
import { ManageAccount, NewInvoiceModal, OwnerAccounts } from '@/components/billing/OwnerAccounts';
import { OwnerInvoices, OwnerPlans, OwnerSettings } from '@/components/billing/OwnerSetup';
import { errMsg } from '@/components/billing/parts';

/**
 * BILL-1 (docs/47) — Billing.
 * System owner: revenue overview, every invoice, every platform's subscription, the plan catalogue and the
 * billing settings (Stripe Billing / Chargebee layout). Platform admin: its own plan, balance and invoices with
 * M-Pesa Pay now (the Stripe customer-portal layout).
 */
const TABS = [
  { id: 'overview', label: 'Overview', hint: 'Revenue, money owed, who needs attention' },
  { id: 'invoices', label: 'Invoices', hint: 'Every invoice, by state and platform' },
  { id: 'subscriptions', label: 'Subscriptions', hint: 'Each platform’s plan, standing and balance' },
  { id: 'plans', label: 'Plans', hint: 'Prices and limits' },
  { id: 'settings', label: 'Settings', hint: 'Invoice details, terms, tax, payment and overdue handling' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function BillingPage() {
  const isOwner = useCan('console.system');
  return isOwner ? <OwnerBilling /> : (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing" />
      <MyBilling />
    </div>
  );
}

function OwnerBilling() {
  const [tab, setTab] = useTabParam<Tab>(TABS.map((t) => t.id), 'overview');
  const [manage, setManage] = React.useState<string | null>(null);
  const [newFor, setNewFor] = React.useState<string | 'pick' | null>(null);
  const run = useRunBilling();
  const toast = useToast();
  const router = useRouter();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Billing"
        actions={<>
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(undefined, {
            onSuccess: (r) => toast.push({ tone: 'success', title: 'Billing run finished', description: `${r.issued} invoice${r.issued === 1 ? '' : 's'} sent · ${r.transitions} status change${r.transitions === 1 ? '' : 's'} · ${r.reminders} reminder${r.reminders === 1 ? '' : 's'}` }),
            onError: (e) => toast.push({ tone: 'error', title: 'Run failed', description: errMsg(e) }),
          })}>{run.isPending ? 'Running…' : 'Run billing now'}</Button>
          <Button size="sm" onClick={() => setNewFor('pick')}>New invoice</Button>
        </>} />
      <PageTabs tabs={TABS} value={tab} onChange={setTab} label="Billing sections" />
      {tab === 'overview' ? <OwnerOverview onManage={setManage} />
        : tab === 'invoices' ? <OwnerInvoices />
          : tab === 'subscriptions' ? <OwnerAccounts onManage={setManage} />
            : tab === 'plans' ? <OwnerPlans /> : <OwnerSettings />}
      <ManageAccount platformId={manage} onClose={() => setManage(null)} onNewInvoice={(p) => { setManage(null); setNewFor(p); }} />
      <NewInvoiceModal platformId={newFor} onClose={() => setNewFor(null)} onCreated={(id) => { setNewFor(null); router.push(`/platform/billing/invoices/${id}`); }} />
    </div>
  );
}

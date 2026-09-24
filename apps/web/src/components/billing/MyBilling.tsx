'use client';

import * as React from 'react';
import Link from 'next/link';
import { formatKes } from '@invest254/shared/money';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty, Section } from '@/components/admin/ui';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useBillingAccounts, useBillingPlans, useBillingSettings, useCharges, useInvoices, type InvoiceSummary } from '@/lib/billing/api';
import { subState, limitText, LINE_KIND } from '@/lib/billing/labels';
import { InvoiceList, Meter, PayNowModal, SubPill } from './parts';

/**
 * BILL-1 — the platform admin's billing page (the Stripe customer-portal pattern): what you pay and when,
 * whether anything is due (one clear "Pay" action), what you use against your plan, every invoice, and the
 * plans side by side. Dunning is shown as consequences with a date ("brands go offline on …"), never jargon.
 */
export function MyBilling() {
  const acc = useBillingAccounts();
  const a = acc.data?.accounts[0];
  const invs = useInvoices({ limit: 100 });
  const plans = useBillingPlans();
  const settings = useBillingSettings();
  const charges = useCharges(a?.platformId ?? null);
  const [paying, setPaying] = React.useState<string | null>(null);

  if (acc.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!a) return <Empty title="No subscription yet" description="Your platform has no plan on record. Contact the System owner from Tickets." />;

  const invoices = invs.data?.invoices ?? [];
  const open = invoices.filter((i) => i.status === 'open').sort((x, y) => x.dueAt.localeCompare(y.dueAt));
  const oldest = open[0];
  const pendingCents = (charges.data?.charges ?? []).reduce((s, c) => s + c.amountCents, 0);
  const estimate = (a.priceCents ?? 0) + a.monthlyAddonsCents + pendingCents;
  const st = subState(a.status);

  return (
    <div className="flex flex-col gap-6">
      {a.billingExempt ? (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">This platform is not billed. There is nothing to pay.</div>
      ) : oldest ? <DueBanner status={a.status} oldest={oldest} total={a.balanceDueCents} graceEndsAt={a.graceEndsAt} onPay={() => setPaying(oldest.id)} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Your plan</div>
              <div className="mt-1 text-xl font-semibold">{a.planName ?? a.planKey}</div>
            </div>
            <SubPill status={a.status} />
          </div>
          <div className="text-2xl font-bold tabular-nums">{a.priceCents == null ? 'Custom' : formatKes(a.priceCents)}<span className="text-sm font-normal text-muted"> / {a.billingPeriod === 'year' ? 'year' : 'month'}</span></div>
          <p className="text-sm text-muted">{st.meaning}</p>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-muted">Next invoice</div>
          {a.nextInvoiceAt && !a.billingExempt ? <>
            <div className="text-xl font-semibold">{formatDate(a.nextInvoiceAt)}</div>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt className="text-muted">Plan</dt><dd className="text-right tabular-nums">{a.priceCents == null ? 'Custom' : formatKes(a.priceCents)}</dd>
              {a.monthlyAddonsCents ? <><dt className="text-muted">Monthly add-ons</dt><dd className="text-right tabular-nums">{formatKes(a.monthlyAddonsCents)}</dd></> : null}
              {pendingCents ? <><dt className="text-muted">One-off charges</dt><dd className="text-right tabular-nums">{formatKes(pendingCents)}</dd></> : null}
              <dt className="border-t border-border pt-1 font-medium">Estimated total</dt><dd className="border-t border-border pt-1 text-right font-semibold tabular-nums">{formatKes(Math.max(0, estimate))}</dd>
            </dl>
            <p className="text-xs text-muted">Sent on that date and due {settings.data?.daysUntilDue ?? 7} days later. Tax, if any, is added on the invoice.</p>
          </> : <p className="text-sm text-muted">{a.billingExempt ? 'Not billed.' : a.status === 'suspended' ? 'Renewals resume once the overdue invoice is paid.' : 'No renewal scheduled.'}</p>}
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-muted">Usage</div>
          <Meter label="Brands" used={a.sites} max={a.maxSites} />
          <Meter label="Players" used={a.users} max={a.maxUsers} />
          {a.lastPaymentAt ? <p className="text-xs text-muted">Last payment {formatDate(a.lastPaymentAt)}</p> : null}
        </div>
      </div>

      {(charges.data?.charges.length ?? 0) > 0 ? (
        <Section title="Waiting for your next invoice">
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {charges.data!.charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0"><div className="truncate">{c.description}</div><div className="text-xs text-muted">{LINE_KIND[c.kind] ?? c.kind} · added {formatDate(c.createdAt)}</div></div>
                <span className={cn('whitespace-nowrap tabular-nums', c.amountCents < 0 && 'text-up')}>{formatKes(c.amountCents)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Invoices">
        {invs.isLoading ? <Skeleton className="h-40 w-full" /> : (
          <InvoiceList invoices={invoices} onPay={settings.data?.mpesaPayEnabled === false ? undefined : (i) => setPaying(i.id)}
            emptyTitle="No invoices yet" emptyText={a.nextInvoiceAt ? `Your first invoice is sent on ${formatDate(a.nextInvoiceAt)}.` : undefined} />
        )}
      </Section>

      {settings.data?.paymentInstructions ? (
        <Section title="Other ways to pay">
          <div className="whitespace-pre-line rounded-2xl border border-border bg-surface p-4 text-sm">{settings.data.paymentInstructions}</div>
        </Section>
      ) : null}

      <Section title="Plans">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(plans.data?.plans ?? []).map((p) => {
            const current = p.key === a.planKey;
            return (
              <div key={p.key} className={cn('flex flex-col gap-2 rounded-2xl border bg-surface p-4', current ? 'border-accent ring-1 ring-accent' : 'border-border')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {current ? <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">Current plan</span> : null}
                </div>
                <div className="text-xl font-bold tabular-nums">{p.priceCents == null ? 'Custom' : formatKes(p.priceCents)}<span className="text-sm font-normal text-muted"> / {p.billingPeriod}</span></div>
                <ul className="flex flex-col gap-1 text-sm text-muted">
                  <li>{limitText(p.maxSites, p.maxSites === 1 ? 'brand' : 'brands')}</li>
                  <li>{limitText(p.maxUsers, 'players')}</li>
                </ul>
              </div>
            );
          })}
        </div>
        <p className="text-sm text-muted">To change your plan, <Link href="/platform/tickets" className="text-accent hover:underline">open a ticket</Link> — the System owner switches it and the new price applies from your next invoice.</p>
      </Section>

      <PayNowModal invoiceId={paying} open={!!paying} onClose={() => setPaying(null)} />
    </div>
  );
}

function DueBanner({ status, oldest, total, graceEndsAt, onPay }: { status: string; oldest: InvoiceSummary; total: number; graceEndsAt: string | null; onPay: () => void }) {
  const severe = status === 'grace_period' || status === 'suspended';
  const title = status === 'suspended' ? 'Your brands are offline'
    : status === 'grace_period' ? `Pay by ${graceEndsAt ? formatDate(graceEndsAt) : 'the end of the grace period'} to keep your brands online`
      : oldest.overdue ? `${oldest.number} is overdue` : `${oldest.number} is due ${formatDate(oldest.dueAt)}`;
  const body = status === 'suspended' ? 'Players cannot sign up, deposit or play until the overdue invoice is paid. Paying brings everything back straight away.'
    : status === 'grace_period' ? 'This is the final notice. After that date players can no longer sign up, deposit or play on your brands.'
      : oldest.overdue ? 'Pay now to avoid your brands being taken offline.' : 'Pay any time before the due date.';
  return (
    <div role={severe ? 'alert' : 'status'} className={cn('flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between',
      severe ? 'border-down/40 bg-down/10' : oldest.overdue ? 'border-warn/40 bg-warn/10' : 'border-border bg-surface')}>
      <div className="min-w-0">
        <p className={cn('font-semibold', severe ? 'text-down' : oldest.overdue ? 'text-warn' : 'text-fg')}>{title}</p>
        <p className="text-sm text-muted">{body} Balance due: <b className="whitespace-nowrap text-fg tabular-nums">{formatKes(total)}</b>.</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Link href={`/platform/billing/invoices/${oldest.id}`} className="inline-flex h-9 items-center rounded-brand border border-border px-3 text-sm font-medium hover:bg-surface-2">View invoice</Link>
        <Button size="sm" variant={severe ? 'down' : 'primary'} onClick={onPay}>Pay {formatKes(oldest.amountDueCents)}</Button>
      </div>
    </div>
  );
}

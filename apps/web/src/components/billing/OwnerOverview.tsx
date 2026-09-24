'use client';

import * as React from 'react';
import Link from 'next/link';
import { formatKes } from '@invest254/shared/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty, Section, StatCard, TableWrap, Th, Td } from '@/components/admin/ui';
import { formatDate, formatAgo } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useBillingAccounts, useBillingOverview, type BillingAccount } from '@/lib/billing/api';
import { METHOD, subState } from '@/lib/billing/labels';
import { Pill, SubPill } from './parts';

const AGING = [
  { key: 'current', label: 'Not yet due', cls: 'bg-info' },
  { key: 'd1_30', label: '1–30 days late', cls: 'bg-warn/60' },
  { key: 'd31_60', label: '31–60 days', cls: 'bg-warn' },
  { key: 'd61_90', label: '61–90 days', cls: 'bg-down/70' },
  { key: 'd90p', label: '90+ days', cls: 'bg-down' },
] as const;

/** Owner revenue overview (Stripe Billing / Chargebee dashboards): recurring revenue, money owed and how late, who needs attention. */
export function OwnerOverview({ onManage }: { onManage: (platformId: string) => void }) {
  const o = useBillingOverview();
  const acc = useBillingAccounts();
  if (o.isLoading || !o.data) return <Skeleton className="h-96 w-full" />;
  const d = o.data;
  const accounts = acc.data?.accounts ?? [];
  const attention = accounts.filter((a) => !a.billingExempt && (a.overdueCents > 0 || ['past_due', 'grace_period', 'suspended'].includes(a.status)))
    .sort((x, y) => rank(y) - rank(x) || y.overdueCents - x.overdueCents);
  const delta = d.collectedLastMonthCents > 0 ? Math.round(((d.collectedThisMonthCents - d.collectedLastMonthCents) / d.collectedLastMonthCents) * 100) : null;
  const agingTotal = Object.values(d.aging).reduce((s, v) => s + v, 0);
  const paying = (d.statusCounts.active ?? 0) + (d.statusCounts.past_due ?? 0) + (d.statusCounts.grace_period ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Monthly recurring" money={d.mrrCents} hint={`${formatKes(d.arrCents)} a year · ${paying} paying platform${paying === 1 ? '' : 's'}`} />
        <StatCard label="Outstanding" money={d.outstandingCents} hint="All open invoices" />
        <StatCard label="Overdue" money={d.overdueCents} tone={d.overdueCents > 0 ? 'down' : 'default'} hint={d.overdueCents > 0 ? 'Past the due date' : 'Nothing late'} />
        <StatCard label="Collected this month" money={d.collectedThisMonthCents} tone="up"
          hint={delta == null ? `Last month ${formatKes(d.collectedLastMonthCents)}` : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs last month`} />
      </div>

      <Section title="Money owed, by how late it is">
        <div className="rounded-2xl border border-border bg-surface p-4">
          {agingTotal === 0 ? <p className="text-sm text-muted">Nothing is owed right now.</p> : <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2" role="img"
              aria-label={AGING.map((a) => `${a.label} ${formatKes(d.aging[a.key])}`).join(', ')}>
              {AGING.map((a) => d.aging[a.key] > 0 ? <div key={a.key} className={a.cls} style={{ width: `${(d.aging[a.key] / agingTotal) * 100}%` }} /> : null)}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              {AGING.map((a) => (
                <li key={a.key} className="flex flex-col">
                  <span className="flex items-center gap-1.5 text-xs text-muted"><span className={cn('h-2 w-2 rounded-full', a.cls)} />{a.label}</span>
                  <span className="font-medium tabular-nums">{formatKes(d.aging[a.key])}</span>
                </li>
              ))}
            </ul>
          </>}
        </div>
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Needs attention">
          {attention.length === 0 ? <Empty title="Every platform is paid up" description="Overdue and suspended platforms show here with what they owe." /> : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
              {attention.map((a) => (
                <li key={a.platformId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><span className="truncate font-medium">{a.platformName}</span><SubPill status={a.status} /></div>
                    <div className="text-xs text-muted">{a.status === 'grace_period' && a.graceEndsAt ? `Goes offline ${formatDate(a.graceEndsAt)} · ` : ''}{subState(a.status).meaning}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap font-semibold tabular-nums text-down">{formatKes(a.overdueCents || a.balanceDueCents)}</span>
                    <button type="button" onClick={() => onManage(a.platformId)} className="text-sm font-medium text-accent hover:underline">Manage</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Renewing in the next 14 days">
          {d.upcoming.length === 0 ? <Empty title="No renewals in the next two weeks" /> : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
              {d.upcoming.map((u) => (
                <li key={u.platformId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0"><div className="truncate font-medium">{u.platformName}</div><div className="text-xs text-muted">Invoice on {formatDate(u.at)}</div></div>
                  <span className="whitespace-nowrap tabular-nums">{u.amountCents ? formatKes(u.amountCents) : 'Custom'}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Recent payments">
        {d.recentPayments.length === 0 ? <Empty title="No payments yet" description="Payments by M-Pesa and ones you record show here." /> : (
          <TableWrap>
            <thead className="border-b border-border"><tr><Th>When</Th><Th>Platform</Th><Th>Invoice</Th><Th>Method</Th><Th numeric>Amount</Th></tr></thead>
            <tbody className="divide-y divide-border">
              {d.recentPayments.map((p) => (
                <tr key={p.id}>
                  <Td className="whitespace-nowrap text-muted">{formatAgo(new Date(p.settledAt).getTime())}</Td>
                  <Td>{p.platformName}</Td>
                  <Td><Link href={`/platform/billing/invoices/${p.invoiceId}`} className="font-mono hover:text-accent">{p.number}</Link></Td>
                  <Td>{METHOD[p.method] ?? p.method}{p.reference ? <span className="font-mono text-xs text-muted"> · {p.reference}</span> : null}</Td>
                  <Td numeric className="font-medium text-up">{formatKes(p.amountCents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>

      {Object.keys(d.statusCounts).length ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          Subscriptions:
          {Object.entries(d.statusCounts).map(([s, n]) => <Pill key={s} label={`${n} ${subState(s).label.toLowerCase()}`} tone={subState(s).tone} />)}
        </p>
      ) : null}
    </div>
  );
}

function rank(a: BillingAccount) { return a.status === 'suspended' ? 3 : a.status === 'grace_period' ? 2 : a.status === 'past_due' ? 1 : 0; }

'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader, Section, Empty } from '@/components/admin/ui';
import { KpiCard, kesCompact, trendDelta, type Point } from '@/components/admin/charts';
import { useOverview, useRtp, useReportDaily } from '@/lib/admin/hooks';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function AdminOverviewPage() {
  return (
    <>
      <PageHeader title="Overview" subtitle="The last 30 days at a glance, and what needs you now. Details live on the page each item links to." />
      <TrendsSection />
      <Attention />
    </>
  );
}

/**
 * UI-F: "Needs attention" — only queues and alerts, each linking to the ONE page that handles it. The user,
 * balance and return-to-player panels that sat here repeated Users, Finance and Reports.
 */
function Attention() {
  const o = useOverview();
  const rtp = useRtp();
  if (o.isLoading) return <Skeleton className="h-32 w-full" />;
  if (o.isError || !o.data) return <Empty title="Couldn't load what needs attention" description="Check your connection and try again." />;
  const d = o.data;
  const items: { href: string; label: string; value: string; tone: 'warn' | 'down' | 'ok' }[] = [
    { href: '/admin/withdrawals', label: 'Withdrawals waiting for review', value: String(d.finance.pendingWithdrawals), tone: d.finance.pendingWithdrawals ? 'warn' : 'ok' },
    { href: '/admin/marketer-finance', label: 'Marketer payouts waiting', value: String(d.affiliate.pendingPayouts), tone: d.affiliate.pendingPayouts ? 'warn' : 'ok' },
    { href: '/admin/users?status=suspended', label: 'Suspended or banned accounts', value: `${d.users.suspended + d.users.banned}`, tone: d.users.banned ? 'down' : 'ok' },
    { href: '/admin/reports?tab=health', label: 'Return to player', value: rtp.data ? (rtp.data.alert ? 'Outside the allowed range' : 'Within range') : '…', tone: rtp.data?.alert ? 'down' : 'ok' },
  ];
  return (
    <Section title="Needs attention">
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Needs attention">
        {items.map((i) => (
          <li key={i.href}>
            <Link href={i.href} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 transition hover:bg-surface-2">
              <span className="text-sm">{i.label}</span>
              <span className={'whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold ' + (i.tone === 'down' ? 'bg-down/15 text-down' : i.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-surface-2 text-muted')}>{i.value}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** 30-day financial trend charts, derived from the daily report time series. */
function TrendsSection() {
  const from = useMemo(() => isoDaysAgo(30), []);
  const to = useMemo(() => isoDaysAgo(0), []);
  const q = useReportDaily({ from, to });

  const rows = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date)), [q.data]);

  const shortDay = (d: string) => d.slice(5); // MM-DD
  const deposits: Point[] = rows.map((r) => ({ label: shortDay(r.date), value: r.depositsCents }));
  const withdrawals: Point[] = rows.map((r) => ({ label: shortDay(r.date), value: r.withdrawalsCents }));
  const turnover: Point[] = rows.map((r) => ({ label: shortDay(r.date), value: r.turnoverCents }));
  const ggr: Point[] = rows.map((r) => ({ label: shortDay(r.date), value: r.ggrCents }));

  const sum = (pts: Point[]) => pts.reduce((s, p) => s + p.value, 0);
  const ggrTotal = sum(ggr);

  // Trend delta: last 15 days vs the 15 before (a quick "is it growing?" signal). UI-C: when the earlier
  // half had nothing, a percentage is undefined — the old code showed a fake "▲100%"; now it says "New".
  const trend = (pts: Point[]) => trendDelta(pts.map((p) => p.value));
  const deltaHint = 'last 15 days vs the 15 days before';

  return (
    <Section title="Trends — last 30 days">
      {q.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : q.isError ? (
        <Empty title="Trends unavailable" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No activity yet" description="Charts populate as deposits, trades and payouts accrue." />
      ) : (
        <div className="flex flex-col gap-3">
          {/* KPI sparkline row — the four numbers an owner scans first, mobile-first (2-up, then 4-up). */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Deposits" value={kesCompact(sum(deposits))} series={deposits} tone="up" {...trend(deposits)} deltaHint={deltaHint} />
            <KpiCard label="Withdrawals" value={kesCompact(sum(withdrawals))} series={withdrawals} tone="down" goodWhen="neutral" {...trend(withdrawals)} deltaHint={deltaHint} />
            <KpiCard label="Turnover" value={kesCompact(sum(turnover))} series={turnover} tone="accent" {...trend(turnover)} deltaHint={deltaHint} />
            <KpiCard label="House revenue" value={kesCompact(ggrTotal)} series={ggr} tone={ggrTotal >= 0 ? 'up' : 'down'} {...trend(ggr)} deltaHint={deltaHint} />
          </div>

          {/* Full daily cash-flow + GGR charts and per-day/per-player breakdowns live on Reports —
              linked here (not duplicated) so the Overview stays a compact launchpad. */}
          <Link href="/admin/reports" className="self-start text-xs font-medium text-accent hover:underline">
            Full daily / date-range breakdowns → Reports
          </Link>
        </div>
      )}
    </Section>
  );
}

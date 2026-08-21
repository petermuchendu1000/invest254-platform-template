'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { useSession } from '@/lib/auth/session';
import { PageHeader, StatCard, Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { KpiCard, kesCompact, type Point } from '@/components/admin/charts';
import { useOverview, useRtp, useReportDaily } from '@/lib/admin/hooks';
import { RealCashRtpPanel, ConfigChangeReviewPanel } from '@/components/admin/EconomyIntegrityPanels';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function AdminOverviewPage() {
  const o = useOverview();
  const rtp = useRtp();
  const myRole = useSession((s) => s.user?.role);
  // Owner tier = superadmin OR the higher platform_superadmin (mirrors AdminShell/API hierarchy).
  const isSuper = myRole === 'superadmin' || myRole === 'platform_superadmin';

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          isSuper
            ? 'System owner view — full operational health across users, finance and game.'
            : 'Operations view — users, finance, affiliate and game health.'
        }
      />

      <TrendsSection />

      {o.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : o.isError || !o.data ? (
        <Empty title="Couldn't load overview" description="Check your connection and try again." />
      ) : (
        <>
          {/* Compact users summary — the full population table + per-user actions live on /admin/users. */}
          <Section title="Users">
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Total users" value={o.data.users.total} hint={`${o.data.users.active} active · ${o.data.users.players} players · ${o.data.users.marketers} marketers`} />
                <StatCard
                  label="Suspended / banned"
                  value={`${o.data.users.suspended} / ${o.data.users.banned}`}
                  tone={o.data.users.banned > 0 ? 'down' : 'default'}
                />
              </div>
              <Link href="/admin/users" className="self-start text-xs font-medium text-accent hover:underline">
                Manage all users (players, marketers, staff) →
              </Link>
            </div>
          </Section>

          {/* Operational balances & queues only — money-flow totals/trends live in the Trends KPIs above
              (deliberately not repeated here). Each card is a distinct liability or action queue. */}
          <Section title="Balances & queues">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Pending withdrawals"
                value={o.data.finance.pendingWithdrawals}
                tone={o.data.finance.pendingWithdrawals > 0 ? 'warn' : 'default'}
                hint="awaiting review"
              />
              <StatCard label="Wallet liability" money={o.data.finance.walletLiabilityCents} hint="owed to players" />
              <StatCard label="Commission accrued" money={o.data.affiliate.commissionAccruedCents} hint="owed to marketers" />
              <StatCard
                label="Pending payouts"
                value={o.data.affiliate.pendingPayouts}
                tone={o.data.affiliate.pendingPayouts > 0 ? 'warn' : 'default'}
                hint="marketer payouts"
              />
            </div>
          </Section>
        </>
      )}

      <Section title="RTP monitor">
        {rtp.isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : rtp.isError || !rtp.data ? (
          <Empty title="RTP unavailable" />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted">
                Target RTP <span className="font-medium text-fg">{pct(rtp.data.targetRtp)}</span> · tolerance ±
                {pct(rtp.data.toleranceAbs)}
              </span>
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' +
                  (rtp.data.alert ? 'bg-down/15 text-down' : 'bg-up/15 text-up')
                }
              >
                {rtp.data.alert ? 'Drift alert' : 'In tolerance'}
              </span>
            </div>
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <Th>Window</Th>
                  <Th>Trades</Th>
                  <Th>Turnover</Th>
                  <Th>Payout</Th>
                  <Th>Realised RTP</Th>
                </tr>
              </thead>
              <tbody>
                {rtp.data.windows.map((w) => {
                  const drift =
                    w.realisedRtp !== null && Math.abs(w.realisedRtp - rtp.data!.targetRtp) > rtp.data!.toleranceAbs;
                  return (
                    <tr key={w.window} className="border-b border-border last:border-0">
                      <Td className="font-medium capitalize">{w.window}</Td>
                      <Td className="tabular-nums">{w.settledPositions}</Td>
                      <Td className="tabular-nums">
                        <Money cents={w.turnoverCents} />
                      </Td>
                      <Td className="tabular-nums">
                        <Money cents={w.payoutCents} />
                      </Td>
                      <Td className={'tabular-nums font-medium ' + (drift ? 'text-down' : 'text-fg')}>
                        {w.realisedRtp === null ? '—' : pct(w.realisedRtp)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
            <p className="text-xs text-muted">
              Realised RTP is payout ÷ turnover per window. A window outside tolerance (with enough samples) flags an
              alert.
            </p>
          </div>
        )}
      </Section>

      {/* Economy integrity (rec #7 + docs/28 §4): real-cash truth + config change review. Owner tier. */}
      {isSuper && (
        <>
          <RealCashRtpPanel />
          <ConfigChangeReviewPanel />
        </>
      )}
    </>
  );
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
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

  // Trend delta: second half vs first half of the window (a quick "is it growing?" signal).
  const deltaPct = (pts: Point[]): number | null => {
    if (pts.length < 4) return null;
    const mid = Math.floor(pts.length / 2);
    const a = sum(pts.slice(0, mid));
    const b = sum(pts.slice(mid));
    if (a === 0) return b > 0 ? 100 : null;
    return ((b - a) / Math.abs(a)) * 100;
  };

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
            <KpiCard label="Deposits" value={kesCompact(sum(deposits))} series={deposits} tone="up" deltaPct={deltaPct(deposits)} />
            <KpiCard label="Withdrawals" value={kesCompact(sum(withdrawals))} series={withdrawals} tone="down" deltaPct={deltaPct(withdrawals)} />
            <KpiCard label="Turnover" value={kesCompact(sum(turnover))} series={turnover} tone="accent" deltaPct={deltaPct(turnover)} />
            <KpiCard label="Net revenue (GGR)" value={kesCompact(ggrTotal)} series={ggr} tone={ggrTotal >= 0 ? 'up' : 'down'} deltaPct={deltaPct(ggr)} />
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

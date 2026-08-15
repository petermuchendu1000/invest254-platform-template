'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { useSession } from '@/lib/auth/session';
import { PageHeader, StatCard, Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { AreaChart, GroupedBars, ChartCard, LegendDot, kesCompact, type Point } from '@/components/admin/charts';
import { useOverview, useRtp, useReportDaily } from '@/lib/admin/hooks';

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
            ? 'System owner view — full operational health plus governance controls.'
            : 'Operations view — users, finance, affiliate and game health.'
        }
      />

      {isSuper ? <GovernancePanel /> : null}

      <TrendsSection />

      {o.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : o.isError || !o.data ? (
        <Empty title="Couldn't load overview" description="Check your connection and try again." />
      ) : (
        <>
          <Section title="Users">
            <div className="card-grid grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Total users" value={o.data.users.total} hint={`${o.data.users.active} active`} />
              <StatCard label="Players" value={o.data.users.players} />
              <StatCard label="Marketers" value={o.data.users.marketers} />
              <StatCard
                label="Suspended / banned"
                value={`${o.data.users.suspended} / ${o.data.users.banned}`}
                tone={o.data.users.banned > 0 ? 'down' : 'default'}
              />
            </div>
          </Section>

          <Section title="Finance">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Deposits" money={o.data.finance.depositsCents} />
              <StatCard label="Withdrawals" money={o.data.finance.withdrawalsCents} />
              <StatCard
                label="Pending withdrawals"
                value={o.data.finance.pendingWithdrawals}
                tone={o.data.finance.pendingWithdrawals > 0 ? 'warn' : 'default'}
                hint="awaiting review"
              />
              <StatCard label="Wallet liability" money={o.data.finance.walletLiabilityCents} hint="owed to players" />
            </div>
          </Section>

          <Section title="Affiliate & game">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Commission accrued" money={o.data.affiliate.commissionAccruedCents} />
              <StatCard
                label="Pending payouts"
                value={o.data.affiliate.pendingPayouts}
                tone={o.data.affiliate.pendingPayouts > 0 ? 'warn' : 'default'}
              />
              <StatCard label="Net revenue (GGR)" money={o.data.game.ggrCents} tone="up" />
              <StatCard label="Turnover" money={o.data.game.turnoverCents} hint={`${o.data.game.settledPositions} trades`} />
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
    </>
  );
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Owner-only quick access to the governance controls a plain admin doesn't have. */
function GovernancePanel() {
  const links = [
    { href: '/admin/users', title: 'Roles & users', desc: 'Promote / demote admins, marketers, players', glyph: '👤' },
    { href: '/admin/game', title: 'Game economy', desc: 'House edge, RTP, stake limits, fairness seeds', glyph: '🎲' },
    { href: '/admin/mpesa', title: 'M-Pesa rails', desc: 'Paybill, callbacks and credentials', glyph: '📲' },
    { href: '/admin/audit', title: 'Audit log', desc: 'Every privileged action, who and when', glyph: '📜' },
  ];
  return (
    <Section title="Governance — owner only">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/5 p-4 transition hover:bg-warn/10"
          >
            <span className="text-xl leading-none">{l.glyph}</span>
            <span className="flex flex-col">
              <span className="text-sm font-semibold text-fg">{l.title}</span>
              <span className="text-xs text-muted">{l.desc}</span>
            </span>
          </Link>
        ))}
      </div>
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

  return (
    <Section title="Trends — last 30 days">
      {q.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : q.isError ? (
        <Empty title="Trends unavailable" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No activity yet" description="Charts populate as deposits, trades and payouts accrue." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ChartCard
            title="Deposits vs withdrawals"
            readout={`${kesCompact(sum(deposits))} in`}
            legend={
              <>
                <LegendDot tone="up" label="Deposits" />
                <LegendDot tone="down" label="Withdrawals" />
              </>
            }
          >
            <GroupedBars
              a={{ label: 'Deposits', points: deposits, tone: 'up' }}
              b={{ label: 'Withdrawals', points: withdrawals, tone: 'down' }}
            />
          </ChartCard>

          <ChartCard title="Turnover" readout={kesCompact(sum(turnover))}>
            <AreaChart points={turnover} tone="accent" />
          </ChartCard>

          <ChartCard title="Net revenue (GGR)" readout={kesCompact(ggrTotal)}>
            <AreaChart points={ggr} tone={ggrTotal >= 0 ? 'up' : 'down'} />
          </ChartCard>

          <ChartCard
            title="Withdrawals"
            readout={`${kesCompact(sum(withdrawals))} out`}
          >
            <AreaChart points={withdrawals} tone="down" />
          </ChartCard>
        </div>
      )}
    </Section>
  );
}

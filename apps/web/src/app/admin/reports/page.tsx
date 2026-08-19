'use client';

import { useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Money } from '@/components/ui/Money';
import { PageHeader, Section, StatCard, TableWrap, Th, Td, Empty, Toolbar } from '@/components/admin/ui';
import { useReportDaily, useReportUsers, useReportDay } from '@/lib/admin/hooks';
import type { DailyReportRow, UserReportRow, AdminDayReport } from '@/lib/admin/types';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
/** Today in Africa/Nairobi (EAT), as YYYY-MM-DD — matches the API's default day. */
function eatToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}
function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

type Tab = 'day' | 'daily' | 'users';

/** Build + trigger a client-side CSV download. */
function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('day');
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  // Top-players ranking direction: 'losers' = GGR desc (most net revenue to the house, i.e. biggest
  // net losers) first; 'winners' = GGR asc (players who are net-winning — a risk signal) first.
  const [usersSort, setUsersSort] = useState<'losers' | 'winners'>('losers');

  const range = { from, to };
  const daily = useReportDaily(range);
  const users = useReportUsers(range);

  const dailyRows = useMemo(() => daily.data?.items ?? [], [daily.data]);
  const userRows = useMemo(() => {
    const rows = users.data?.items ?? [];
    // API returns GGR desc; reverse for the "winners" view. Copy so we never mutate the cache.
    return usersSort === 'winners' ? [...rows].sort((a, b) => a.ggrCents - b.ggrCents) : rows;
  }, [users.data, usersSort]);

  function exportCsv() {
    if (tab === 'daily') {
      downloadCsv(
        `daily-report_${from}_${to}.csv`,
        ['date', 'deposits_cents', 'withdrawals_cents', 'turnover_cents', 'ggr_cents'],
        dailyRows.map((r) => [r.date, r.depositsCents, r.withdrawalsCents, r.turnoverCents, r.ggrCents]),
      );
    } else if (tab === 'users') {
      downloadCsv(
        `user-report_${from}_${to}.csv`,
        ['user_id', 'username', 'deposits_cents', 'withdrawals_cents', 'turnover_cents', 'ggr_cents'],
        userRows.map((r) => [r.userId, r.username, r.depositsCents, r.withdrawalsCents, r.turnoverCents, r.ggrCents]),
      );
    }
  }

  const active = tab === 'daily' ? daily : users;
  const hasRows = tab === 'daily' ? dailyRows.length > 0 : userRows.length > 0;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Pick a single day for a full breakdown, or scope a date range for trends and per-player totals. Export to CSV for accounting."
        actions={
          tab === 'day' ? undefined : (
            <Toolbar>
              <div className="w-36">
                <Input type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="w-36">
                <Input type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </Toolbar>
          )
        }
      />

      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-xl border border-border bg-surface p-0.5">
          {(['day', 'daily', 'users'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg'
                  : 'rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-fg'
              }
            >
              {t === 'day' ? 'Day explorer' : t === 'daily' ? 'Daily trend' : 'Top players'}
            </button>
          ))}
        </div>
        {tab !== 'day' ? (
          <div className="flex items-center gap-2">
            {tab === 'users' ? (
              <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
                <button
                  onClick={() => setUsersSort('losers')}
                  className={usersSort === 'losers' ? 'rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent' : 'rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:text-fg'}
                  title="Highest GGR first — players the house earned the most from"
                >Biggest losers (house +)</button>
                <button
                  onClick={() => setUsersSort('winners')}
                  className={usersSort === 'winners' ? 'rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent' : 'rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:text-fg'}
                  title="Lowest (negative) GGR first — players who are net-winning (risk)"
                >Biggest winners (house −)</button>
              </div>
            ) : null}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!hasRows}>
              Export CSV
            </Button>
          </div>
        ) : null}
      </div>

      {tab === 'day' ? (
        <DayExplorer />
      ) : (
        <Section>
          {active.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : active.isError ? (
            <Empty title="Couldn't load report" description="Try again shortly." />
          ) : !hasRows ? (
            <Empty title="No data in range" description="Adjust the date range to see activity." />
          ) : tab === 'daily' ? (
            <div className="flex flex-col gap-2">
              <ReportNote>
                One row per calendar day in range. <b>Deposits/Withdrawals</b> = successful M‑Pesa
                transactions (withdrawals exclude internal marketer transfers). <b>Turnover</b> = Σ stakes
                on settled trades; <b>GGR</b> = Σ&nbsp;stakes&nbsp;−&nbsp;Σ&nbsp;payouts (positive = house
                profit). Internal marketer accounts are excluded. Computed live from transactions + settled
                positions — no cached table.
              </ReportNote>
              <DailyTable rows={dailyRows} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <ReportNote>
                One row per player active in range, <b>ranked by GGR</b> (net revenue to the house).
                {' '}<b>{usersSort === 'losers' ? 'Biggest losers first' : 'Biggest winners first'}</b>:
                a <span className="text-up">positive</span> GGR means the house profited from that player
                (they net‑lost); a <span className="text-down">negative</span> GGR means the player is
                net‑winning. <b>Turnover</b> = Σ stakes. Internal marketer accounts are excluded.
              </ReportNote>
              <UsersTable rows={userRows} />
            </div>
          )}
        </Section>
      )}
    </>
  );
}

function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

/** Small inline explanation so every table's numbers are traceable in-product. */
function ReportNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-muted">
      {children}
    </p>
  );
}

/** Single-day (EAT) comprehensive stats with a calendar picker + prev/next stepper. Mobile-first. */
function DayExplorer() {
  const today = eatToday();
  const [date, setDate] = useState(today);
  const q = useReportDay(date);
  const d = q.data;
  const isFuture = date >= today;

  return (
    <div className="flex flex-col gap-4">
      {/* Date picker: prev / native calendar / next, plus quick jumps. */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3">
        <button
          onClick={() => setDate((v) => shiftDay(v, -1))}
          className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted hover:text-fg"
          aria-label="Previous day"
        >
          ‹
        </button>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value || today)}
          className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <button
          onClick={() => setDate((v) => (v < today ? shiftDay(v, 1) : v))}
          disabled={isFuture}
          className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted enabled:hover:text-fg disabled:opacity-40"
          aria-label="Next day"
        >
          ›
        </button>
        <div className="ml-auto flex gap-1">
          <QuickDay label="Today" onClick={() => setDate(today)} activeWhen={date === today} />
          <QuickDay label="Yesterday" onClick={() => setDate(shiftDay(today, -1))} activeWhen={date === shiftDay(today, -1)} />
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : q.isError || !d ? (
        <Empty title="Couldn't load this day" description="Try again shortly." />
      ) : (
        <DayBody d={d} />
      )}
    </div>
  );
}

function QuickDay({ label, onClick, activeWhen }: { label: string; onClick: () => void; activeWhen: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        activeWhen
          ? 'rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent'
          : 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg'
      }
    >
      {label}
    </button>
  );
}

function DayBody({ d }: { d: AdminDayReport }) {
  const netCashCents = d.deposits.amountCents - d.withdrawals.amountCents;
  const winRate = pct(d.winningPositions, d.settledPositions);
  return (
    <div className="flex flex-col gap-5">
      <ReportNote>
        All figures are for the selected day and <b>exclude internal marketer accounts</b>.
        <b> Net revenue (GGR)</b> = turnover − payouts (a <i>game</i> metric from settled trades) — it is
        <b> not</b> a deposit. <b>Deposits</b> below is real cash in via M‑Pesa. A day can show GGR with
        zero deposits when players trade an existing balance.
      </ReportNote>
      {/* Headline: the three numbers an operator scans first. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Net revenue (GGR)" money={d.ggrCents} tone={d.ggrCents >= 0 ? 'up' : 'down'} hint="turnover − payouts" />
        <StatCard label="Net cash flow" money={netCashCents} tone={netCashCents >= 0 ? 'up' : 'down'} hint="deposits − withdrawals" />
        <StatCard label="New registrants" value={d.newRegistrants} hint={`${d.firstTimeDepositors} first deposits`} />
      </div>

      <Section title="Players">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="New players" value={d.newRegistrants} />
          <StatCard label="New marketers" value={d.newMarketers} />
          <StatCard label="Active players" value={d.activePlayers} hint="traded this day" />
          <StatCard label="Depositors" value={d.depositors} hint={`${d.firstTimeDepositors} first-time`} />
        </div>
      </Section>

      <Section title="Cash">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Deposits" money={d.deposits.amountCents} tone="up" hint={`${d.deposits.count} txns`} />
          <StatCard label="Withdrawals" money={d.withdrawals.amountCents} tone="down" hint={`${d.withdrawals.count} paid`} />
          <StatCard
            label="Pending withdrawals"
            money={d.pendingWithdrawals.amountCents}
            tone={d.pendingWithdrawals.count > 0 ? 'warn' : 'default'}
            hint={`${d.pendingWithdrawals.count} awaiting`}
          />
          <StatCard label="Net cash flow" money={netCashCents} tone={netCashCents >= 0 ? 'up' : 'down'} />
        </div>
      </Section>

      <Section title="Game">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Turnover" money={d.turnoverCents} hint={`${d.settledPositions} trades`} />
          <StatCard label="Payouts" money={d.payoutCents} tone="down" hint="winnings credited" />
          <StatCard label="Net revenue (GGR)" money={d.ggrCents} tone={d.ggrCents >= 0 ? 'up' : 'down'} />
          <StatCard label="Player win rate" value={winRate} hint={`${d.winningPositions}/${d.settledPositions} won`} />
        </div>
      </Section>

      <Section title="Withdrawal pool & commission">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Pool budget" money={d.poolBudgetCents} hint="all brands" />
          <StatCard label="Pool paid" money={d.poolPaidCents} hint="winnings committed" />
          <StatCard
            label="Pool used"
            value={pct(d.poolPaidCents, d.poolBudgetCents)}
            tone={d.poolBudgetCents > 0 && d.poolPaidCents / d.poolBudgetCents > 0.9 ? 'warn' : 'default'}
          />
          <StatCard label="Commission accrued" money={d.commissionAccruedCents} hint="affiliate" />
        </div>
      </Section>
    </div>
  );
}

function DailyTable({ rows }: { rows: DailyReportRow[] }) {
  return (
    <TableWrap>
      <thead>
        <tr className="border-b border-border">
          <Th>Date</Th>
          <Th className="text-right">Deposits</Th>
          <Th className="text-right">Withdrawals</Th>
          <Th className="text-right">Turnover</Th>
          <Th className="text-right">GGR</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.date} className="border-b border-border last:border-0">
            <Td className="whitespace-nowrap font-medium">{r.date}</Td>
            <Td className="text-right tabular-nums"><Money cents={r.depositsCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.withdrawalsCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.turnoverCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.ggrCents} /></Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function UsersTable({ rows }: { rows: UserReportRow[] }) {
  return (
    <TableWrap>
      <thead>
        <tr className="border-b border-border">
          <Th>Player</Th>
          <Th className="text-right">Deposits</Th>
          <Th className="text-right">Withdrawals</Th>
          <Th className="text-right">Turnover</Th>
          <Th className="text-right">GGR</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId} className="border-b border-border last:border-0">
            <Td>
              <span className="font-medium">@{r.username}</span>
              <span className="ml-2 font-mono text-xs text-muted">{r.userId.slice(0, 8)}…</span>
            </Td>
            <Td className="text-right tabular-nums"><Money cents={r.depositsCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.withdrawalsCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.turnoverCents} /></Td>
            <Td className="text-right tabular-nums"><Money cents={r.ggrCents} /></Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

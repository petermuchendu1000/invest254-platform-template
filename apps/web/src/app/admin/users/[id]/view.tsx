'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { PageHeader, StatCard, Section, Empty, ConfirmButton, TableWrap, Th, Td, Toolbar, FilterSelect } from '@/components/admin/ui';
import { useUser, useUserActivity, useSetUserStatus, useAdjustBalance, useClearBalance, useResetBalance, useSetCommissionRate, useSetUserRole, useUpdateUserDetails, useUserNotifications, useSendNotification, useResolveNotification, useUserOverrides, useSetOverrides, useGameConfig, useMarketerExpenses, useAddMarketerExpense } from '@/lib/admin/hooks';
import type { AdminUserActivityRow, AdminNotificationRow, NotificationLevel, UserOverridePatch } from '@/lib/admin/types';

const ROLES = ['player', 'marketer', 'admin'] as const;

export default function UserDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const q = useUser(id);

  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <Link href="/admin/users" className="text-accent hover:underline">
          ← Users
        </Link>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !q.data ? (
        <Empty title="User not found" description="This account may have been removed." />
      ) : (
        <>
          <PageHeader
            title={`@${q.data.username}`}
            subtitle={`${q.data.role} · joined ${formatDateTime(q.data.createdAtMs)}`}
            actions={<StatusBadge status={q.data.status} />}
          />

          <Section title="Balances">
            {q.data.isMarketer && (
              <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Demo / social-proof account — plays on a non-withdrawable <strong>demo balance</strong>; its
                winnings are excluded from real cash (GGR/RTP) and can never be withdrawn to M-Pesa.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {q.data.isMarketer ? (
                <StatCard label="Demo balance (non-withdrawable)" money={q.data.demoBalanceCents} />
              ) : (
                <StatCard label="Real balance" money={q.data.realBalanceCents} />
              )}
              <StatCard label="Bonus balance" money={q.data.bonusBalanceCents} />
              <StatCard label="Turnover" money={q.data.turnoverCents} />
              <StatCard label="Net revenue (GGR)" money={q.data.ggrCents} tone={q.data.ggrCents >= 0 ? 'up' : 'down'} />
            </div>
          </Section>

          <Section title="Lifetime cash flow & activity">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Deposits" money={q.data.depositsCents} tone="up" />
              <StatCard label="Withdrawals" money={q.data.withdrawalsCents} tone="down" />
              <StatCard label="Net deposits" money={q.data.netDepositsCents} tone={q.data.netDepositsCents >= 0 ? 'up' : 'down'} />
              <StatCard label="Settled bets" value={q.data.betCount.toLocaleString()} />
            </div>
          </Section>

          <Section title="Profile">
            <Card className="flex flex-col gap-2 text-sm">
              <Row label="User ID" value={q.data.userId} mono />
              <Row label="Phone" value={q.data.phone || '—'} />
              <Row label="Referred by" value={q.data.referredBy ? `${q.data.referredBy.slice(0, 8)}…` : '—'} mono />
              <Row label="Last transaction" value={q.data.lastTxAtMs ? `${q.data.lastTxKind ?? ''} · ${formatDateTime(q.data.lastTxAtMs)}` : '—'} />
              <Row label="Last active" value={q.data.lastActiveAtMs ? formatDateTime(q.data.lastActiveAtMs) : '—'} />
            </Card>
          </Section>

          <ActivityTimeline id={id} />

          {q.data.role === 'superadmin' ? (
            <Section title="System owner">
              <Card className="flex flex-col gap-1">
                <span className="text-sm font-medium text-fg">Protected account</span>
                <span className="text-sm text-muted">
                  This is the system owner (superadmin). Their role and status are locked and their wallet can&apos;t be adjusted — no
                  account can demote, suspend, ban, or modify the owner.
                </span>
              </Card>
            </Section>
          ) : (
            <>
              <StatusActions id={id} status={q.data.status} />
              <EditDetails id={id} phone={q.data.phone} username={q.data.username} />
              <RoleManage id={id} current={q.data.role} />
              <BalanceAdjust id={id} />
              <ResetBalance id={id} />
              <OverridesPanel id={id} />
              <NotificationSend id={id} />
              {q.data.role === 'marketer' ? <CommissionRate id={id} /> : null}
              {q.data.role === 'marketer' ? <MarketerExpenses id={id} /> : null}
            </>
          )}
        </>
      )}
    </>
  );
}

const ACTIVITY_KINDS = [
  { value: '', label: 'All activity' },
  { value: 'deposit', label: 'Deposits' },
  { value: 'withdrawal', label: 'Withdrawals' },
  { value: 'bet', label: 'Bets' },
];
const KIND_LABEL: Record<string, string> = { deposit: 'Deposit', withdrawal: 'Withdrawal', bet: 'Bet', adjustment: 'Manual adjustment' };

function ActivityTimeline({ id }: { id: string }) {
  const [kind, setKind] = useState('');
  const q = useUserActivity(id, kind || undefined);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  return (
    <Section title="Activity">
      <Toolbar>
        <FilterSelect label="Show" value={kind} onChange={setKind} options={ACTIVITY_KINDS} />
      </Toolbar>
      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Empty title="Couldn't load activity" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No activity yet" description="Deposits, withdrawals and bets will appear here." />
      ) : (
        <>
          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th>Type</Th>
                <Th>Detail</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ActivityRow key={`${r.kind}:${r.id}`} r={r} />
              ))}
            </tbody>
          </TableWrap>
          {q.hasNextPage ? (
            <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      )}
    </Section>
  );
}

function ActivityRow({ r }: { r: AdminUserActivityRow }) {
  const isBet = r.kind === 'bet';
  const detail = isBet
    ? [r.direction?.toUpperCase(), r.multiplier != null ? `×${r.multiplier.toFixed(2)}` : null, r.result]
        .filter(Boolean)
        .join(' · ')
    : [r.phone, r.mpesaReceipt].filter(Boolean).join(' · ');

  return (
    <tr className="border-b border-border last:border-0">
      <Td>
        <span
          className={cn(
            'inline-flex rounded-md px-2 py-0.5 text-xs font-medium',
            r.kind === 'deposit'
              ? 'bg-up/10 text-up'
              : r.kind === 'withdrawal'
                ? 'bg-down/10 text-down'
                : r.kind === 'adjustment'
                  ? 'bg-warn/10 text-warn'
                  : 'bg-surface-2 text-fg',
          )}
        >
          {KIND_LABEL[r.kind]}
        </span>
      </Td>
      <Td className="text-xs text-muted">{detail || '—'}</Td>
      <Td className="text-right font-medium tabular-nums">
        <Money cents={r.amountCents} />
        {isBet && r.pnlCents != null ? (
          <span className={cn('ml-2 text-xs', r.pnlCents >= 0 ? 'text-up' : 'text-down')}>
            {r.pnlCents >= 0 ? '+' : ''}
            <Money cents={r.pnlCents} />
          </span>
        ) : null}
      </Td>
      <Td>
        <StatusBadge status={r.status} />
      </Td>
      <Td className="whitespace-nowrap text-right text-xs text-muted">
        <span title={formatDateTime(r.createdAtMs)}>{formatRelativeTime(r.createdAtMs)} ago</span>
      </Td>
    </tr>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={'font-medium text-fg ' + (mono ? 'font-mono text-xs' : '')}>{value}</span>
    </div>
  );
}

function StatusActions({ id, status }: { id: string; status: string }) {
  const m = useSetUserStatus();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const s = status.toLowerCase();

  function run(action: 'suspend' | 'ban' | 'reactivate') {
    m.mutate(
      { id, action, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          setReason('');
          toast.push({ tone: 'success', title: `Account ${action}d` });
        },
        onError: (e) =>
          toast.push({ tone: 'error', title: 'Action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Account status">
      <Card className="flex flex-col gap-3">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (recorded in the audit log)"
          className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <div className="flex flex-wrap gap-2">
          {s !== 'active' ? (
            <ConfirmButton label="Reactivate" variant="primary" busy={m.isPending} onConfirm={() => run('reactivate')} />
          ) : null}
          {s === 'active' ? (
            <ConfirmButton label="Suspend" variant="outline" busy={m.isPending} onConfirm={() => run('suspend')} />
          ) : null}
          {s !== 'banned' ? (
            <ConfirmButton label="Ban" variant="down" confirmLabel="Ban account" busy={m.isPending} onConfirm={() => run('ban')} />
          ) : null}
        </div>
        <p className="text-xs text-muted">Suspended or banned accounts can still sign in and deposit, but cannot open trades or withdraw. Banned is permanent. Every change is audited.</p>
      </Card>
    </Section>
  );
}

function EditDetails({ id, phone, username }: { id: string; phone: string; username: string }) {
  const m = useUpdateUserDetails();
  const toast = useToast();
  const myRole = useSession((s) => s.user?.role);
  const [ph, setPh] = useState(phone ?? '');
  const [un, setUn] = useState(username ?? '');

  // Admin+ may edit contact details (the API also confines a plain admin to non-admin targets).
  if (myRole !== 'admin' && myRole !== 'superadmin' && myRole !== 'platform_superadmin') return null;

  function run() {
    const body: { id: string; phone?: string; username?: string } = { id };
    if (ph.trim() && ph.trim() !== (phone ?? '')) body.phone = ph.trim();
    if (un.trim() && un.trim() !== (username ?? '')) body.username = un.trim();
    if (body.phone === undefined && body.username === undefined) {
      toast.push({ tone: 'info', title: 'No changes', description: 'Edit the phone or name first.' });
      return;
    }
    m.mutate(body, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Details updated', description: 'Phone/name saved.' }),
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <Section title="Edit details">
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Phone</span>
          <input value={ph} onChange={(e) => setPh(e.target.value)} inputMode="tel" placeholder="07XXXXXXXX"
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Username</span>
          <input value={un} onChange={(e) => setUn(e.target.value)}
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        </label>
        <Button onClick={run} disabled={m.isPending} className="whitespace-nowrap">
          {m.isPending ? 'Saving…' : 'Save'}
        </Button>
      </Card>
    </Section>
  );
}

function RoleManage({ id, current }: { id: string; current: string }) {
  const m = useSetUserRole();
  const toast = useToast();
  const myRole = useSession((s) => s.user?.role);
  const [role, setRole] = useState(current);

  // Owner-tier can set any role; a plain admin may promote/demote player<->marketer only (the API
  // enforces this too). platform_superadmin outranks superadmin.
  const isOwnerTier = myRole === 'superadmin' || myRole === 'platform_superadmin';
  const isAdmin = myRole === 'admin';
  if (!isOwnerTier && !isAdmin) return null;
  // An admin can only act on player/marketer accounts, and only choose player/marketer.
  if (isAdmin && current !== 'player' && current !== 'marketer') return null;
  const roleOptions = isOwnerTier ? ROLES : ['player', 'marketer'];

  function run() {
    m.mutate(
      { id, role },
      {
        onSuccess: () => toast.push({ tone: 'success', title: 'Role updated', description: 'Takes effect on the user’s next login.' }),
        onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Role">
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Account role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          >
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <ConfirmButton
          label="Change role"
          confirmLabel="Confirm role change"
          size="md"
          variant={role === 'admin' || role === 'superadmin' ? 'down' : 'primary'}
          busy={m.isPending}
          disabled={role === current}
          onConfirm={run}
        />
      </Card>
      <p className="text-xs text-muted">
        Promoting to admin or superadmin grants back-office access. Changes are audited and apply on the user’s next login.
      </p>
    </Section>
  );
}

function ResetBalance({ id }: { id: string }) {
  const q = useUser(id);
  const m = useResetBalance();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const lastFunded = q.data?.lastFundedCents ?? null;
  const current = q.data?.realBalanceCents ?? 0;
  const canReset = lastFunded != null;

  function run() {
    m.mutate(
      { id, reason: reason.trim() },
      {
        onSuccess: (r) => {
          setReason('');
          toast.push({ tone: 'success', title: 'Balance reset', description: `Real wallet set to last funded amount.` });
          void r;
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Reset failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Reset balance to last funded">
      <Card className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Current real balance" money={current} />
          <StatCard label="Last funded amount" money={lastFunded ?? 0} hint={canReset ? 'most recent successful deposit' : 'no successful deposit'} tone={canReset ? 'up' : 'default'} />
          <StatCard label="Change on reset" money={(lastFunded ?? current) - current} tone={(lastFunded ?? current) - current >= 0 ? 'up' : 'down'} />
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required, audited) — e.g. settlement bug correction"
          className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <ConfirmButton
          label="Reset to last funded"
          confirmLabel="Confirm reset"
          variant="down"
          size="md"
          busy={m.isPending}
          disabled={!canReset || reason.trim().length === 0}
          onConfirm={run}
        />
        <p className="text-xs text-muted">
          Sets the REAL wallet to the amount of the user&apos;s most recent successful deposit (their last funded amount) —
          use when a system issue corrupted the balance. Writes a reconciling ledger entry and an audit record. The bonus
          wallet is untouched. {canReset ? '' : 'This user has no successful deposit to reset to.'}
        </p>
      </Card>
    </Section>
  );
}

function BalanceAdjust({ id }: { id: string }) {
  const m = useAdjustBalance();
  const clear = useClearBalance();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [dir, setDir] = useState<'credit' | 'debit'>('credit');
  const [kind, setKind] = useState<'real' | 'bonus'>('real');
  const [reason, setReason] = useState('');

  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && reason.trim().length > 0;
  const clearValid = reason.trim().length > 0;

  function runClear(clearKind: 'real' | 'bonus' | 'both') {
    clear.mutate(
      { id, kind: clearKind, reason: reason.trim() },
      {
        onSuccess: () => { setReason(''); toast.push({ tone: 'success', title: `Cleared ${clearKind} balance`, description: 'Wallet zeroed and audited.' }); },
        onError: (e) => toast.push({ tone: 'error', title: 'Clear failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  function run() {
    const signed = dir === 'debit' ? -cents : cents;
    m.mutate(
      { id, amountCents: signed, reason: reason.trim(), kind },
      {
        onSuccess: (r) => {
          setAmount('');
          setReason('');
          toast.push({ tone: 'success', title: `Balance ${r.direction}ed`, description: 'Wallet updated and audited.' });
        },
        onError: (e) =>
          toast.push({ tone: 'error', title: 'Adjustment failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Manual balance adjustment">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'real' | 'bonus')}
            className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="real">Real</option>
            <option value="bonus">Bonus</option>
          </select>
          <select
            value={dir}
            onChange={(e) => setDir(e.target.value as 'credit' | 'debit')}
            className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="credit">Credit (+)</option>
            <option value="debit">Debit (−)</option>
          </select>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Amount (KES)"
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required, audited)"
          className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <ConfirmButton
          label={`${dir === 'credit' ? 'Credit' : 'Debit'} ${kind} wallet`}
          confirmLabel="Confirm adjustment"
          variant={dir === 'credit' ? 'primary' : 'down'}
          size="md"
          busy={m.isPending}
          disabled={!valid}
          onConfirm={run}
        />
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <span className="w-full text-xs font-semibold text-muted">Clear balance (needs a reason)</span>
          <ConfirmButton label="Clear real" confirmLabel="Confirm clear real" variant="down" size="sm" busy={clear.isPending} disabled={!clearValid} onConfirm={() => runClear('real')} />
          <ConfirmButton label="Clear bonus" confirmLabel="Confirm clear bonus" variant="down" size="sm" busy={clear.isPending} disabled={!clearValid} onConfirm={() => runClear('bonus')} />
          <ConfirmButton label="Clear both" confirmLabel="Confirm clear both" variant="down" size="sm" busy={clear.isPending} disabled={!clearValid} onConfirm={() => runClear('both')} />
        </div>
        <p className="text-xs text-muted">Adjusts/clears the chosen wallet with an immutable ledger entry. No overdraw on debit.</p>
      </Card>
    </Section>
  );
}

function CommissionRate({ id }: { id: string }) {
  const m = useSetCommissionRate();
  const toast = useToast();
  const [ratePct, setRatePct] = useState('20');
  const pct = Number(ratePct);
  const valid = Number.isFinite(pct) && pct >= 0 && pct <= 100;

  function run() {
    m.mutate(
      { id, rate: pct / 100 },
      {
        onSuccess: () => toast.push({ tone: 'success', title: 'Commission rate updated' }),
        onError: (e) =>
          toast.push({ tone: 'error', title: 'Update failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Affiliate commission rate">
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Rate (%)</span>
          <input
            value={ratePct}
            onChange={(e) => setRatePct(e.target.value)}
            inputMode="decimal"
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
        <ConfirmButton label="Update rate" size="md" busy={m.isPending} disabled={!valid} onConfirm={run} />
      </Card>
    </Section>
  );
}

const LEVELS: { value: NotificationLevel; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

// One-tap templates for the issues operators raise most (matches issue #3).
const TEMPLATES: { key: string; label: string; level: NotificationLevel; dismissible: boolean; title: string; body: string; category: string }[] = [
  { key: 'bonus', label: 'Bonus added', level: 'success', dismissible: true, title: 'Bonus added', body: 'A bonus of KES 0 has been added to your wallet.', category: 'bonus' },
  { key: 'system', label: 'System issue', level: 'warning', dismissible: true, title: 'Temporary system issue', body: 'We are resolving a temporary issue. Your balance and open trades are safe.', category: 'system' },
  { key: 'suspend', label: 'Account limited (blocking)', level: 'error', dismissible: false, title: 'Your account is limited', body: 'Some actions are unavailable. Contact support if you believe this is a mistake.', category: 'account_limited' },
];

function NotificationSend({ id }: { id: string }) {
  const listQ = useUserNotifications(id);
  const send = useSendNotification(id);
  const resolve = useResolveNotification(id);
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState<NotificationLevel>('info');
  const [dismissible, setDismissible] = useState(true);
  const [category, setCategory] = useState('');

  const valid = title.trim().length > 0 && title.trim().length <= 120;
  const active = (listQ.data?.items ?? []).filter((n) => n.dismissedAtMs === null && n.resolvedAtMs === null);

  function applyTemplate(k: string) {
    const t = TEMPLATES.find((x) => x.key === k);
    if (!t) return;
    setTitle(t.title); setBody(t.body); setLevel(t.level); setDismissible(t.dismissible); setCategory(t.category);
  }

  function run() {
    send.mutate(
      { title: title.trim(), body: body.trim(), level, dismissible, category: category.trim() || null },
      {
        onSuccess: () => {
          setTitle(''); setBody(''); setCategory(''); setLevel('info'); setDismissible(true);
          toast.push({ tone: 'success', title: 'Notification sent', description: dismissible ? 'The player can dismiss it.' : 'Blocking — stays until resolved.' });
        },
        onError: (e) => toast.push({ tone: 'error', title: 'Send failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      },
    );
  }

  function clear(nid: number) {
    resolve.mutate(nid, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Notification cleared' }),
      onError: (e) => toast.push({ tone: 'error', title: 'Clear failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <Section title="Send notification">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <Button key={t.key} variant="ghost" size="sm" onClick={() => applyTemplate(t.key)}>{t.label}</Button>
          ))}
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (required)"
          maxLength={120}
          className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message (optional)"
          rows={2}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as NotificationLevel)}
            className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          >
            {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Category (optional, e.g. bonus)"
            className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
          />
          <label className="flex items-center gap-2 whitespace-nowrap text-sm text-fg">
            <input type="checkbox" checked={dismissible} onChange={(e) => setDismissible(e.target.checked)} />
            Dismissible
          </label>
        </div>
        <ConfirmButton
          label={dismissible ? 'Send notification' : 'Send blocking notice'}
          confirmLabel="Confirm send"
          variant={dismissible ? 'primary' : 'down'}
          size="md"
          busy={send.isPending}
          disabled={!valid}
          onConfirm={run}
        />
        <p className="text-xs text-muted">
          Dismissible notices clear when the player taps X. Blocking notices (e.g. account limits) stay until an admin resolves them.
        </p>

        {active.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted">Active notifications</p>
            {active.map((n: AdminNotificationRow) => (
              <div key={n.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg">{n.title}</span>
                    <span className="rounded-md bg-surface px-1.5 py-0.5 text-[10px] uppercase text-muted">{n.level}</span>
                    {!n.dismissible ? <span className="rounded-md bg-down/15 px-1.5 py-0.5 text-[10px] uppercase text-down">blocking</span> : null}
                  </div>
                  {n.body ? <p className="truncate text-xs text-muted">{n.body}</p> : null}
                </div>
                <Button variant="ghost" size="sm" disabled={resolve.isPending} onClick={() => clear(n.id)}>Clear</Button>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </Section>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
      />
    </label>
  );
}

/** Per-user engine overrides: win rate, forced auto-sell duration, payout cap, stake bounds (J8). */
function OverridesPanel({ id }: { id: string }) {
  const q = useUserOverrides(id);
  const m = useSetOverrides(id);
  const gc = useGameConfig();
  const toast = useToast();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    const o = q.data;
    if (!o) return;
    setForm({
      winRate: o.winRate != null ? String(o.winRate) : '',
      houseEdge: o.houseEdge != null ? String(o.houseEdge) : '',
      tradeDurationS: o.tradeDurationS != null ? String(o.tradeDurationS) : '',
      maxWinMultiplier: o.maxWinMultiplier != null ? String(o.maxWinMultiplier) : '',
      minStake: o.minStakeCents != null ? String(o.minStakeCents / 100) : '',
      maxStake: o.maxStakeCents != null ? String(o.maxStakeCents / 100) : '',
      notes: o.notes ?? '',
    });
  }, [q.data]);

  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }));
  const numOrNull = (s: string): number | null => {
    const t = (s ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const centsOrNull = (s: string): number | null => {
    const n = numOrNull(s);
    return n == null ? null : Math.round(n * 100);
  };
  const intOrNull = (s: string): number | null => {
    const n = numOrNull(s);
    return n == null ? null : Math.round(n);
  };

  function save() {
    const patch: UserOverridePatch = {
      winRate: numOrNull(form.winRate ?? ''),
      houseEdge: numOrNull(form.houseEdge ?? ''),
      tradeDurationS: intOrNull(form.tradeDurationS ?? ''),
      maxWinMultiplier: numOrNull(form.maxWinMultiplier ?? ''),
      minStakeCents: centsOrNull(form.minStake ?? ''),
      maxStakeCents: centsOrNull(form.maxStake ?? ''),
      notes: (form.notes ?? '').trim() === '' ? null : (form.notes ?? '').trim(),
    };
    m.mutate(patch, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Overrides saved', description: "Applied to the user's next trades." }),
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  // Live feasibility preview: fold the form over the global config so the operator sees whether
  // the per-user pricing is feasible (and thus actually applied) BEFORE saving.
  const g = gc.data;
  const fx = (() => {
    const he = numOrNull(form.houseEdge ?? '') ?? (g ? g.houseEdge : null);
    const wr = numOrNull(form.winRate ?? '') ?? (g ? g.targetWinRate : null);
    const mm = numOrNull(form.maxWinMultiplier ?? '') ?? (g ? g.maxMultiplier : null);
    if (he == null || wr == null || mm == null) return null;
    const pricing =
      numOrNull(form.winRate ?? '') != null ||
      numOrNull(form.houseEdge ?? '') != null ||
      numOrNull(form.maxWinMultiplier ?? '') != null;
    const rtp = 1 - he;
    const required = rtp / wr;
    const bounded = he >= 0 && he < 1 && wr > 0 && wr <= 1 && mm > 1;
    const feasible = bounded && required > 1 && required <= mm;
    return { feasible, rtp, winRate: wr, maxMult: mm, required, pricing };
  })();

  return (
    <Section title="Player overrides">
      <Card className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          Per-player overrides of the global game configuration — blank = use the global value. Pricing fields
          (win rate, house edge, max win multiplier) rig this user&apos;s outcomes; duration forces their auto-sell
          timer; stake bounds gate their trades. Feasibility requires <span className="font-mono">(1 − houseEdge) / winRate</span> to
          land in <span className="font-mono">(1, maxMultiplier]</span> — if it doesn&apos;t, the pricing override is ignored, so raising
          a win rate above the global RTP also needs a lower house edge.
        </p>
        {fx ? (
          <div
            className={
              'rounded-xl border px-3 py-2 text-xs ' +
              (fx.feasible
                ? 'border-up/40 bg-up/10 text-up'
                : 'border-down/40 bg-down/10 text-down')
            }
          >
            {fx.feasible ? (
              <span>
                ✓ Effective for this player: RTP <b>{(fx.rtp * 100).toFixed(1)}%</b> · win rate{' '}
                <b>{(fx.winRate * 100).toFixed(1)}%</b> · avg winning multiplier <b>×{fx.required.toFixed(2)}</b> (cap ×
                {fx.maxMult}). {fx.pricing ? 'Pricing is overridden.' : 'Using global pricing.'}
              </span>
            ) : (
              <span>
                ⚠ Infeasible pricing — this override will be <b>ignored</b> (falls back to global). RTP{' '}
                {(fx.rtp * 100).toFixed(1)}% at win rate {(fx.winRate * 100).toFixed(1)}% needs an average winning
                multiplier of ×{fx.required.toFixed(2)}, which must be in (1, ×{fx.maxMult}]. Lower the house edge (e.g.
                ≤ {Math.max(0, 1 - fx.winRate * fx.maxMult).toFixed(2)}) or the win rate.
              </span>
            )}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <LabeledInput label="Win rate (fraction 0–1)" value={form.winRate ?? ''} onChange={(v) => set('winRate', v)} placeholder="e.g. 0.90" />
          <LabeledInput label="House edge (0–1 · RTP = 1 − this)" value={form.houseEdge ?? ''} onChange={(v) => set('houseEdge', v)} placeholder="e.g. 0.05" />
          <LabeledInput label="Max win multiplier" value={form.maxWinMultiplier ?? ''} onChange={(v) => set('maxWinMultiplier', v)} placeholder="e.g. 5" />
          <LabeledInput label="Auto-sell duration (s)" value={form.tradeDurationS ?? ''} onChange={(v) => set('tradeDurationS', v)} placeholder="e.g. 30" />
          <LabeledInput label="Min stake (KES)" value={form.minStake ?? ''} onChange={(v) => set('minStake', v)} placeholder="e.g. 250" />
          <LabeledInput label="Max stake (KES)" value={form.maxStake ?? ''} onChange={(v) => set('maxStake', v)} placeholder="e.g. 50000" />
          <LabeledInput label="Notes" value={form.notes ?? ''} onChange={(v) => set('notes', v)} placeholder="optional" />
        </div>
        <ConfirmButton label="Save overrides" confirmLabel="Confirm save" variant="primary" size="md" busy={m.isPending} disabled={q.isLoading} onConfirm={save} />
        {q.data?.updatedAtMs ? (
          <p className="text-xs text-muted">
            Last updated {formatRelativeTime(q.data.updatedAtMs)} ago{q.data.updatedBy ? ` by ${q.data.updatedBy.slice(0, 8)}…` : ''}.
          </p>
        ) : null}
      </Card>
    </Section>
  );
}

const EXPENSE_CATEGORIES = [
  { value: 'tiktok_promo', label: 'TikTok promo' },
  { value: 'data_bundles', label: 'Data bundles' },
  { value: 'advance', label: 'Advance payment' },
  { value: 'airtime', label: 'Airtime' },
  { value: 'transport', label: 'Transport' },
  { value: 'other', label: 'Other' },
];

/** Admin-logged marketer expenses (transparency, 0068). Everything logged here is visible to the
 *  marketer in their hidden dashboard, so payouts and advances are never a black box. */
function MarketerExpenses({ id }: { id: string }) {
  const q = useMarketerExpenses(id);
  const add = useAddMarketerExpense(id);
  const toast = useToast();
  const [category, setCategory] = useState('tiktok_promo');
  const [amountKes, setAmountKes] = useState('');
  const [note, setNote] = useState('');

  const rows = q.data?.items ?? [];
  const total = q.data?.totalCents ?? 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const kes = Number(amountKes);
    if (!Number.isFinite(kes) || kes <= 0) { toast.push({ tone: 'error', title: 'Enter a valid amount' }); return; }
    const body: { category: string; amountCents: number; note?: string } = { category, amountCents: Math.round(kes * 100) };
    const trimmed = note.trim();
    if (trimmed) body.note = trimmed;
    add.mutate(
      body,
      {
        onSuccess: () => { setAmountKes(''); setNote(''); toast.push({ tone: 'success', title: 'Expense logged', description: 'Visible to the marketer immediately.' }); },
        onError: (err) => toast.push({ tone: 'error', title: 'Could not log expense', description: err instanceof ApiError ? err.message : 'Try again.' }),
      },
    );
  }

  return (
    <Section title="Marketer expenses & advances">
      <form onSubmit={submit} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent">
          {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input value={amountKes} onChange={(e) => setAmountKes(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="Amount (KES)" className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add expense'}</Button>
      </form>
      {q.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : rows.length === 0 ? (
        <Empty title="No expenses logged" description="Log promo spend, data bundles or advances — the marketer sees them for full transparency." />
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <Th>Category</Th>
              <Th>Note</Th>
              <Th className="text-right">Amount</Th>
              <Th className="text-right">When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <Td className="capitalize">{e.category.replace(/_/g, ' ')}</Td>
                <Td className="text-muted">{e.note ?? '—'}</Td>
                <Td className="text-right font-medium tabular-nums text-down">−<Money cents={e.amountCents} /></Td>
                <Td className="text-right text-xs text-muted">{formatRelativeTime(e.createdAtMs)} ago</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <p className="mt-2 text-right text-sm">Total logged: <span className="font-bold tabular-nums text-down"><Money cents={total} /></span></p>
    </Section>
  );
}

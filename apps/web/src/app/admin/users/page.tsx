'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { StatusBadge } from '@/components/ui/Badge';
import { formatExact, formatAgo, formatNumber } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { PageHeader, TableWrap, Th, Td, Empty, Toolbar, FilterSelect, ConfirmButton, SearchInput } from '@/components/admin/ui';
import { useUsers, useOverview, useBulkAction, type UsersFilter } from '@/lib/admin/hooks';
import type { AdminUserRow, BulkAction, BulkActionInput, NotificationLevel } from '@/lib/admin/types';

const ROLE_OPTS = [
  { value: '', label: 'All roles' },
  { value: 'player', label: 'Players' },
  { value: 'marketer', label: 'Marketers' },
  { value: 'admin', label: 'Admins' },
];
const ROLE_LABEL: Record<string, string> = { marketer: 'Marketer', admin: 'Brand admin', platform_admin: 'Platform admin', platform_superadmin: 'System owner' };
const STATUS_OPTS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'banned', label: 'Banned' },
];

type Counts = { total?: number; active?: number; suspended?: number; banned?: number; marketers?: number } | undefined;
const QUICK: { label: string; role: string; status: string; count: (u: Counts) => number }[] = [
  { label: 'Everyone', role: '', status: '', count: (u) => u?.total ?? 0 },
  { label: 'Active', role: '', status: 'active', count: (u) => u?.active ?? 0 },
  { label: 'Suspended', role: '', status: 'suspended', count: (u) => u?.suspended ?? 0 },
  { label: 'Banned', role: '', status: 'banned', count: (u) => u?.banned ?? 0 },
  { label: 'Marketers', role: 'marketer', status: '', count: (u) => u?.marketers ?? 0 },
];

const kesToCents = (s: string): number | undefined => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
};
const intOrU = (s: string): number | undefined => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};

export default function UsersPage() {
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  // UI-F: the Overview "Needs attention" list links here with ?status=suspended.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const st = q.get('status'); if (st && STATUS_OPTS.some((o) => o.value === st)) setStatus(st);
    const rl = q.get('role'); if (rl && ROLE_OPTS.some((o) => o.value === rl)) setRole(rl);
  }, []);
  const [search, setSearch] = useState('');
  const [showAdv, setShowAdv] = useState(false);

  const [minBal, setMinBal] = useState('');
  const [maxBal, setMaxBal] = useState('');
  const [minDep, setMinDep] = useState('');
  const [minWd, setMinWd] = useState('');
  const [minTurn, setMinTurn] = useState('');
  const [minBets, setMinBets] = useState('');

  const [applied, setApplied] = useState<UsersFilter>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setTimeout(() => {
      const next: UsersFilter = {};
      if (role) next.role = role;
      if (status) next.status = status;
      const qv = search.trim();
      if (qv) next.q = qv;
      const mb = kesToCents(minBal); if (mb !== undefined) next.minBalanceCents = mb;
      const xb = kesToCents(maxBal); if (xb !== undefined) next.maxBalanceCents = xb;
      const md = kesToCents(minDep); if (md !== undefined) next.minDepositsCents = md;
      const mw = kesToCents(minWd); if (mw !== undefined) next.minWithdrawalsCents = mw;
      const mt = kesToCents(minTurn); if (mt !== undefined) next.minTurnoverCents = mt;
      const mbet = intOrU(minBets); if (mbet !== undefined) next.minBets = mbet;
      setApplied(next);
    }, 350);
    return () => clearTimeout(id);
  }, [role, status, search, minBal, maxBal, minDep, minWd, minTurn, minBets]);

  const query = useUsers(applied);
  const overview = useOverview();
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const advValues = [minBal, maxBal, minDep, minWd, minTurn, minBets];
  const advCount = advValues.filter((s) => s.trim() !== '').length;

  function clearAll() {
    setRole(''); setStatus(''); setSearch('');
    setMinBal(''); setMaxBal(''); setMinDep(''); setMinWd(''); setMinTurn(''); setMinBets('');
  }
  const anyFilter = advCount > 0 || !!role || !!status || !!search.trim();

  // ── selection ──
  const loadedIds = useMemo(() => rows.map((r) => r.userId), [rows]);
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selected.has(id));
  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => {
      if (loadedIds.every((id) => s.has(id))) { const n = new Set(s); loadedIds.forEach((id) => n.delete(id)); return n; }
      return new Set([...s, ...loadedIds]);
    });
  }
  const clearSel = () => setSelected(new Set());

  const u = overview.data?.users;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Every account on this brand. Click a name to manage one person; tick several to act on them together."
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
        {overview.isLoading ? <Skeleton className="h-8 w-80" /> : QUICK.map((qf) => {
          const on = qf.role === role && qf.status === status;
          const count = qf.count(u);
          return (
            <button key={qf.label} type="button" aria-pressed={on}
              onClick={() => { setRole(qf.role); setStatus(qf.status); }}
              className={'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ' +
                (on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-muted hover:text-fg')}>
              {qf.label}<span className={'tabular-nums ' + (on ? '' : 'text-fg')}>{formatNumber(count)}</span>
            </button>
          );
        })}
      </div>

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search username or phone…" className="sm:w-72" />
        <FilterSelect value={role} onChange={setRole} options={ROLE_OPTS} />
        <Button variant="outline" size="sm" onClick={() => setShowAdv((v) => !v)}>
          {showAdv ? 'Hide filters' : 'More filters'}
          {advCount > 0 ? (
            <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-fg">{advCount}</span>
          ) : null}
        </Button>
        {anyFilter ? <Button variant="ghost" size="sm" onClick={clearAll}>Clear</Button> : null}
      </Toolbar>

      {showAdv ? (
        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-3 lg:grid-cols-6">
          <NumberFilter label="Min balance (KES)" value={minBal} onChange={setMinBal} placeholder="e.g. 1000" />
          <NumberFilter label="Max balance (KES)" value={maxBal} onChange={setMaxBal} placeholder="e.g. 50000" />
          <NumberFilter label="Min deposits (KES)" value={minDep} onChange={setMinDep} placeholder="e.g. 5000" />
          <NumberFilter label="Min withdrawals (KES)" value={minWd} onChange={setMinWd} placeholder="e.g. 5000" />
          <NumberFilter label="Min turnover (KES)" value={minTurn} onChange={setMinTurn} placeholder="e.g. 10000" />
          <NumberFilter label="Min bets" value={minBets} onChange={setMinBets} placeholder="e.g. 10" />
        </div>
      ) : null}

      {selected.size > 0 ? <BulkBar ids={[...selected]} onDone={clearSel} /> : null}

      {query.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : query.isError ? (
        <Empty title="Couldn't load users" description="Try again shortly." />
      ) : rows.length === 0 ? (
        <Empty title="No users match" description="Adjust your search or filters." />
      ) : (
        <>
          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th>
                  <input type="checkbox" aria-label="Select all loaded" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-[var(--accent,#2563eb)]" />
                </Th>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th className="text-right">Balance</Th>
                <Th className="text-right">Deposited / withdrawn</Th>
                <Th className="text-right"><span title="What the house kept from this account's bets (stakes minus winnings), and how many bets.">House revenue</span></Th>
                <Th>Last transaction</Th>
                <Th className="text-right">Last active</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <UserRow key={r.userId} r={r} selected={selected.has(r.userId)} onToggle={() => toggle(r.userId)} />
              ))}
            </tbody>
          </TableWrap>
          {query.hasNextPage ? (
            <Button variant="outline" size="sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}

const LEVELS: { value: NotificationLevel; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

/** Sticky bulk-action bar shown when one or more users are selected. */
function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const m = useBulkAction();
  const toast = useToast();
  const [action, setAction] = useState<BulkAction | ''>('');
  const [reason, setReason] = useState('');
  const [clearKind, setClearKind] = useState<'real' | 'bonus' | 'both'>('real');
  const [amount, setAmount] = useState('');
  const [dir, setDir] = useState<'credit' | 'debit'>('credit');
  const [adjKind, setAdjKind] = useState<'real' | 'bonus'>('real');
  const [title, setTitle] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [level, setLevel] = useState<NotificationLevel>('info');
  const [dismissible, setDismissible] = useState(true);

  const needsReason: BulkAction[] = ['suspend', 'ban', 'reactivate', 'reset-balance', 'clear-balance', 'adjust-balance'];
  const amountCents = kesToCents(amount);

  function valid(): boolean {
    if (action === '') return false;
    if (action === 'notify') return title.trim().length > 0 && title.trim().length <= 120;
    if (action === 'reactivate') return true; // reason optional
    if (needsReason.includes(action) && reason.trim().length === 0) return false;
    if (action === 'adjust-balance') return amountCents !== undefined && amountCents > 0;
    return true;
  }

  function run() {
    if (action === '') return;
    const body: BulkActionInput = { action, userIds: ids };
    if (reason.trim()) body.reason = reason.trim();
    if (action === 'clear-balance') body.kind = clearKind;
    if (action === 'adjust-balance') { if (amountCents !== undefined) body.amountCents = amountCents; body.direction = dir; body.kind = adjKind; }
    if (action === 'notify') {
      body.title = title.trim();
      if (bodyText.trim()) body.body = bodyText.trim();
      body.level = level;
      body.dismissible = dismissible;
    }
    m.mutate(body, {
      onSuccess: (res) => {
        const failMsg = res.failCount > 0
          ? ` · ${res.failCount} failed${res.results.find((x) => !x.ok)?.error ? ` (${res.results.find((x) => !x.ok)!.error})` : ''}`
          : '';
        toast.push({ tone: res.failCount === 0 ? 'success' : 'error', title: `Bulk ${action}: ${res.okCount}/${res.total} ok`, description: `${res.okCount} succeeded${failMsg}.` });
        if (res.failCount === 0) { setAction(''); setReason(''); setAmount(''); setTitle(''); setBodyText(''); onDone(); }
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Bulk action failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  const destructive = action === 'ban' || action === 'suspend' || action === 'clear-balance' || action === 'reset-balance' || (action === 'adjust-balance' && dir === 'debit');
  const inputCls = 'h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent';

  return (
    <div className="sticky top-2 z-10 flex flex-col gap-3 rounded-2xl border border-accent/40 bg-surface p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg">{ids.length} selected</span>
        <div className="flex flex-wrap gap-1.5">
          {(['suspend', 'ban', 'reactivate', 'notify', 'reset-balance', 'clear-balance', 'adjust-balance'] as BulkAction[]).map((a) => (
            <button
              key={a}
              onClick={() => setAction((cur) => (cur === a ? '' : a))}
              className={
                'rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition ' +
                (action === a ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted hover:text-fg')
              }
            >
              {a.replace('-', ' ')}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={onDone} className="ml-auto">Clear selection</Button>
      </div>

      {action !== '' ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {action === 'notify' ? (
            <div className="flex flex-col gap-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (required)" maxLength={120} className={inputCls + ' w-full'} />
              <textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder="Message (optional)" rows={2} className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
              <div className="flex flex-wrap items-center gap-2">
                <select value={level} onChange={(e) => setLevel(e.target.value as NotificationLevel)} className={inputCls}>
                  {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input type="checkbox" checked={dismissible} onChange={(e) => setDismissible(e.target.checked)} /> Dismissible
                </label>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {action === 'clear-balance' ? (
                <select value={clearKind} onChange={(e) => setClearKind(e.target.value as 'real' | 'bonus' | 'both')} className={inputCls}>
                  <option value="real">Real</option>
                  <option value="bonus">Bonus</option>
                  <option value="both">Both</option>
                </select>
              ) : null}
              {action === 'adjust-balance' ? (
                <>
                  <select value={adjKind} onChange={(e) => setAdjKind(e.target.value as 'real' | 'bonus')} className={inputCls}>
                    <option value="real">Real</option>
                    <option value="bonus">Bonus</option>
                  </select>
                  <select value={dir} onChange={(e) => setDir(e.target.value as 'credit' | 'debit')} className={inputCls}>
                    <option value="credit">Credit (+)</option>
                    <option value="debit">Debit (−)</option>
                  </select>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount (KES)" className={inputCls} />
                </>
              ) : null}
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={action === 'reactivate' ? 'Reason (optional, audited)' : 'Reason (required, audited)'}
                className={inputCls + ' min-w-[16rem] flex-1'}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <ConfirmButton
              label={`Apply to ${ids.length} user${ids.length === 1 ? '' : 's'}`}
              confirmLabel={`Confirm ${action.replace('-', ' ')}`}
              variant={destructive ? 'down' : 'primary'}
              size="md"
              busy={m.isPending}
              disabled={!valid()}
              onConfirm={run}
            />
            <span className="text-xs text-muted">
              {action === 'reset-balance' ? 'Resets each user\u2019s real wallet to their last funded amount.' : ''}
              {action === 'notify' ? 'Sends a banner to every selected user.' : ''}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumberFilter({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="numeric" placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
    </label>
  );
}

function UserRow({ r, selected, onToggle }: { r: AdminUserRow; selected: boolean; onToggle: () => void }) {
  const href = `/admin/users/${r.userId}`;
  return (
    <tr className={'border-b border-border last:border-0 hover:bg-surface-2/50 ' + (selected ? 'bg-accent/5' : '')}>
      <Td>
        <input type="checkbox" aria-label={`Select ${r.username}`} checked={selected} onChange={onToggle} className="h-4 w-4" />
      </Td>
      <Td>
        <span className="inline-flex flex-col leading-tight">
          <span className="flex items-center gap-1.5">
            <Link href={href} className="font-medium text-accent hover:underline">@{r.username}</Link>
            {r.role !== 'player' ? <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{ROLE_LABEL[r.role] ?? r.role}</span> : null}
          </span>
          {r.phone ? (
            <a href={`tel:${r.phone}`} className="text-[11px] tabular-nums text-muted hover:text-accent hover:underline">{r.phone}</a>
          ) : (
            <span className="font-mono text-[10px] text-muted">{r.userId.slice(0, 8)}…</span>
          )}
        </span>
      </Td>
      <Td><StatusBadge status={r.status} /></Td>
      <Td className="text-right font-medium tabular-nums"><Money cents={r.realBalanceCents} /></Td>
      <Td className="text-right tabular-nums">
        <span className="flex flex-col leading-tight">
          <span className={r.depositsCents > 0 ? 'text-up' : 'text-muted'}><Money cents={r.depositsCents} /></span>
          {r.withdrawalsCents > 0 ? <span className="text-[11px] text-down">−<Money cents={r.withdrawalsCents} /></span> : <span className="text-[11px] text-muted">no withdrawals</span>}
        </span>
      </Td>
      <Td className="text-right tabular-nums">
        <span className="flex flex-col leading-tight">
          <span className={'font-medium ' + (r.ggrCents >= 0 ? 'text-up' : 'text-down')}><Money cents={r.ggrCents} /></span>
          <span className="text-[11px] text-muted">{formatNumber(r.betCount)} bets</span>
        </span>
      </Td>
      <Td>
        {r.lastTxAtMs && r.lastTxKind ? (
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-medium capitalize text-fg">
              {r.lastTxKind}
              {r.lastTxAmountCents != null ? <span className="ml-1 tabular-nums text-muted"><Money cents={r.lastTxAmountCents} /></span> : null}
            </span>
            <span className="text-[10px] text-muted" title={formatExact(r.lastTxAtMs)}>{r.lastTxStatus ? `${r.lastTxStatus} · ` : ''}{formatAgo(r.lastTxAtMs)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">No transactions</span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-right text-xs text-muted">
        {r.lastActiveAtMs ? <span title={formatExact(r.lastActiveAtMs)}>{formatAgo(r.lastActiveAtMs)}</span> : '—'}
      </Td>
    </tr>
  );
}

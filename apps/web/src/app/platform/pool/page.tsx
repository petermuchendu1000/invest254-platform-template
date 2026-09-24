'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { PageHeader, Section, TableWrap, Th, Td, StatCard, Empty, ConfirmButton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import {
  usePlatformSites, useDistributePool, usePoolDistributions, usePoolDemand,
  usePoolOverview, usePoolAutoSettings, useSavePoolAutoSettings, useRunPoolAuto, usePlatforms,
} from '@/lib/platform/hooks';
import type { PoolAutoMode, PoolOverviewRowDto } from '@/lib/platform/endpoints';
import { useCan } from '@/lib/auth/can';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Switch } from '@/components/platform/PaymentsIndex';
import { useUpdateGameConfig, useSetWithdrawalPool } from '@/lib/admin/hooks';
import { DEFAULT_PLATFORM_ID } from '@/components/platform/OwnerPlatformPicker';
import { formatAgo, formatDateTime } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';
import { cn } from '@/lib/cn';

/**
 * POOL-1 (docs/46) — the withdrawal pool, answering in order: how is each brand's money doing TODAY
 * (budget / paid / reserved / available, per brand, with totals), how is tomorrow's budget decided
 * (automatic distribution — dynamic by default), and what happened before (history with each brand's share).
 * Manual budgets stay available below. A platform admin is pinned to its own platform (API + RPC); the System
 * owner picks the platform.
 */
const toCents = (kes: string): number => Math.round(Number(kes) * 100);
const ALL = 'all';

function PlatformSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = usePlatforms(true);
  return (
    <label className="flex max-w-md flex-col gap-1.5 text-sm">
      <span className="font-medium">Platform</span>
      <select aria-label="Pool for platform" value={value} onChange={(e) => onChange(e.target.value)} className="h-11 rounded-brand border border-border bg-surface-2 px-3">
        <option value={ALL}>All platforms</option>
        {(q.data?.platforms ?? [{ platformId: DEFAULT_PLATFORM_ID, name: 'Default platform', slug: 'default' }]).map((p) => (
          <option key={p.platformId} value={p.platformId}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}
const kes = (c: number) => formatKes(c);

const MODES: Array<{ id: PoolAutoMode; title: string; body: string }> = [
  { id: 'dynamic', title: 'By demand (recommended)', body: 'Each night the total is split by each brand’s recent player activity, with a floor so no brand runs dry.' },
  { id: 'equal', title: 'Even split', body: 'Each night the daily total is split evenly across active brands.' },
  { id: 'off', title: 'Off', body: 'Budgets stay exactly as you set them by hand.' },
];
const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  auto: { label: 'Automatic', cls: 'bg-accent/15 text-accent' },
  dynamic: { label: 'By demand', cls: 'bg-info/15 text-info' },
  manual: { label: 'By hand', cls: 'bg-surface-2 text-muted' },
};

export default function PlatformPoolPage() {
  const isSystem = useCan('console.system');
  const [platformId, setPlatformId] = useState(DEFAULT_PLATFORM_ID);
  // The owner can also look across EVERY platform ('all' = no platform on the request = the global view).
  const target = isSystem && platformId !== ALL ? platformId : undefined;
  const all = isSystem && platformId === ALL;
  const overviewQ = usePoolOverview(target);
  const rows = overviewQ.data?.brands ?? [];
  const nameById = useMemo(() => new Map(rows.map((r) => [r.siteId, r.name])), [rows]);

  return (
    <>
      <PageHeader
        title="Withdrawal pool"
        subtitle="Each brand’s daily payout budget. Winnings are paid from the brand’s remaining budget for the day."
      />
      {isSystem ? <PlatformSelect value={platformId} onChange={setPlatformId} /> : null}

      <TodaySection loading={overviewQ.isLoading} error={overviewQ.isError} rows={rows} showPlatform={all} />
      {all ? (
        <Section title="Automatic distribution">
          <p className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">Each platform has its own automatic distribution. Choose a platform above to see or change it.</p>
        </Section>
      ) : <AutoSection target={target} />}
      <ManualSection target={target} rows={rows} />
      <HistorySection target={target} nameById={nameById} />
    </>
  );
}

/* ── 1. Today, per brand ─────────────────────────────────────────────────────────────────────── */
function TodaySection({ loading, error, rows, showPlatform }: { loading: boolean; error: boolean; rows: PoolOverviewRowDto[]; showPlatform: boolean }) {
  const isOwner = useCan('console.system');
  const [edit, setEdit] = useState<PoolOverviewRowDto | null>(null);
  const on = rows.filter((r) => r.poolMode);
  const t = on.reduce((a, r) => ({ budget: a.budget + r.todayCents, paid: a.paid + r.paidCents, reserved: a.reserved + r.reservedCents,
    avail: a.avail + r.availableCents, pend: a.pend + r.pendingCount, pendC: a.pendC + r.pendingCents, def: a.def + r.defaultCents, p7: a.p7 + r.paid7dCents }),
  { budget: 0, paid: 0, reserved: 0, avail: 0, pend: 0, pendC: 0, def: 0, p7: 0 });
  const usedPct = t.budget > 0 ? Math.round(((t.paid + t.reserved) / t.budget) * 100) : 0;
  return (
    <Section title="Today">
      {loading ? <Skeleton className="h-48 w-full" /> : error ? (
        <Empty title="Couldn’t load today’s pool" description="Reload the page to try again." />
      ) : rows.length === 0 ? (
        <Empty title="No active brands on this platform" description="Budgets appear here once a brand is live." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Budget today" money={t.budget} hint={`${on.length} brand${on.length === 1 ? '' : 's'} with the pool on`} />
            <StatCard label="Paid today" money={t.paid} hint={`${usedPct}% of the budget used or reserved`} />
            <StatCard label="Still available" money={t.avail} tone={t.budget > 0 && t.avail === 0 ? 'down' : 'default'} />
            <StatCard label="Pending withdrawals" value={t.pend} hint={t.pend ? `${kes(t.pendC)} waiting for review` : 'none waiting'} tone={t.pend ? 'warn' : 'default'} />
          </div>
          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th>Brand</Th><Th numeric>Daily default</Th><Th numeric>Budget today</Th><Th numeric>Paid</Th><Th numeric>Reserved</Th>
                <Th numeric>Available</Th><Th className="w-40">Used</Th><Th numeric>Pending</Th><Th numeric>Paid (7 days)</Th>{isOwner ? <Th className="w-px" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const used = r.todayCents > 0 ? Math.min(100, Math.round(((r.paidCents + r.reservedCents) / r.todayCents) * 100)) : 0;
                return (
                  <tr key={r.siteId} className={cn('border-b border-border last:border-0', !r.poolMode && 'text-muted')}>
                    <Td>
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium text-fg">{r.name}</span>
                        <span className="flex flex-wrap gap-1 pt-0.5 text-[11px] text-muted">
                          {showPlatform && r.platformName ? `${r.platformName} · ` : ''}{r.slug}
                          {!r.poolMode ? <span className="rounded bg-surface-2 px-1.5">pool off</span> : null}
                          {!r.withdrawalsEnabled ? <span className="rounded bg-down/15 px-1.5 text-down" title="Switched off on the brand's Withdrawals page (back office)">withdrawals off</span> : null}
                        </span>
                      </div>
                    </Td>
                    <Td numeric>{kes(r.defaultCents)}</Td>
                    <Td numeric className="font-medium text-fg" >{kes(r.todayCents)}</Td>
                    <Td numeric>{kes(r.paidCents)}</Td>
                    <Td numeric>{r.reservedCents ? kes(r.reservedCents) : '—'}</Td>
                    <Td numeric className={r.poolMode && r.todayCents > 0 && r.availableCents === 0 ? 'text-down' : ''}>{kes(r.availableCents)}</Td>
                    <Td>
                      <div className="flex items-center gap-2" title={`${used}% used or reserved`}>
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                          <div className={cn('h-full rounded-full', used >= 90 ? 'bg-down' : used >= 70 ? 'bg-warn' : 'bg-up')} style={{ width: `${used}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted">{used}%</span>
                      </div>
                    </Td>
                    <Td numeric>{r.pendingCount ? <span className="text-warn">{r.pendingCount} · {kes(r.pendingCents)}</span> : '—'}</Td>
                    <Td numeric>{kes(r.paid7dCents)}</Td>
                    {isOwner ? <Td><Button size="sm" variant="outline" onClick={() => setEdit(r)} aria-label={`Adjust ${r.name}`}>Adjust…</Button></Td> : null}
                  </tr>
                );
              })}
              <tr className="border-t border-border bg-surface-2/40 font-medium">
                <Td>Total (pool on)</Td><Td numeric>{kes(t.def)}</Td><Td numeric>{kes(t.budget)}</Td><Td numeric>{kes(t.paid)}</Td>
                <Td numeric>{t.reserved ? kes(t.reserved) : '—'}</Td><Td numeric>{kes(t.avail)}</Td><Td><span className="text-xs text-muted">{usedPct}%</span></Td>
                <Td numeric>{t.pend || '—'}</Td><Td numeric>{kes(t.p7)}</Td>{isOwner ? <Td /> : null}
              </tr>
            </tbody>
          </TableWrap>
          <p className="text-xs text-muted">“Daily default” is what each new day starts with. “Reserved” is held for payouts being processed. Figures refresh every minute.
            {isOwner ? ' “Adjust…” switches a brand between pool payouts and the fixed win rate, or sets today’s budget.' : ''}</p>
        </div>
      )}
      <BrandPoolDialog row={edit} onClose={() => setEdit(null)} />
    </Section>
  );
}

/** UI-F: the ONE place for a brand's pool mode and today's budget (they used to live on the brand page). Owner only. */
function BrandPoolDialog({ row, onClose }: { row: PoolOverviewRowDto | null; onClose: () => void }) {
  const updateCfg = useUpdateGameConfig(row?.siteId);
  const setPool = useSetWithdrawalPool(row?.siteId);
  const qc = useQueryClient();
  const toast = useToast();
  const [today, setToday] = useState('');
  React.useEffect(() => { setToday(row ? String(row.todayCents / 100) : ''); }, [row]);
  if (!row) return null;
  const done = (title: string) => { void qc.invalidateQueries({ queryKey: ['platform', 'pool-overview'] }); toast.push({ tone: 'success', title }); };
  const fail = (title: string) => (e: unknown) => toast.push({ tone: 'error', title, description: e instanceof ApiError ? e.message : 'Try again.' });
  const cents = Math.round(Number(today) * 100);
  return (
    <Modal open onClose={onClose} size="sm" title={`Adjust ${row.name}`}>
      <div className="flex flex-col gap-5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span><span className="font-medium">Pay winnings from the pool</span>
            <span className="block text-xs text-muted">{row.poolMode ? 'On: wins are paid within today’s budget.' : 'Off: this brand uses its fixed win rate.'}</span></span>
          <Switch checked={row.poolMode} label="Pay winnings from the pool" disabled={updateCfg.isPending}
            onChange={(on) => updateCfg.mutate({ poolMode: on }, { onSuccess: () => { done(`Pool ${on ? 'on' : 'off'} for ${row.name}`); onClose(); }, onError: fail('Not changed') })} />
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <Input label="Budget for today only (KES)" inputMode="decimal" value={today} onChange={(e) => setToday(e.target.value)}
            hint={`Paid so far ${kes(row.paidCents)}. The daily default (${kes(row.defaultCents)}) is set in the sections below.`} />
          <Button size="sm" className="w-fit" disabled={!today || !Number.isFinite(cents) || cents < 0 || cents === row.todayCents || setPool.isPending}
            onClick={() => setPool.mutate({ amountCents: cents }, { onSuccess: () => { done(`Today’s budget set for ${row.name}`); onClose(); }, onError: fail('Budget not set') })}>Set today’s budget</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── 2. Automatic distribution (dynamic by default) ─────────────────────────────────────────────── */
function AutoSection({ target }: { target: string | undefined }) {
  const q = usePoolAutoSettings(target);
  const save = useSavePoolAutoSettings(target);
  const run = useRunPoolAuto(target);
  const toast = useToast();
  const s = q.data?.settings;
  const [mode, setMode] = useState<PoolAutoMode>('dynamic');
  const [totalKes, setTotalKes] = useState('');
  const [lookback, setLookback] = useState(14);
  const [preview, setPreview] = useState(false);
  React.useEffect(() => {
    if (!s) return;
    setMode(s.mode); setTotalKes(s.dailyTotalCents == null ? '' : String(s.dailyTotalCents / 100)); setLookback(s.lookbackDays);
  }, [s]);
  const demandQ = usePoolDemand({ lookbackDays: lookback, ...(totalKes ? { totalCents: toCents(totalKes) } : {}) }, preview && mode === 'dynamic', target);

  if (q.isLoading || !s) return <Section title="Automatic distribution"><Skeleton className="h-40 w-full" /></Section>;
  const total = totalKes.trim() === '' ? null : toCents(totalKes);
  const totalBad = total !== null && (!Number.isInteger(total) || total < 0);
  const dirty = mode !== s.mode || total !== s.dailyTotalCents || lookback !== s.lookbackDays;
  const needsTotal = mode === 'equal' && total === null;
  const err = (e: unknown) => toast.push({ tone: 'error', title: 'Not saved', description: e instanceof ApiError ? e.message : 'Try again.' });

  return (
    <Section title="Automatic distribution">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className={cn('h-2 w-2 rounded-full', s.mode === 'off' ? 'bg-muted' : 'bg-up')} />
              {s.mode === 'off' ? 'Off' : s.mode === 'dynamic' ? 'On — by demand' : 'On — even split'}
              {s.isDefault ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">default</span> : null}
            </span>
            <span className="text-xs text-muted">Runs every day at 00:15 (Nairobi time) and sets each brand’s daily default for the new day.</span>
          </div>
          {s.lastRunAtMs ? (
            <div className={cn('max-w-md rounded-xl px-3 py-2 text-xs', s.lastRunOk === false ? 'bg-down/10 text-down' : 'bg-surface-2 text-muted')}>
              Last run {formatAgo(s.lastRunAtMs)}: {s.lastRunMessage}
            </div>
          ) : <span className="text-xs text-muted">Not run yet.</span>}
        </div>

        <div role="radiogroup" aria-label="How to split the pool" className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
              className={cn('flex flex-col gap-1 rounded-xl border p-3 text-left transition',
                mode === m.id ? 'border-accent bg-accent/5 ring-1 ring-accent/40' : 'border-border hover:bg-surface-2')}>
              <span className="text-sm font-medium">{m.title}</span>
              <span className="text-xs text-muted">{m.body}</span>
            </button>
          ))}
        </div>

        {mode !== 'off' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Daily total (KES)" inputMode="decimal" value={totalKes} onChange={(e) => setTotalKes(e.target.value)}
              placeholder={mode === 'dynamic' ? 'Keep the current total' : 'Required for an even split'}
              hint={mode === 'dynamic' ? 'Leave empty to keep the platform’s current total and only move it to where demand is.' : undefined}
              error={totalBad ? 'Enter an amount in KES.' : needsTotal ? 'An even split needs a daily total.' : undefined} />
            {mode === 'dynamic' ? (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Activity looked at</span>
                <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))} className="h-12 rounded-brand border border-border bg-surface-2 px-3 text-sm">
                  {[7, 14, 21, 30].map((d) => <option key={d} value={d}>Last {d} days</option>)}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || totalBad || needsTotal || save.isPending}
            onClick={() => save.mutate({ mode, dailyTotalCents: total, lookbackDays: lookback }, { onSuccess: () => toast.push({ tone: 'success', title: 'Automatic distribution saved' }), onError: err })}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          {mode === 'dynamic' ? (
            <Button size="sm" variant="outline" onClick={() => setPreview((v) => !v)}>{preview ? 'Hide preview' : 'Preview the split'}</Button>
          ) : null}
          <ConfirmButton label="Run now" confirmLabel="Yes, run it now" variant="outline" busy={run.isPending} disabled={dirty || s.mode === 'off'}
            onConfirm={() => run.mutate(undefined, {
              onSuccess: (r) => toast.push({ tone: r.run.ok ? 'success' : 'error', title: r.run.ok ? 'Distribution applied' : 'Distribution failed', description: r.run.message }),
              onError: err,
            })} />
          {dirty ? <span className="text-xs text-muted">Save first to run with these settings.</span> : null}
        </div>

        {preview && mode === 'dynamic' ? (
          demandQ.isLoading ? <Skeleton className="h-32 w-full" /> : demandQ.data ? (
            <div className="flex flex-col gap-2">
              <TableWrap>
                <thead><tr className="border-b border-border">
                  <Th>Brand</Th><Th numeric>Activity / day</Th><Th numeric>Needed</Th><Th numeric>Now</Th><Th numeric>Would get</Th><Th numeric>Covers</Th>
                </tr></thead>
                <tbody>
                  {demandQ.data.preview.rows.map((r) => (
                    <tr key={r.siteId} className="border-b border-border last:border-0">
                      <Td>{r.slug}</Td><Td numeric>{kes(r.forecastTurnoverCents)}</Td><Td numeric>{kes(r.requiredCents)}</Td>
                      <Td numeric>{kes(r.currentPoolCents)}</Td><Td numeric className="font-medium">{kes(r.suggestedCents)}</Td>
                      <Td numeric className={r.coverage < 1 ? 'text-warn' : 'text-up'}>{Math.round(r.coverage * 100)}%</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              <p className="text-xs text-muted">
                Splits {kes(demandQ.data.preview.totalCents)}: {kes(demandQ.data.preview.suggestedTotalCents)} to brands
                {demandQ.data.preview.reserveCents > 0 ? `, ${kes(demandQ.data.preview.reserveCents)} kept in reserve` : ''}.
                “Needed” is what the brand’s recent activity is expected to pay out.
              </p>
            </div>
          ) : null
        ) : null}
      </div>
    </Section>
  );
}

/* ── 3. Set budgets by hand ──────────────────────────────────────────────────────────────────── */
function ManualSection({ target, rows }: { target: string | undefined; rows: PoolOverviewRowDto[] }) {
  const sitesQ = usePlatformSites(target);
  const sites = useMemo(() => (sitesQ.data?.sites ?? []).filter((s) => s.status === 'active'), [sitesQ.data]);
  const distMut = useDistributePool(target);
  const toast = useToast();
  const [mode, setMode] = useState<'equal' | 'per_site'>('per_site');
  const [totalKes, setTotalKes] = useState('');
  const [perBrand, setPerBrand] = useState<Record<string, string>>({});
  const current = new Map(rows.map((r) => [r.siteId, r.defaultCents]));
  const submit = () => {
    if (mode === 'equal') {
      const c = toCents(totalKes);
      if (!Number.isInteger(c) || c < 0) return toast.push({ tone: 'error', title: 'Enter a valid total' });
      distMut.mutate({ totalCents: c, mode: 'equal' }, { onSuccess: () => toast.push({ tone: 'success', title: 'Daily budgets set' }) });
    } else {
      const overrides: Record<string, number> = {};
      for (const s of sites) { const v = perBrand[s.siteId]; if (v != null && v !== '') overrides[s.siteId] = toCents(v); }
      if (Object.keys(overrides).length === 0) return toast.push({ tone: 'error', title: 'Enter at least one brand’s budget' });
      distMut.mutate({ mode: 'per_site', overrides }, { onSuccess: () => { setPerBrand({}); toast.push({ tone: 'success', title: 'Daily budgets saved' }); } });
    }
  };
  return (
    <Section title="Set budgets by hand">
      <details className="group rounded-2xl border border-border bg-surface p-4">
        <summary className="cursor-pointer list-none text-sm font-medium marker:hidden">
          <span className="inline-flex items-center gap-2">Change daily defaults yourself <span className="text-muted transition group-open:rotate-90">›</span></span>
          <span className="mt-1 block text-xs font-normal text-muted">Takes effect from the next day. Unless automatic distribution is off, tonight’s run will re-split the total.</span>
        </summary>
        <div className="mt-4 flex flex-col gap-3">
          <div role="radiogroup" className="inline-flex w-fit rounded-lg border border-border p-0.5 text-sm">
            {(['per_site', 'equal'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                className={cn('rounded-md px-3 py-1.5', mode === m ? 'bg-surface-2 font-medium text-fg' : 'text-muted')}>
                {m === 'per_site' ? 'Per brand' : 'Even split'}
              </button>
            ))}
          </div>
          {mode === 'equal' ? (
            <div className="max-w-xs"><Input label="Total per day (KES)" inputMode="decimal" value={totalKes} onChange={(e) => setTotalKes(e.target.value)} /></div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sites.map((s) => (
                <Input key={s.siteId} label={s.name} inputMode="decimal" placeholder={`Now ${kes(current.get(s.siteId) ?? 0)}`}
                  value={perBrand[s.siteId] ?? ''} onChange={(e) => setPerBrand((p) => ({ ...p, [s.siteId]: e.target.value }))} />
              ))}
            </div>
          )}
          <div><Button size="sm" onClick={submit} disabled={distMut.isPending}>{distMut.isPending ? 'Saving…' : 'Save budgets'}</Button></div>
        </div>
      </details>
    </Section>
  );
}

/* ── 4. History with each brand's share ──────────────────────────────────────────────────────── */
function HistorySection({ target, nameById }: { target: string | undefined; nameById: Map<string, string> }) {
  const q = usePoolDistributions(target);
  const items = q.data?.distributions ?? [];
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Section title="History">
      {q.isLoading ? <Skeleton className="h-32 w-full" /> : items.length === 0 ? (
        <Empty title="No distributions yet" description="Every change to the daily budgets, automatic or by hand, is listed here with each brand’s share." />
      ) : (
        <TableWrap>
          <thead><tr className="border-b border-border"><Th>When</Th><Th>How</Th><Th numeric>Brands</Th><Th numeric>Total</Th><Th className="w-10" /></tr></thead>
          <tbody>
            {items.map((d) => {
              const src = SOURCE_LABEL[d.source ?? 'manual'] ?? SOURCE_LABEL.manual!;
              const isOpen = open === d.id;
              return (
                <React.Fragment key={d.id}>
                  <tr className="cursor-pointer border-b border-border hover:bg-surface-2/50" onClick={() => setOpen(isOpen ? null : d.id)} aria-expanded={isOpen}>
                    <Td className="whitespace-nowrap">{formatDateTime(d.createdAt)}</Td>
                    <Td><span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', src.cls)}>{d.mode === 'equal' ? 'Even split' : src.label}</span></Td>
                    <Td numeric>{d.siteCount}</Td>
                    <Td numeric className="font-medium">{kes(d.totalCents)}</Td>
                    <Td className="text-right text-muted">{isOpen ? '▾' : '▸'}</Td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-border bg-surface-2/30">
                      <Td className="py-3" ><span className="text-xs text-muted">Each brand’s daily default</span></Td>
                      <td colSpan={4} className="px-3 py-3">
                        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                          {Object.entries(d.perSite).sort((a, b) => b[1] - a[1]).map(([sid, c]) => (
                            <li key={sid} className="flex justify-between gap-3"><span className="truncate">{nameById.get(sid) ?? `${sid.slice(0, 8)}…`}</span><span className="tabular-nums">{kes(c)}</span></li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Section>
  );
}

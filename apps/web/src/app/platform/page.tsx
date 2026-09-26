'use client';

import { FitText } from '@/components/ui/FitText';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader, StatCard, Section, TableWrap, Th, Td, Toolbar, FilterSelect, SearchInput } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { usePlatformOverview, usePlatformSites, usePlatformPerformance, useDomainHealth } from '@/lib/platform/hooks';
import { usePlatformLive } from '@/lib/platform/live';
import type { SiteWithConfig, SiteKpis, SitePerformance } from '@/lib/platform/endpoints';
import { downloadCsv } from '@/components/admin/BulkSelect';
import { formatNumber } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';

const money = (cents: number, _cur = 'KES') => formatKes(cents);

/** Preset windows for the performance filters. `all` ⇒ use the all-time overview snapshot. */
type RangePreset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';

/** Resolve a preset (+ optional custom yyyy-mm-dd inputs) to an epoch-ms window, or null for all-time. */
function resolveRange(preset: RangePreset, from: string, to: string): { fromMs: number | null; toMs: number | null } {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // Days are EAT (UTC+3, no DST) — the business day of every brand, whatever the viewer's device says
  // (BUGLOG #114: "today" used the browser's midnight).
  const EAT = 3 * 60 * 60 * 1000;
  const midnight = Math.floor((now + EAT) / DAY) * DAY - EAT;
  if (preset === 'all') return { fromMs: null, toMs: null };
  if (preset === 'today') return { fromMs: midnight, toMs: now };
  if (preset === 'yesterday') return { fromMs: midnight - DAY, toMs: midnight };
  if (preset === '7d') return { fromMs: now - 7 * DAY, toMs: now };
  if (preset === '30d') return { fromMs: now - 30 * DAY, toMs: now };
  // custom: local midnight of `from` .. end-of-day of `to` (inclusive). Fall back to all-time if unset.
  const f = from ? new Date(`${from}T00:00:00+03:00`).getTime() : NaN;
  const t = to ? new Date(`${to}T00:00:00+03:00`).getTime() + DAY : NaN;
  return { fromMs: Number.isFinite(f) ? f : null, toMs: Number.isFinite(t) ? t : null };
}

export default function PlatformOverviewPage() {
  const router = useRouter();
  const overview = usePlatformOverview();
  const sites = usePlatformSites();
  const live = usePlatformLive();
  const domainHealthQ = useDomainHealth();
  const hmap = domainHealthQ.data?.statuses ?? {};
  const kpis: SiteKpis[] = overview.data?.sites ?? [];
  const siteList: SiteWithConfig[] = sites.data?.sites ?? [];
  const kpiById = useMemo(() => new Map(kpis.map((k) => [k.siteId, k])), [kpis]);
  const nameById = useMemo(() => new Map(siteList.map((s) => [s.siteId, s.name])), [siteList]);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [currency, setCurrency] = useState('all');
  const [preset, setPreset] = useState<RangePreset>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'ggr', dir: 'desc' });

  // Stabilise the window: resolveRange reads Date.now() for the relative presets (today/7d/30d),
  // so calling it inline recomputes fromMs/toMs on EVERY render. That changed the react-query key
  // ['platform','performance', fromMs, toMs] each render, so selecting a time preset kicked off an
  // endless refetch loop (each fetch → re-render → new key → new fetch) and the columns never left
  // their loading/zero state — i.e. the time filters "did nothing". Memoising on the actual inputs
  // (preset + custom dates) snaps `now` to selection time, so the key is stable and the window
  // holds until the operator changes it. (This is why only 'All-time' and fixed custom dates worked.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { fromMs, toMs } = useMemo(() => resolveRange(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const rangeActive = fromMs != null && toMs != null;
  // A half-picked or reversed custom range shows "—", never all-time totals under a custom label.
  const customPending = preset === 'custom' && !(fromMs != null && toMs != null && fromMs < toMs);
  const perf = usePlatformPerformance(fromMs, toMs);
  const perfById = useMemo(
    () => new Map((perf.data?.sites ?? []).map((p: SitePerformance) => [p.siteId, p])),
    [perf.data],
  );

  const currencies = useMemo(
    () => Array.from(new Set(siteList.map((s) => s.currency).filter(Boolean))).sort(),
    [siteList],
  );

  /** Money/activity metrics for a brand from the active source: the range performance or all-time. */
  const metric = (siteId: string) => {
    if (rangeActive) {
      const p = perfById.get(siteId);
      return { deposits: p?.depositsCents ?? 0, ggr: p?.ggrCents ?? 0, bets: p?.bets ?? 0, newPlayers: p?.newPlayers ?? 0 as number | null, staked: p?.stakedCents ?? 0 };
    }
    const k = kpiById.get(siteId);
    return { deposits: k?.depositsCents ?? 0, ggr: k?.ggrCents ?? 0, bets: k?.bets ?? 0, newPlayers: null as number | null, staked: 0 };
  };

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return siteList.filter((x) =>
      (status === 'all' || x.status === status) &&
      (currency === 'all' || x.currency === currency) &&
      (!s || x.name.toLowerCase().includes(s) || x.slug.includes(s) || (x.primaryDomain ?? '').includes(s)));
  }, [siteList, q, status, currency]);

  // Per-brand launch readiness ("Needs setup" KPI + CSV export): live once its domain is live. UI-F:
  // payments no longer count — since PAY-1 every brand is paid through its own, its platform's or the
  // System accounts, so the old per-brand M-Pesa fields flagged brands that were in fact taking money.
  const readiness = (s: SiteWithConfig) => {
    // TRUTHFUL domain state from Cloudflare Pages (not merely "a domain string is set").
    const d = (s.primaryDomain ?? '').trim().toLowerCase();
    const st = d ? (hmap[d] ?? hmap[`www.${d}`]) : undefined;
    const domainState: 'live' | 'pending' | 'unprovisioned' | 'none' =
      !d ? 'none' : st === 'active' ? 'live' : st ? 'pending' : 'unprovisioned';
    const domainOk = domainState === 'live';
    return { domainState, domainOk, score: domainOk ? 1 : 0 };
  };
  const enriched = useMemo(
    () => rows.map((s) => ({ s, k: kpiById.get(s.siteId), r: readiness(s), m: metric(s.siteId), online: live.onlineBySite[s.siteId] ?? 0 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, kpiById, perfById, rangeActive, live.onlineBySite, hmap],
  );
  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (e: (typeof enriched)[number]): string | number => {
      switch (sort.key) {
        case 'name': return e.s.name.toLowerCase();
        case 'status': return e.s.status;
        case 'live': return e.online;
        case 'players': return e.k?.users ?? 0;
        case 'newplayers': return e.m.newPlayers ?? -1;
        case 'deposits': return e.m.deposits;
        case 'ggr': return e.m.ggr;
        case 'bets': return e.m.bets;
        case 'ready': return e.r.score;
        default: return 0;
      }
    };
    return [...enriched].sort((a, b) => { const av = val(a), bv = val(b); return av < bv ? -dir : av > bv ? dir : 0; });
  }, [enriched, sort]);

  const totals = useMemo(() => kpis.reduce((a, k) => ({
    users: a.users + k.users, open: a.open + k.openPositions,
  }), { users: 0, open: 0 }), [kpis]);
  // Deposits/GGR headline totals reflect the active window (all-time snapshot, or the range).
  const windowTotals = useMemo(() => {
    const src = rangeActive
      ? (perf.data?.sites ?? []).map((p) => ({ deposits: p.depositsCents, ggr: p.ggrCents }))
      : kpis.map((k) => ({ deposits: k.depositsCents, ggr: k.ggrCents }));
    return src.reduce((a, x) => ({ deposits: a.deposits + x.deposits, ggr: a.ggr + x.ggr }), { deposits: 0, ggr: 0 });
  }, [rangeActive, perf.data, kpis]);
  const needsSetup = enriched.filter((e) => e.r.score < 1).length;

  const rangeLabel = preset === 'all' ? 'All-time'
    : preset === 'today' ? 'Today'
    : preset === 'yesterday' ? 'Yesterday'
    : preset === '7d' ? 'Last 7 days'
    : preset === '30d' ? 'Last 30 days'
    : (customFrom && customTo ? `${customFrom} → ${customTo}` : 'Custom (pick dates)');

  const exportClients = () =>
    downloadCsv(`clients-${new Date().toISOString().slice(0, 10)}.csv`, enriched.map(({ s, k, r, m, online }) => ({
      brand: s.name, slug: s.slug, status: s.status, domain: s.primaryDomain ?? '', currency: s.currency,
      liveOnline: online, players: k?.users ?? 0, newPlayers: m.newPlayers ?? '',
      window: rangeLabel,
      depositsKES: (m.deposits / 100).toFixed(2), ggrKES: (m.ggr / 100).toFixed(2), bets: m.bets,
      domainSet: r.domainOk,
    })));

  return (
    <>
      <PageHeader
        title="Overview"
        actions={<Button size="sm" onClick={() => router.push('/platform/onboard')}>Onboard brand</Button>}
      />

      {/* Platform-wide KPIs */}
      {/* One row on wide screens: 9 tracks, the two money tiles take two each so a long KES figure fits
          at full size; phones/tablets wrap to 2-4 columns and the money tiles span the row on phones. */}
      <div className="grid grid-flow-row-dense grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-9">
        <StatCard label="Brands" value={siteList.length} hint={`${kpis.filter((k) => k.status === 'active').length} active`} />
        {!live.denied ? <LiveOnlineCard total={live.totalOnline} connected={live.connected} /> : null}
        <StatCard label="Players" value={formatNumber(totals.users)} hint="registered" />
        {customPending ? (<>
          <StatCard label={`Deposits · ${rangeLabel}`} value="—" className="col-span-2 sm:col-span-1 2xl:col-span-2" />
          <StatCard label={`House revenue · ${rangeLabel}`} value="—" className="col-span-2 sm:col-span-1 2xl:col-span-2" />
        </>) : (<>
          <StatCard label={`Deposits · ${rangeLabel}`} money={windowTotals.deposits} tone="up" className="col-span-2 sm:col-span-1 2xl:col-span-2" />
          <StatCard label={`House revenue · ${rangeLabel}`} money={windowTotals.ggr} tone={windowTotals.ggr >= 0 ? 'up' : 'down'} className="col-span-2 sm:col-span-1 2xl:col-span-2" />
        </>)}
        <StatCard label="Open positions" value={formatNumber(totals.open)} />
        <StatCard label="Needs setup" value={needsSetup} tone={needsSetup > 0 ? 'warn' : 'up'} hint="website address not live yet" />
      </div>

      {/* Live deposits feed, pushed the instant a deposit confirms — every brand for the owner, the
          platform's own brands for a platform admin (docs/42 UI-5); hidden if the feed is refused (P6). */}
      {!live.denied ? <LiveDeposits live={live} nameById={nameById} /> : null}

      {/* Clients table */}
      <Section title="Brands">
        <Toolbar>
          <SearchInput placeholder="Search brand, slug or domain…" value={q} onChange={setQ} />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'archived', label: 'Archived' }]} />
          {currencies.length > 1 ? (
            <FilterSelect label="Currency" value={currency} onChange={setCurrency}
              options={[{ value: 'all', label: 'All' }, ...currencies.map((c) => ({ value: c, label: c }))]} />
          ) : null}
          <FilterSelect label="Period" value={preset} onChange={(v) => setPreset(v as RangePreset)}
            options={[
              { value: 'all', label: 'All-time' },
              { value: 'today', label: 'Today' },
              { value: 'yesterday', label: 'Yesterday' },
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
              { value: 'custom', label: 'Custom…' },
            ]} />
          {preset === 'custom' ? (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent" />
              <span>→</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent" />
            </span>
          ) : null}
          <span className="text-xs text-muted">{rows.length} of {siteList.length}{rangeActive && perf.isLoading ? ' · loading…' : ''}</span>
          <Button variant="outline" size="sm" onClick={exportClients} className="ml-auto">Export CSV</Button>
        </Toolbar>
        <TableWrap>
          <thead>
            <tr>
              <Sortable label="Brand" k="name" sort={sort} setSort={setSort} />
              <Sortable label="Status" k="status" sort={sort} setSort={setSort} />
              <Sortable label="Live" k="live" sort={sort} setSort={setSort} align="right" />
              <Th>Health</Th>
              <Th>Domain</Th>
              <Sortable label="Players" k="players" sort={sort} setSort={setSort} align="right" />
              {rangeActive ? <Sortable label="New" k="newplayers" sort={sort} setSort={setSort} align="right" /> : null}
              <Sortable label="Deposits" k="deposits" sort={sort} setSort={setSort} align="right" />
              <Sortable label="House revenue" k="ggr" sort={sort} setSort={setSort} align="right" />
              <Sortable label="Bets" k="bets" sort={sort} setSort={setSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ s, k, r, m, online }) => (
              <tr key={s.siteId} onClick={() => router.push(`/platform/clients/${s.siteId}`)}
                className="cursor-pointer border-t border-border transition hover:bg-surface-2">
                <Td><span className="font-semibold text-fg">{s.name}</span> <span className="text-muted">· {s.slug}</span></Td>
                <Td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.status === 'active' ? 'bg-up/20 text-up' : s.status === 'paused' ? 'bg-warn/20 text-warn' : 'bg-surface-2 text-muted'}`}>{s.status}</span></Td>
                <Td className="text-right"><LiveCount count={online} /></Td>
                <Td><HealthPill r={r} /></Td>
                <Td className="text-muted">{s.primaryDomain ?? '—'}</Td>
                <Td className="text-right tabular-nums">{formatNumber(k?.users ?? 0)}</Td>
                {rangeActive ? <Td className="text-right tabular-nums">{formatNumber(m.newPlayers ?? 0)}</Td> : null}
                <Td className="text-right tabular-nums">{money(m.deposits, s.currency)}</Td>
                <Td className="text-right tabular-nums">{money(m.ggr, s.currency)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(m.bets)}</Td>
              </tr>
            ))}
            {sorted.length === 0 ? <tr><Td className="text-muted">{sites.isLoading ? 'Loading…' : 'No brands match.'}</Td></tr> : null}
          </tbody>
        </TableWrap>
      </Section>
    </>
  );
}

/** Live online-players KPI with a pulsing connection dot. */
function LiveOnlineCard({ total, connected }: { total: number; connected: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-border bg-surface p-4">
      <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
        <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-up animate-pulse' : 'bg-muted'}`} />
        Live now
      </span>
      <FitText className="text-xl font-bold tabular-nums text-fg sm:text-2xl">{formatNumber(total)}</FitText>
      <span className="text-xs text-muted">{connected ? 'players online' : 'connecting…'}</span>
    </div>
  );
}

/** Per-brand live online count: pulsing green dot + number when anyone is online, else a dash. */
function LiveCount({ count }: { count: number }) {
  if (count <= 0) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-fg">
      <span className="inline-block h-2 w-2 rounded-full bg-up animate-pulse" />
      {formatNumber(count)}
    </span>
  );
}

/** Real-time deposit feed across all brands (pushed via WebSocket the moment each deposit confirms). */
function LiveDeposits({ live, nameById }: { live: ReturnType<typeof usePlatformLive>; nameById: Map<string, string> }) {
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <Section title="Live deposits">
      <div className="rounded-2xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${live.connected ? 'bg-up animate-pulse' : 'bg-muted'}`} />
            {live.connected ? 'Live' : 'Connecting…'}
          </span>
          <span>{live.deposits.length ? `${live.deposits.length} recent` : 'waiting for deposits'}</span>
        </div>
        {live.deposits.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">No deposits yet this session — new confirmations appear here instantly.</p>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto">
            {live.deposits.map((d) => (
              <li key={d.txId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 flex-none rounded-full bg-up" />
                  <span className="truncate font-medium text-fg">{nameById.get(d.siteId) ?? d.siteId.slice(0, 8)}</span>
                  <span className="truncate text-muted">{d.username || d.userId.slice(0, 8)}</span>
                </span>
                <span className="flex flex-none items-center gap-3">
                  <span className="font-semibold tabular-nums text-up">{money(d.amountCents)}</span>
                  <span className="tabular-nums text-xs text-muted">{fmtTime(d.atMs)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

/** Clickable, sort-aware column header (click to toggle desc→asc; shows the active arrow). */
function Sortable({ label, k, sort, setSort, align }: {
  label: string; k: string;
  sort: { key: string; dir: 'asc' | 'desc' };
  setSort: (s: { key: string; dir: 'asc' | 'desc' }) => void;
  align?: 'right';
}) {
  const activeCol = sort.key === k;
  const arrow = activeCol ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  return (
    <Th {...(align === 'right' ? { className: 'text-right' } : {})}>
      <button
        type="button"
        onClick={() => setSort({ key: k, dir: activeCol && sort.dir === 'desc' ? 'asc' : 'desc' })}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg ${activeCol ? 'text-fg' : ''}`}
      >
        {label}<span className="text-[10px]">{arrow}</span>
      </button>
    </Th>
  );
}

/** Compact launch-readiness signal in the clients table: domain set. (Pay-in / Pay-out dots were
 *  removed from the table per product request; full readiness still drives the "Needs setup" KPI.) */
function HealthPill({ r }: { r: { domainState: 'live' | 'pending' | 'unprovisioned' | 'none' } }) {
  const map = {
    live: { cls: 'bg-up/15 text-up', icon: '●', label: 'Domain live' },
    pending: { cls: 'bg-warn/15 text-warn', icon: '◐', label: 'Domain pending' },
    unprovisioned: { cls: 'bg-down/15 text-down', icon: '○', label: 'Not provisioned' },
    none: { cls: 'bg-surface-2 text-muted', icon: '—', label: 'No domain' },
  }[r.domainState];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${map.cls}`}
      title={`Domain: ${map.label} (Cloudflare status)`}>
      <span>{map.icon}</span>{map.label}
    </span>
  );
}

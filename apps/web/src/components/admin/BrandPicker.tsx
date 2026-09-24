'use client';

import * as React from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePlatformSites, usePlatforms } from '@/lib/platform/hooks';
import { OpenBrandButton } from '@/components/platform/OpenBrandButton';
import type { SiteRow } from '@/lib/platform/endpoints';

/**
 * docs/42 UI-2 (owner decision, 2026-09-23): the system owner works a brand's back office ONLY after
 * choosing the brand — every brand-level action then has an explicit brand (the opened session is a
 * brand `admin` session, `act`-marked). Global settings live in the console.
 *
 * UI-F (#32): brands are chosen platform first, then brand (the two-level "scope switcher" used by
 * multi-tenant consoles), instead of one long list of every brand. The platform list shows how many
 * brands each has; the brand list is searchable and hides archived brands unless asked. The chosen
 * platform is kept in the URL (?platform=) and remembered on this device. A search that finds nothing
 * on the chosen platform says where else it matches, so a known brand name is never a dead end.
 */
const NONE = '__none__';
const LAST_KEY = 'brand-picker:last-platform';

function readLast(): string | null {
  try { return window.localStorage.getItem(LAST_KEY); } catch { return null; }
}
function writeLast(v: string) {
  try { window.localStorage.setItem(LAST_KEY, v); } catch { /* private mode: fine */ }
}

export function BrandPicker() {
  const sites = usePlatformSites();
  const platforms = usePlatforms();
  const [q, setQ] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
  const [platformId, setPlatformIdState] = React.useState<string | null>(null);

  const allSites = React.useMemo(() => sites.data?.sites ?? [], [sites.data]);
  const plats = React.useMemo(() => {
    const list = (platforms.data?.platforms ?? []).map((p) => ({ id: p.platformId, name: p.name, status: p.status }));
    if (allSites.some((s) => !s.platformId)) list.push({ id: NONE, name: 'No platform', status: 'active' });
    return list;
  }, [platforms.data, allSites]);

  const keyOf = (s: SiteRow) => s.platformId ?? NONE;
  const counts = React.useMemo(() => {
    const m = new Map<string, { live: number; archived: number }>();
    for (const s of allSites) {
      const c = m.get(keyOf(s)) ?? { live: 0, archived: 0 };
      if (s.status === 'archived') c.archived += 1; else c.live += 1;
      m.set(keyOf(s), c);
    }
    return m;
  }, [allSites]);

  // Initial platform: ?platform= → last used on this device → the platform with the most brands.
  React.useEffect(() => {
    if (platformId || plats.length === 0) return;
    const fromUrl = new URLSearchParams(window.location.search).get('platform');
    const last = readLast();
    const valid = (v: string | null) => !!v && plats.some((p) => p.id === v);
    const busiest = [...plats].sort((a, b) => (counts.get(b.id)?.live ?? 0) - (counts.get(a.id)?.live ?? 0))[0]?.id ?? null;
    setPlatformIdState(valid(fromUrl) ? fromUrl : valid(last) ? last : busiest);
  }, [plats, counts, platformId]);

  const setPlatformId = (v: string) => {
    setPlatformIdState(v);
    writeLast(v);
    const u = new URL(window.location.href);
    u.searchParams.set('platform', v);
    window.history.replaceState(null, '', u.toString());
  };

  const needle = q.trim().toLowerCase();
  const matches = (s: SiteRow) => !needle || [s.name, s.slug, s.primaryDomain ?? ''].some((v) => v.toLowerCase().includes(needle));
  const visible = (s: SiteRow) => showArchived || s.status !== 'archived';
  const rows = allSites
    .filter((s) => keyOf(s) === platformId && visible(s) && matches(s))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Where else does the search match? (only when it finds nothing here)
  const elsewhere = needle && rows.length === 0
    ? plats
      .map((p) => ({ p, n: allSites.filter((s) => keyOf(s) === p.id && p.id !== platformId && visible(s) && matches(s)).length }))
      .filter((x) => x.n > 0)
    : [];
  const current = plats.find((p) => p.id === platformId);
  const archivedHere = counts.get(platformId ?? '')?.archived ?? 0;
  const loading = sites.isLoading || platforms.isLoading;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Brand back office</h1>
        <p className="mt-1 text-sm text-muted">
          Pick a platform, then the brand to work on. You enter it as its admin and can leave from the banner at any
          time. System-wide settings live in the{' '}
          <Link href="/platform" className="text-accent underline-offset-2 hover:underline">system console</Link>.
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : plats.length === 0 ? (
        <p className="text-sm text-muted">No brands yet — onboard one from the console.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          {/* Step 1 — platform. A list on wide screens, a select on phones. */}
          <div className="lg:hidden">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-fg">Platform</span>
              <select aria-label="Platform" value={platformId ?? ''} onChange={(e) => setPlatformId(e.target.value)}
                className="h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-fg">
                {plats.map((p) => <option key={p.id} value={p.id}>{p.name} ({counts.get(p.id)?.live ?? 0})</option>)}
              </select>
            </label>
          </div>
          <nav aria-label="Platforms" className="hidden lg:block">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Platforms</p>
            <ul className="flex flex-col gap-1">
              {plats.map((p) => {
                const on = p.id === platformId;
                const c = counts.get(p.id);
                return (
                  <li key={p.id}>
                    <button type="button" aria-current={on ? 'true' : undefined} onClick={() => setPlatformId(p.id)}
                      className={'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ' +
                        (on ? 'bg-accent/10 font-medium text-fg ring-1 ring-accent/40' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                      <span className="min-w-0 truncate">
                        {p.name}
                        {p.status !== 'active' ? <span className="ml-1.5 text-[10px] uppercase text-warn">{p.status}</span> : null}
                      </span>
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-muted" title="Brands (not archived)">{c?.live ?? 0}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Step 2 — brand. */}
          <section className="flex min-w-0 flex-col gap-3" aria-label={current ? `Brands on ${current.name}` : 'Brands'}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={current ? `Search ${current.name} by name, slug or domain…` : 'Search brands…'}
                aria-label="Search brands"
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
              />
              {archivedHere > 0 ? (
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                  Show archived ({archivedHere})
                </label>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted">
                {needle ? (
                  <>
                    No brand on {current?.name ?? 'this platform'} matches “{q.trim()}”.
                    {elsewhere.length ? (
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        Found on:
                        {elsewhere.map(({ p, n }) => (
                          <button key={p.id} type="button" onClick={() => setPlatformId(p.id)}
                            className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-accent hover:bg-surface-2">
                            {p.name} ({n})
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </>
                ) : 'This platform has no brands yet — onboard one from the console.'}
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface" aria-label="Brands">
                {rows.map((s) => (
                  <li key={s.siteId} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {s.name}
                        {s.status !== 'active' ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium capitalize text-muted">{s.status}</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted">{s.primaryDomain ?? s.slug}</p>
                    </div>
                    <Link href={`/platform/clients/${s.siteId}`} className="hidden shrink-0 text-xs text-muted hover:text-accent hover:underline sm:inline">Settings</Link>
                    <OpenBrandButton siteId={s.siteId} brandName={s.name} label="Open back office" />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">{rows.length} brand{rows.length === 1 ? '' : 's'} shown</p>
          </section>
        </div>
      )}
    </div>
  );
}

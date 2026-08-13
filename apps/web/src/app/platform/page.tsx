'use client';

import { useState } from 'react';
import { PageHeader, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  usePlatformOverview,
  usePlatformSites,
  usePlatformMarketerRollup,
  useCreateSite,
  useUpdateSite,
  useSetSiteConfig,
  useSetSiteTheme,
} from '@/lib/platform/hooks';
import type { SiteWithConfig, SiteKpis, MarketerRollupGroup } from '@/lib/platform/endpoints';
import { deriveMinimalPalette } from '@/lib/brand/derivePalette';

const money = (cents: number, cur: string) => `${cur} ${(cents / 100).toLocaleString()}`;

/** Onboard a new brand: slug + name (+ optional currency/domain) → site + default economy. */
function CreateBrand() {
  const create = useCreateSite();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('KES');
  const [primaryDomain, setDomain] = useState('');

  return (
    <Section title="Onboard a brand">
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { slug: slug.trim(), name: name.trim(), currency: currency.trim() || 'KES', primaryDomain: primaryDomain.trim() || undefined },
            { onSuccess: () => { setSlug(''); setName(''); setDomain(''); } },
          );
        }}
      >
        <Input label="Slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="brandb" required />
        <Input label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brand B" required />
        <Input label="Currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <Input label="Primary domain" name="primaryDomain" value={primaryDomain} onChange={(e) => setDomain(e.target.value)} placeholder="brandb.example" optional />
        <div className="sm:col-span-2 md:col-span-4">
          <Button type="submit" disabled={create.isPending || !slug.trim() || !name.trim()}>
            {create.isPending ? 'Creating…' : 'Create brand'}
          </Button>
          {create.isError ? <span className="ml-3 text-sm text-down">{(create.error as Error).message}</span> : null}
        </div>
      </form>
    </Section>
  );
}

/** Per-brand card: branding (name/status) + the key economy knobs, each saved via its own RPC. */
function BrandCard({ site }: { site: SiteWithConfig }) {
  const update = useUpdateSite();
  const setConfig = useSetSiteConfig();
  const [name, setName] = useState(site.name);
  const [status, setStatus] = useState(site.status);
  const c = site.config;
  const [houseEdge, setHouseEdge] = useState(String(c.houseEdge));
  const [targetWinRate, setWin] = useState(String(c.targetWinRate));
  const [maxMultiplier, setMaxMult] = useState(String(c.maxMultiplier));
  const [minStake, setMinStake] = useState(String(c.minStakeCents));
  const [minWithdrawal, setMinWd] = useState(String(c.minWithdrawalCents));

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-fg">{site.name}</h3>
          <p className="text-xs text-muted">{site.slug} · {site.primaryDomain ?? 'no domain'} · v{c.version}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${site.status === 'active' ? 'bg-up/20 text-up' : 'bg-warn/20 text-warn'}`}>{site.status}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Branding */}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); update.mutate({ id: site.siteId, patch: { name: name.trim(), status } }); }}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Branding</p>
          <Input label="Name" name={`name-${site.siteId}`} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Status</span>
            <select className="h-11 rounded-xl border border-border bg-surface-2 px-3 text-fg" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={update.isPending}>Save branding</Button>
        </form>

        {/* Economy */}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setConfig.mutate({
              id: site.siteId,
              patch: {
                house_edge: Number(houseEdge), target_win_rate: Number(targetWinRate), max_multiplier: Number(maxMultiplier),
                min_stake: Number(minStake), min_withdrawal: Number(minWithdrawal),
              },
            });
          }}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Economy</p>
          <div className="grid grid-cols-2 gap-2">
            <Input label="House edge" name={`he-${site.siteId}`} value={houseEdge} onChange={(e) => setHouseEdge(e.target.value)} />
            <Input label="Target win rate" name={`tw-${site.siteId}`} value={targetWinRate} onChange={(e) => setWin(e.target.value)} />
            <Input label="Max multiplier" name={`mm-${site.siteId}`} value={maxMultiplier} onChange={(e) => setMaxMult(e.target.value)} />
            <Input label="Min stake (cents)" name={`ms-${site.siteId}`} value={minStake} onChange={(e) => setMinStake(e.target.value)} />
            <Input label="Min withdrawal (cents)" name={`mw-${site.siteId}`} value={minWithdrawal} onChange={(e) => setMinWd(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={setConfig.isPending}>Save economy</Button>
          {setConfig.isError ? <span className="text-xs text-down">{(setConfig.error as Error).message}</span> : null}
        </form>
      </div>
      <PaletteEditor site={site} />
    </div>
  );
}

/** Palette editor (docs/22 Task G+): pick a seed colour → the minimal palette is derived client-side
 *  (one hue → full brand-tinted ramp + graph gain/loss), previewed, and persisted via
 *  fn_platform_set_site_theme. Onboarding a brand's look is then a single colour choice. */
function PaletteEditor({ site }: { site: SiteWithConfig }) {
  const setTheme = useSetSiteTheme();
  const [seed, setSeed] = useState(site.colorPrimary || '#22c55e');
  const [mode, setMode] = useState<'dark' | 'light'>(site.theme === 'light' ? 'light' : 'dark');
  const tokens = deriveMinimalPalette(seed, mode);
  const swatches: Array<[string, string]> = [
    ['bg', 'bg'], ['surface', 'surf'], ['border', 'border'], ['muted', 'muted'], ['fg', 'fg'],
    ['brand', 'brand'], ['accent', 'accent'], ['up', 'gain'], ['down', 'loss'],
  ];
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Palette · one seed → derived (max 2–3 colours)</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Seed</span>
          <input
            type="color"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
            aria-label="Brand seed colour"
          />
        </label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'dark' | 'light')}
          className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg"
          aria-label="Theme mode"
        >
          <option value="dark">dark</option>
          <option value="light">light</option>
        </select>
        <span className="font-mono text-xs text-muted">{seed.toLowerCase()}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {swatches.map(([k, lab]) => (
          <div key={k} className="flex flex-col items-center">
            <span className="h-7 w-9 rounded border border-border" style={{ backgroundColor: tokens[k] }} />
            <span className="mt-0.5 text-[9px] text-muted">{lab}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={setTheme.isPending} onClick={() => setTheme.mutate({ id: site.siteId, tokens })}>
          {setTheme.isPending ? 'Saving…' : 'Save palette'}
        </Button>
        {setTheme.isError ? <span className="text-xs text-down">{(setTheme.error as Error).message}</span> : null}
        {setTheme.isSuccess ? <span className="text-xs text-up">Saved — reload the brand to apply.</span> : null}
      </div>
    </div>
  );
}

/** Cross-brand marketer rollup (Task R): who brought which clients on which site, and their total. */
function MarketerRollup() {
  const rollup = usePlatformMarketerRollup();
  const groups: MarketerRollupGroup[] = rollup.data?.marketers ?? [];
  return (
    <Section title="Marketer rollup (cross-brand)">
      <TableWrap>
        <thead>
          <tr>
            <Th>Marketer</Th><Th>Brand</Th><Th>Clients</Th><Th>GGR</Th><Th>Commission</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const key = g.marketerGlobalId ?? g.sites[0]?.affiliateUserId ?? 'unknown';
            const heading = g.label ?? `Unlinked · ${g.sites[0]?.affiliateUserId ?? ''}`;
            return [
              ...g.sites.map((s, i) => (
                <tr key={`${key}-${s.siteId}-${s.affiliateUserId}`} className="border-t border-border">
                  <Td>{i === 0 ? <span className="font-semibold text-fg">{heading}</span> : <span className="text-muted">↳</span>}</Td>
                  <Td>{s.siteName} <span className="text-muted">· {s.siteSlug}</span></Td>
                  <Td>{s.clients.toLocaleString()}</Td>
                  <Td>{money(s.ggrCents, 'KES')}</Td>
                  <Td>{money(s.commissionCents, 'KES')}</Td>
                </tr>
              )),
              g.sites.length > 1 ? (
                <tr key={`${key}-total`} className="border-t border-border bg-surface-2">
                  <Td className="font-semibold text-fg">Total</Td>
                  <Td className="text-muted">{g.sites.length} brands</Td>
                  <Td className="font-semibold text-fg">{g.totals.clients.toLocaleString()}</Td>
                  <Td className="font-semibold text-fg">{money(g.totals.ggrCents, 'KES')}</Td>
                  <Td className="font-semibold text-fg">{money(g.totals.commissionCents, 'KES')}</Td>
                </tr>
              ) : null,
            ];
          })}
          {groups.length === 0 ? (
            <tr><Td className="text-muted">{rollup.isLoading ? 'Loading…' : 'No marketers yet.'}</Td></tr>
          ) : null}
        </tbody>
      </TableWrap>
    </Section>
  );
}

export default function PlatformPage() {
  const overview = usePlatformOverview();
  const sites = usePlatformSites();
  const kpis: SiteKpis[] = overview.data?.sites ?? [];

  return (
    <div className="mx-auto w-full max-w-app space-y-6 p-4">
      <PageHeader title="Platform" subtitle="All brands on this deployment — onboard, tune, and monitor each economy." />

      <Section title="Per-brand KPIs">
        <TableWrap>
          <thead>
            <tr>
              <Th>Brand</Th><Th>Status</Th><Th>Users</Th><Th>Deposits</Th><Th>Withdrawals</Th><Th>GGR</Th><Th>Open</Th><Th>Bets</Th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((k) => (
              <tr key={k.siteId} className="border-t border-border">
                <Td>{k.name} <span className="text-muted">· {k.slug}</span></Td>
                <Td>{k.status}</Td>
                <Td>{k.users.toLocaleString()}</Td>
                <Td>{money(k.depositsCents, 'KES')}</Td>
                <Td>{money(k.withdrawalsCents, 'KES')}</Td>
                <Td>{money(k.ggrCents, 'KES')}</Td>
                <Td>{k.openPositions.toLocaleString()}</Td>
                <Td>{k.bets.toLocaleString()}</Td>
              </tr>
            ))}
            {kpis.length === 0 ? (
              <tr><Td className="text-muted">{overview.isLoading ? 'Loading…' : 'No brands yet.'}</Td></tr>
            ) : null}
          </tbody>
        </TableWrap>
      </Section>

      <CreateBrand />

      <Section title="Brands">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(sites.data?.sites ?? []).map((s) => <BrandCard key={s.siteId} site={s} />)}
        </div>
      </Section>

      <MarketerRollup />
    </div>
  );
}

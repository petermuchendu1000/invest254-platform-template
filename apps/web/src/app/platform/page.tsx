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
} from '@/lib/platform/hooks';
import type { SiteWithConfig, SiteKpis, MarketerRollupGroup } from '@/lib/platform/endpoints';

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

'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { usePlatformSites } from '@/lib/platform/hooks';
import { OpenBrandButton } from '@/components/platform/OpenBrandButton';
import { ClientDetail } from '@/components/platform/ClientDetail';
import { BrandAddons } from '@/components/addons/BrandAddons';
import type { SiteWithConfig } from '@/lib/platform/endpoints';

/** Consolidated single-brand management screen (Yaro Labs "tenant detail" pattern): a sticky header
 *  with identity + status + readiness, then the tabbed management surface (ClientDetail). */
export default function ClientDetailView({ params }: { params: { id: string } }) {
  const sites = usePlatformSites();
  const site = (sites.data?.sites ?? []).find((s) => s.siteId === params.id) as SiteWithConfig | undefined;

  const statusCls = (s: string) =>
    s === 'active' ? 'bg-up/20 text-up' : s === 'paused' ? 'bg-warn/20 text-warn' : 'bg-surface-2 text-muted';

  return (
    <>
      <Link href="/platform" className="text-sm text-muted hover:text-fg">← All brands</Link>

      {sites.isLoading && !site ? (
        <Skeleton className="h-64 w-full" />
      ) : !site ? (
        <Empty title="Brand not found" description="It may have been archived — head back to the overview." />
      ) : (
        <>
          {/* UI-C: status sits with the name; actions share one size. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-fg md:text-2xl">{site.name}</h1>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusCls(site.status)}`}>{site.status}</span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {site.primaryDomain ?? 'No domain yet'} · {site.slug}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {site.primaryDomain ? (
                <a href={`https://${site.primaryDomain}`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-brand border border-border px-3 text-sm font-medium text-fg transition hover:bg-surface-2">
                  Visit site ↗
                </a>
              ) : null}
              <Link href={`/platform/audit?site=${site.siteId}`} className="inline-flex h-9 items-center rounded-brand border border-border px-3 text-sm font-medium text-fg transition hover:bg-surface-2">Audit log</Link>
              <OpenBrandButton siteId={site.siteId} brandName={site.name} />
            </div>
          </div>

          {/* Add-ons are a tab (they used to render under EVERY tab, reading as part of Identity). */}
          <ClientDetail key={site.siteId} site={site} addons={<BrandAddons siteId={site.siteId} />} />
        </>
      )}
    </>
  );
}

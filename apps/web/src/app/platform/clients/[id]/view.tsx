'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { usePlatformSites, useImpersonate } from '@/lib/platform/hooks';
import { startImpersonation } from '@/lib/platform/impersonate';
import { ClientDetail } from '@/components/platform/ClientDetail';
import type { SiteWithConfig } from '@/lib/platform/endpoints';

/** "Log in as superadmin" — mint a brand-scoped superadmin token and enter this brand's admin console. */
function ImpersonateButton({ siteId, brandName }: { siteId: string; brandName: string }) {
  const impersonate = useImpersonate();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={impersonate.isPending}
      onClick={() => impersonate.mutate(siteId, { onSuccess: (res) => startImpersonation(res) })}
      title={`Open ${brandName}'s admin console as its superadmin`}
    >
      {impersonate.isPending ? 'Signing in…' : 'Log in as superadmin ↗'}
    </Button>
  );
}

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-fg">{site.name}</h1>
              <p className="text-xs text-muted">
                {site.slug} · {site.primaryDomain ?? 'no domain'} · economy v{site.config.version}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ImpersonateButton siteId={site.siteId} brandName={site.name} />
              {site.primaryDomain ? (
                <a href={`https://${site.primaryDomain}`} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:text-fg">
                  Open live ↗
                </a>
              ) : null}
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusCls(site.status)}`}>{site.status}</span>
            </div>
          </div>

          <ClientDetail key={site.siteId} site={site} />
        </>
      )}
    </>
  );
}

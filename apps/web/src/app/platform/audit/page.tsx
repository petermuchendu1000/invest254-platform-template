'use client';

/**
 * UI-F — ONE audit log (was three: the owner's global log with raw ids and no brand, the platform admin's
 * activity page, and a per-brand tab). Plain-language actions, the person's name, the brand (or the platform
 * for platform-level actions), a readable summary with the raw record on demand, and filters: platform (owner)
 * and brand. `?site=` deep-links from a brand page. Scope is enforced by the API: a platform admin only ever
 * sees its own platform.
 */
import { useEffect, useMemo, useState } from 'react';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatAgo, formatExact } from '@/lib/format';
import { PageHeader, Section, TableWrap, Th, Td, Empty, FilterSelect } from '@/components/admin/ui';
import { usePlatformAudit, usePlatformSites, usePlatforms } from '@/lib/platform/hooks';
import { useCan } from '@/lib/auth/can';
import { actionLabel, detailSummary } from '@/lib/audit/labels';
import type { PlatformAuditRowDto } from '@/lib/platform/endpoints';

const ROLE: Record<string, string> = { admin: 'Brand admin', platform_admin: 'Platform admin', platform_superadmin: 'System owner', marketer: 'Marketer' };

function AuditInner() {
  const isOwner = useCan('console.system');
  const [platformId, setPlatformId] = useState('');
  const [siteId, setSiteId] = useState('');
  useEffect(() => { const s = new URLSearchParams(window.location.search).get('site'); if (s) setSiteId(s); }, []);
  const platforms = usePlatforms(isOwner);
  const sites = usePlatformSites();
  const q = usePlatformAudit({ platformId: isOwner ? platformId || undefined : undefined, siteId: siteId || undefined });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const brands = (sites.data?.sites ?? []).filter((b) => !platformId || b.platformId === platformId);

  return (
    <>
      <PageHeader title="Audit log" />
      <div className="flex flex-wrap items-center gap-3">
        {isOwner ? (
          <FilterSelect label="Platform" value={platformId} onChange={(v) => { setPlatformId(v); setSiteId(''); }}
            options={[{ value: '', label: 'All platforms' }, ...(platforms.data?.platforms ?? []).map((p) => ({ value: p.platformId, label: p.name }))]} />
        ) : null}
        <FilterSelect label="Brand" value={siteId} onChange={setSiteId}
          options={[{ value: '', label: isOwner ? 'All brands' : 'All my brands' }, ...brands.map((b) => ({ value: b.siteId, label: b.name }))]} />
      </div>
      <Section>
        {q.isLoading ? <Skeleton className="h-40 w-full" />
          : q.isError ? <Empty title="Couldn't load the audit log" description="Try again shortly." />
          : rows.length === 0 ? <Empty title="Nothing recorded yet" description="Privileged actions appear here as they happen." />
          : (
          <>
            <TableWrap>
              <thead><tr className="border-b border-border"><Th>When</Th><Th>Where</Th><Th>Who</Th><Th>What</Th><Th>Details</Th></tr></thead>
              <tbody>{rows.map((r) => <Row key={r.id} r={r} />)}</tbody>
            </TableWrap>
            {q.hasNextPage ? (
              <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </>)}
      </Section>
    </>
  );
}

function Row({ r }: { r: PlatformAuditRowDto }) {
  const summary = detailSummary(r.detail);
  return (
    <tr className="border-b border-border align-top last:border-0">
      <Td className="whitespace-nowrap text-xs text-muted"><span title={formatExact(r.createdAtMs)}>{formatAgo(r.createdAtMs)}</span></Td>
      <Td className="whitespace-nowrap text-sm">{r.siteName ?? <span className="text-muted">Platform</span>}</Td>
      <Td className="whitespace-nowrap text-sm">
        {r.actorUsername ? `@${r.actorUsername}` : <span className="text-muted">Automatic</span>}
        <span className="block text-xs text-muted">{ROLE[r.actorRole] ?? r.actorRole}</span>
      </Td>
      <Td className="text-sm"><span className="font-medium">{actionLabel(r.action)}</span><span className="block font-mono text-[11px] text-muted">{r.action}</span></Td>
      <Td className="text-xs text-muted">
        {summary ? <span className="block max-w-[360px]">{summary}</span> : '—'}
        {r.detail != null ? (
          <details className="mt-1"><summary className="cursor-pointer text-[11px]">Full record</summary>
            <pre className="mt-1 max-w-[420px] overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(r.detail, null, 2)}</pre>
          </details>
        ) : null}
      </Td>
    </tr>
  );
}

export default function AuditPage() {
  return <RequireCapability cap="console.brands" title="The audit log is for platform admins and the System owner"><AuditInner /></RequireCapability>;
}

'use client';

/**
 * docs/42 UI-10 — ONE audit trail across every brand a platform admin runs. Before, a platform admin could
 * only open each brand's Audit tab one at a time (and the owner's global Audit log is owner-only). Rows
 * name the brand and the person, newest first; filter to one brand. Scope is enforced by the API
 * (a platform admin only ever sees its own platform's brands).
 */
import { useMemo, useState } from 'react';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatAgo, formatExact } from '@/lib/format';
import { PageHeader, Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { usePlatformAudit, usePlatformSites } from '@/lib/platform/hooks';
import type { PlatformAuditRowDto } from '@/lib/platform/endpoints';

function detailText(detail: unknown): string {
  if (detail == null) return '—';
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}
const ROLE: Record<string, string> = { admin: 'brand admin', platform_admin: 'platform admin', platform_superadmin: 'System owner' };

function ActivityInner() {
  const [siteId, setSiteId] = useState('');
  const sites = usePlatformSites();
  const q = usePlatformAudit({ siteId: siteId || undefined });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const brands = sites.data?.sites ?? [];

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every privileged action across your brands — who did what, on which brand, and when." />
      <label className="flex max-w-xs flex-col gap-1.5 text-sm">
        <span className="font-medium text-fg">Brand</span>
        <select aria-label="Brand" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg">
          <option value="">All my brands</option>
          {brands.map((b) => <option key={b.siteId} value={b.siteId}>{b.name}</option>)}
        </select>
      </label>
      <Section>
        {q.isLoading ? <Skeleton className="h-40 w-full" />
          : q.isError ? <Empty title="Couldn't load the audit trail" description="Try again shortly." />
          : rows.length === 0 ? <Empty title="No audit entries" description="Privileged actions on your brands will appear here as they happen." />
          : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-border"><Th>When</Th><Th>Brand</Th><Th>Who</Th><Th>Action</Th><Th>Target</Th><Th>Detail</Th></tr>
              </thead>
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
  return (
    <tr className="border-b border-border align-top last:border-0">
      <Td className="whitespace-nowrap text-xs text-muted"><span title={formatExact(r.createdAtMs)}>{formatAgo(r.createdAtMs)}</span></Td>
      <Td className="whitespace-nowrap text-sm">{r.siteName ?? '—'}</Td>
      <Td className="whitespace-nowrap text-sm">
        {r.actorUsername ? `@${r.actorUsername}` : <span className="font-mono text-xs">{r.actorId.slice(0, 8)}…</span>}
        <span className="ml-1.5 text-xs text-muted">{ROLE[r.actorRole] ?? r.actorRole}</span>
      </Td>
      <Td><span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-medium text-fg">{r.action}</span></Td>
      <Td className="text-xs text-muted">{r.targetType}{r.targetId ? <span className="ml-1 font-mono">{r.targetId.slice(0, 8)}…</span> : null}</Td>
      <Td className="font-mono text-xs text-muted"><span className="block max-w-[320px] truncate" title={detailText(r.detail)}>{detailText(r.detail)}</span></Td>
    </tr>
  );
}

export default function PlatformActivityPage() {
  return <RequireCapability cap="console.brands" title="Brand audit is for platform admins"><ActivityInner /></RequireCapability>;
}

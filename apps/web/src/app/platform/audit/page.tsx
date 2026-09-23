'use client';
import { RequireCapability } from '@/components/auth/RequireCapability';

import { useMemo } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatAgo } from '@/lib/format';
import { PageHeader, Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { useAudit } from '@/lib/admin/hooks';
import type { AdminAuditRow } from '@/lib/admin/types';

/** Render the audit detail blob compactly. */
function detailText(detail: unknown): string {
  if (detail == null) return '—';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function AuditPageInner() {
  const q = useAudit();
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Immutable record of every privileged admin action — who did what, to which entity, and when."
      />

      <Section>
        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError ? (
          <Empty title="Couldn't load audit log" description="Try again shortly." />
        ) : rows.length === 0 ? (
          <Empty title="No audit entries" description="Privileged actions will appear here as they happen." />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.id} r={r} />
                ))}
              </tbody>
            </TableWrap>
            {q.hasNextPage ? (
              <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}

function Row({ r }: { r: AdminAuditRow }) {
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="whitespace-nowrap text-xs text-muted">{formatAgo(r.createdAtMs)}</Td>
      <Td className="whitespace-nowrap">
        <span className="font-mono text-xs">{r.actorId.slice(0, 8)}…</span>
        <span className="ml-1.5 text-xs capitalize text-muted">{r.actorRole}</span>
      </Td>
      <Td>
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-medium text-fg">{r.action}</span>
      </Td>
      <Td className="text-xs text-muted">
        <span>{r.targetType}</span>
        {r.targetId ? <span className="ml-1 font-mono">{r.targetId.slice(0, 8)}…</span> : null}
      </Td>
      <Td className="font-mono text-xs text-muted">
        <span className="block max-w-[320px] truncate" title={detailText(r.detail)}>
          {detailText(r.detail)}
        </span>
      </Td>
    </tr>
  );
}

/** docs/42 UI-7: gate BEFORE the page mounts, so no request is made that the session will be refused. */
export default function AuditPage() {
  return <RequireCapability cap="backoffice.audit" title="Audit log is owner-only"><AuditPageInner /></RequireCapability>;
}

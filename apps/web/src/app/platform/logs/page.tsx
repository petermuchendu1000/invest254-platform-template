'use client';
import { RequireCapability } from '@/components/auth/RequireCapability';

import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatExact, formatAgo } from '@/lib/format';
import { PageHeader, Section, TableWrap, Th, Td, Empty, Toolbar, FilterSelect, SearchInput } from '@/components/admin/ui';
import { useSystemLogs } from '@/lib/admin/hooks';
import type { AdminSystemLogRow } from '@/lib/admin/types';

const LEVELS = [
  { value: '', label: 'All levels' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];

const APPS = [
  { value: '', label: 'All services' },
  { value: 'api', label: 'API' },
  { value: 'engine', label: 'Game engine' },
];

const levelBadge = (level: string): string =>
  level === 'error' ? 'bg-down/15 text-down'
    : level === 'warn' ? 'bg-warn/15 text-warn'
      : level === 'info' ? 'bg-surface-2 text-muted'
        : 'bg-surface-2 text-muted';

function fieldsText(fields: unknown): string {
  if (fields == null) return '';
  try { const s = JSON.stringify(fields); return s === '{}' ? '' : s; } catch { return String(fields); }
}

function SystemLogsPageInner() {
  const [app, setApp] = useState('');
  // UI-E: open on errors, the first thing someone opening System logs looks for.
  const [level, setLevel] = useState('error');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  // Debounce the free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(id);
  }, [qInput]);

  const query = useSystemLogs({ ...(app ? { app } : {}), ...(level ? { level } : {}), ...(q ? { q } : {}) });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return (
    <>
      <PageHeader
        title="System logs"
        subtitle="Errors and warnings from the API and the game engine, newest first. Search a message or page address; every entry of one request shares its request id, so one payment can be followed end to end."
      />

      <Section>
        <Toolbar>
          <FilterSelect label="Service" value={app} onChange={setApp} options={APPS} />
          <FilterSelect label="Level" value={level} onChange={setLevel} options={LEVELS} />
          <SearchInput value={qInput} onChange={setQInput} placeholder="Search message or path…" label="Search logs" />
          <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Toolbar>

        <div className="mt-3">
          {query.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : query.isError ? (
            <Empty title="Couldn't load system logs" description="Try again shortly." />
          ) : rows.length === 0 ? (
            <Empty title="No log entries" description={level || q ? 'No logs match this filter.' : 'Warnings and errors will appear here as they happen.'} />
          ) : (
            <>
              <TableWrap>
                <thead>
                  <tr className="border-b border-border">
                    <Th>When</Th>
                    <Th>Level</Th>
                    <Th>Request</Th>
                    <Th>Status</Th>
                    <Th>Message</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row key={r.id} r={r} />
                  ))}
                </tbody>
              </TableWrap>
              {query.hasNextPage ? (
                <Button variant="outline" size="sm" className="mt-3" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </Section>
    </>
  );
}

function Row({ r }: { r: AdminSystemLogRow }) {
  const extra = fieldsText(r.fields);
  const statusTone = r.status == null ? 'text-muted' : r.status >= 500 ? 'text-down' : r.status >= 400 ? 'text-warn' : 'text-up';
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="whitespace-nowrap text-xs text-muted"><span title={formatExact(r.tMs)}>{formatAgo(r.tMs)}</span></Td>
      <Td>
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ${levelBadge(r.level)}`}>{r.level}</span>
      </Td>
      <Td className="text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1 font-mono text-fg">
            {r.app ? <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-semibold uppercase text-muted">{r.app}</span> : null}
            <span>{r.method ? `${r.method} ` : ''}{r.path ?? ''}</span>
          </span>
          <span className="text-muted">
            {r.requestId ? <span className="font-mono">{r.requestId.slice(0, 8)}</span> : null}
            {r.userId ? <span className="ml-1.5">{r.role ?? 'user'} {r.userId.slice(0, 8)}</span> : null}
            {r.durationMs != null ? <span className="ml-1.5">{r.durationMs}ms</span> : null}
          </span>
        </div>
      </Td>
      <Td className={`text-right text-xs font-semibold tabular-nums ${statusTone}`}>{r.status ?? '—'}</Td>
      <Td className="text-xs">
        <span className="block max-w-[420px] truncate text-fg" title={extra ? `${r.msg} · ${extra}` : r.msg}>{r.msg}</span>
        {extra ? <span className="block max-w-[420px] truncate font-mono text-[11px] text-muted" title={extra}>{extra}</span> : null}
      </Td>
    </tr>
  );
}

/** docs/42 UI-7: gate BEFORE the page mounts, so no request is made that the session will be refused. */
export default function SystemLogsPage() {
  return <RequireCapability cap="backoffice.logs" title="System logs are owner-only"><SystemLogsPageInner /></RequireCapability>;
}

'use client';

import { Skeleton } from '@/components/ui/Skeleton';
import { Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { formatExact, formatAgo, formatNumber } from '@/lib/format';
import { useSweeps } from '@/lib/admin/hooks';
import type { AdminSweepRow } from '@/lib/admin/types';

/**
 * The background-job board (BUGLOG #162) — does the backend's unattended work still run?
 *
 * WHY IT SITS ABOVE THE LOG TABLE. The sweeps that settle deposits whose provider callback never
 * arrived, and the monitor that notices a brand's players losing 100% of their stakes, all log only
 * when they have something to report. So an empty System logs page has two meanings — "nothing is
 * wrong" and "nothing is running" — and the page said the first one out loud: "Warnings and errors
 * will appear here as they happen." An operator who reads that learns to treat a blank screen as
 * reassurance, which is precisely the inference a stopped timer needs them to make.
 *
 * So this panel asserts health POSITIVELY and with a timestamp — "All 9 jobs running, checked 12s
 * ago" — because a positive claim can be wrong in a way a person notices, and an absence cannot.
 * That is the whole design: the primary question ("is it running?") answered before the secondary
 * one ("what went wrong?"), in the operator's words rather than the implementation's.
 */

/** Implementation status -> what an operator actually needs to read, and its tone. */
const LABEL: Record<AdminSweepRow['status'], { text: string; pill: string; rank: number }> = {
  stale: { text: 'Stopped', pill: 'bg-down/15 text-down', rank: 0 },
  failing: { text: 'Failing', pill: 'bg-warn/15 text-warn', rank: 1 },
  pending: { text: 'Starting', pill: 'bg-surface-2 text-muted', rank: 2 },
  ok: { text: 'Running', pill: 'bg-up/15 text-up', rank: 3 },
};

/** `every 30m` / `every 15s` — the cadence in the units the operator set it in. */
function cadence(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'off';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** One sentence naming the worst thing true right now, so the colour is never the only signal. */
function verdict(rows: AdminSweepRow[]): { text: string; pill: string } {
  const n = (s: AdminSweepRow['status']) => rows.filter((r) => r.status === s).length;
  const stopped = n('stale');
  const failing = n('failing');
  const job = (c: number) => `${c} job${c === 1 ? '' : 's'}`;
  if (stopped > 0) return { text: `${job(stopped)} stopped — its work is not happening`, pill: 'bg-down/15 text-down' };
  if (failing > 0) return { text: `${job(failing)} running but failing`, pill: 'bg-warn/15 text-warn' };
  if (n('pending') === rows.length) return { text: `${job(rows.length)} starting up`, pill: 'bg-surface-2 text-muted' };
  return { text: `All ${job(rows.length)} running`, pill: 'bg-up/15 text-up' };
}

export function SweepBoard() {
  const query = useSweeps();
  const rows = query.data?.items ?? [];
  // Two API machines can be up at once (Fly `auto_start_machines`), and then WHICH machine a job
  // stopped on is the useful fact. With one machine it is noise, so the column earns its place.
  const machines = new Set(rows.map((r) => r.machine));
  const v = verdict(rows);

  return (
    <Section title="Background jobs">
      {query.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : query.isError ? (
        <Empty title="Couldn't load the job board" description="Try again shortly." />
      ) : rows.length === 0 ? (
        // NOT "all good". No heartbeats at all means either a release that has not booted yet or an
        // API that never armed its sweeps — both of which an operator must go and look at.
        <Empty
          title="No jobs are reporting"
          description="The API records a heartbeat for every background job as it arms. None has arrived, so either this release has not finished rolling out or the sweeps did not start."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.pill}`}>{v.text}</span>
            <span className="text-muted">
              checked <span title={formatExact(Date.now())}>{query.isFetching ? 'now' : formatAgo(query.dataUpdatedAt)}</span>
            </span>
          </div>

          <TableWrap>
            <thead>
              <tr className="border-b border-border">
                <Th>Job</Th>
                {machines.size > 1 ? <Th>Machine</Th> : null}
                <Th>Status</Th>
                <Th>Last run</Th>
                <Th numeric>Every</Th>
                <Th numeric>Runs</Th>
                <Th>Last error</Th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => LABEL[a.status].rank - LABEL[b.status].rank || b.ageMs - a.ageMs || a.name.localeCompare(b.name))
                .map((r) => (
                  <JobRow key={`${r.app}/${r.machine}/${r.name}`} r={r} showMachine={machines.size > 1} />
                ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </Section>
  );
}

function JobRow({ r, showMachine }: { r: AdminSweepRow; showMachine: boolean }) {
  const label = LABEL[r.status];
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="whitespace-nowrap font-mono text-xs text-fg">{r.name}</Td>
      {showMachine ? <Td className="whitespace-nowrap font-mono text-[11px] text-muted">{r.machine}</Td> : null}
      <Td>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${label.pill}`}>{label.text}</span>
      </Td>
      <Td className="whitespace-nowrap text-xs text-muted">
        {r.lastRunAtMs == null
          ? <span title={`armed ${formatExact(r.armedAtMs)}`}>never</span>
          : <span title={formatExact(r.lastRunAtMs)}>{formatAgo(r.lastRunAtMs)}</span>}
      </Td>
      <Td numeric className="whitespace-nowrap text-xs tabular-nums text-muted">{cadence(r.everyMs)}</Td>
      <Td numeric className="whitespace-nowrap text-xs tabular-nums text-muted">
        {formatNumber(r.runs)}
        {r.failures > 0 ? <span className="ml-1 text-down">/{formatNumber(r.failures)}</span> : null}
      </Td>
      <Td className="text-xs">
        {r.lastError ? (
          <span className="block max-w-[320px] truncate font-mono text-[11px] text-muted" title={r.lastError}>{r.lastError}</span>
        ) : <span className="text-muted">-</span>}
      </Td>
    </tr>
  );
}

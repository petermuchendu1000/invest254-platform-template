'use client';

import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { useRealCashRtp, useConfigReview } from '@/lib/admin/hooks';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const fmtDate = (ms: number) => new Date(ms).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });

/**
 * Real-cash RTP (audit rec #7). Reads COMMITTED CASH from the ledger — real players vs the marketer
 * (demo) cohort shown SEPARATELY — distinct from the virtual-curve RTP monitor (which reads positions
 * and, in pool mode, reflects the virtual curve rather than real cash exposure).
 */
export function RealCashRtpPanel() {
  const q = useRealCashRtp();
  return (
    <Section title="Real-cash RTP (committed money)">
      <p className="mb-2 text-xs text-muted">
        True cash exposure from the ledger. <strong>Real players</strong> is withdrawable money;{' '}
        <strong>Marketer (demo)</strong> is non-withdrawable funny money, shown separately. This is
        distinct from the virtual-curve RTP monitor above.{q.data?.rtpTarget != null && <> Target RTP: <strong>{pct(q.data.rtpTarget)}</strong>.</>}
      </p>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.isError || !q.data ? (
        <Empty title="Couldn't load real-cash RTP" description="Check your connection and try again." />
      ) : (
        <TableWrap>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Window</Th>
                <Th numeric>Real RTP</Th><Th numeric>Real turnover</Th><Th numeric>Real GGR</Th>
                <Th numeric>Marketer RTP</Th><Th numeric>Marketer turnover</Th>
                <Th numeric>Deposits</Th><Th numeric>Withdrawals</Th><Th numeric>Net cash</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.windows.map((w) => (
                <tr key={w.window}>
                  <Td className="capitalize">{w.window}</Td>
                  <Td numeric>{pct(w.real.rtp)}</Td>
                  <Td numeric><Money cents={w.real.turnoverCents} /></Td>
                  <Td numeric className={w.real.ggrCents > 0 ? 'text-up' : w.real.ggrCents < 0 ? 'text-down' : 'text-muted'}><Money cents={w.real.ggrCents} /></Td>
                  <Td numeric className="text-muted">{pct(w.demo.rtp)}</Td>
                  <Td numeric className="text-muted"><Money cents={w.demo.turnoverCents} /></Td>
                  <Td numeric><Money cents={w.cash.depositsCents} /></Td>
                  <Td numeric><Money cents={w.cash.withdrawalsCents} /></Td>
                  <Td numeric className={w.cash.netCashCents > 0 ? 'text-up' : w.cash.netCashCents < 0 ? 'text-down' : 'text-muted'}><Money cents={w.cash.netCashCents} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Section>
  );
}

/**
 * Economy change review (docs/28 §4). Recent site_game_config versions with a per-field diff and a
 * risk flag (large house-edge drop, big win-rate swing, or thin edge) — the human review layer on top
 * of the per-hour rate-limit + append-only version guards.
 */
export function ConfigChangeReviewPanel() {
  const q = useConfigReview(30);
  return (
    <Section title="Economy change review">
      <p className="mb-2 text-xs text-muted">
        Recent economy-config changes with risk flags. Rapid churn is also capped (6/hour) and versions
        are append-only, so provable-fairness provenance can never be pruned.
      </p>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.isError || !q.data ? (
        <Empty title="Couldn't load change review" description="Check your connection and try again." />
      ) : q.data.length === 0 ? (
        <Empty title="No economy changes" description="No config versions recorded for this brand." />
      ) : (
        <TableWrap>
          <table className="w-full text-sm">
            <thead>
              <tr><Th>Version</Th><Th>When (EAT)</Th><Th numeric>House edge</Th><Th numeric>Win rate</Th><Th>Changed</Th><Th>Review</Th></tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.version} className={r.risk ? 'bg-amber-50 dark:bg-amber-950/40' : undefined}>
                  <Td>v{r.version}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(r.createdAtMs)}</Td>
                  <Td numeric>{r.houseEdge}{r.prevHouseEdge != null && r.prevHouseEdge !== r.houseEdge && <span className="text-muted"> (was {r.prevHouseEdge})</span>}</Td>
                  <Td numeric>{r.targetWinRate}{r.prevTargetWinRate != null && r.prevTargetWinRate !== r.targetWinRate && <span className="text-muted"> (was {r.prevTargetWinRate})</span>}</Td>
                  <Td className="text-muted">{r.changedFields.join(', ') || '—'}</Td>
                  <Td>
                    {r.risk
                      ? <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200" title={r.riskReason}>⚠ review</span>
                      : <span className="text-xs text-muted">ok</span>}
                    {r.risk && <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{r.riskReason}</div>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Section>
  );
}

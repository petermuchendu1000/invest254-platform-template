'use client';

import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { Section, TableWrap, Th, Td, Empty } from '@/components/admin/ui';
import { useCan } from '@/lib/auth/can';
import { useRtp } from '@/lib/admin/hooks';
import { RealCashRtpPanel, ConfigChangeReviewPanel } from '@/components/admin/EconomyIntegrityPanels';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * UI-F — Game health, ONE home (was on the Overview, beside the same KPIs as Reports): how much of what players
 * stake comes back to them per time window, against the brand's target, plus (owner tier) the real-money view and
 * the economy change history.
 */
export function GameHealth() {
  const rtp = useRtp();
  const showIntegrity = useCan('backoffice.economy_integrity');
  return (
    <>
      <Section title="Return to player">
        {rtp.isLoading ? <Skeleton className="h-28 w-full" /> : rtp.isError || !rtp.data ? <Empty title="Not available right now" /> : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">Target <span className="font-medium text-fg">{pct(rtp.data.targetRtp)}</span>, allowed range ±{pct(rtp.data.toleranceAbs)}</span>
              <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + (rtp.data.alert ? 'bg-down/15 text-down' : 'bg-up/15 text-up')}>
                {rtp.data.alert ? 'Outside the allowed range' : 'Within range'}
              </span>
            </div>
            <TableWrap>
              <thead><tr className="border-b border-border"><Th>Period</Th><Th numeric>Trades</Th><Th numeric>Staked</Th><Th numeric>Paid back</Th><Th numeric>Return to player</Th></tr></thead>
              <tbody>
                {rtp.data.windows.map((w) => {
                  const off = w.realisedRtp !== null && Math.abs(w.realisedRtp - rtp.data!.targetRtp) > rtp.data!.toleranceAbs;
                  return (
                    <tr key={w.window} className="border-b border-border last:border-0">
                      <Td className="font-medium capitalize">{w.window}</Td>
                      <Td numeric>{w.settledPositions}</Td>
                      <Td numeric><Money cents={w.turnoverCents} /></Td>
                      <Td numeric><Money cents={w.payoutCents} /></Td>
                      <Td numeric className={'font-medium ' + (off ? 'text-down' : 'text-fg')}>{w.realisedRtp === null ? '—' : pct(w.realisedRtp)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
            <p className="text-xs text-muted">Return to player = paid back ÷ staked. A period outside the allowed range (with enough trades) raises an alert on the Overview.</p>
          </div>
        )}
      </Section>
      {showIntegrity ? (<><RealCashRtpPanel /><ConfigChangeReviewPanel /></>) : null}
    </>
  );
}

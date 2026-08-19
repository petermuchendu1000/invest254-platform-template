'use client';

import { PageHeader, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { usePlatformMarketerRollup } from '@/lib/platform/hooks';
import type { MarketerRollupGroup } from '@/lib/platform/endpoints';

const money = (cents: number, cur = 'KES') => `${cur} ${(cents / 100).toLocaleString()}`;

/** Cross-brand marketer rollup: who brought which clients on which site, and their totals. */
export default function MarketersPage() {
  const rollup = usePlatformMarketerRollup();
  const groups: MarketerRollupGroup[] = rollup.data?.marketers ?? [];
  return (
    <>
      <PageHeader title="Marketer rollup" subtitle="Cross-brand view — which marketer brought which clients on which brand, and their totals." />
      <Section title="By marketer">
        <TableWrap>
          <thead>
            <tr><Th>Marketer</Th><Th>Brand</Th><Th className="text-right">Clients</Th><Th className="text-right">GGR</Th><Th className="text-right">Commission</Th></tr>
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
                    <Td className="text-right tabular-nums">{s.clients.toLocaleString()}</Td>
                    <Td className="text-right tabular-nums">{money(s.ggrCents)}</Td>
                    <Td className="text-right tabular-nums">{money(s.commissionCents)}</Td>
                  </tr>
                )),
                g.sites.length > 1 ? (
                  <tr key={`${key}-total`} className="border-t border-border bg-surface-2">
                    <Td className="font-semibold text-fg">Total</Td>
                    <Td className="text-muted">{g.sites.length} brands</Td>
                    <Td className="text-right font-semibold text-fg tabular-nums">{g.totals.clients.toLocaleString()}</Td>
                    <Td className="text-right font-semibold text-fg tabular-nums">{money(g.totals.ggrCents)}</Td>
                    <Td className="text-right font-semibold text-fg tabular-nums">{money(g.totals.commissionCents)}</Td>
                  </tr>
                ) : null,
              ];
            })}
            {groups.length === 0 ? <tr><Td className="text-muted">{rollup.isLoading ? 'Loading…' : 'No marketers yet.'}</Td></tr> : null}
          </tbody>
        </TableWrap>
      </Section>
    </>
  );
}

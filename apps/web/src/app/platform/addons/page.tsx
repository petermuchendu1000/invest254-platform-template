'use client';

import { useMemo, useState } from 'react';
import { PageHeader, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAddonCatalog, useAddonRequests, useDecideAddonRequest, useSetAddonPrice } from '@/lib/addons/hooks';
import type { CatalogItem } from '@/lib/addons/endpoints';
import { formatDate } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';

const money = (cents: number) => formatKes(cents);
const CAT_LABEL: Record<string, string> = { chart: 'Price charts', trade_ui: 'Trade interfaces', payment_gateway: 'Payment gateways' };

/**
 * System-admin add-on console (Issue 2): edit prices for every sellable "system" and approve/reject
 * the requests operators raise. System-owner only (nav + page are gated in PlatformShell).
 */
export default function AddonsConsolePage() {
  const catQ = useAddonCatalog();
  const reqQ = useAddonRequests('requested');
  const setPrice = useSetAddonPrice();
  const decide = useDecideAddonRequest();

  const items = useMemo(() => catQ.data?.items ?? [], [catQ.data]);
  const requests = useMemo(() => reqQ.data?.requests ?? [], [reqQ.data]);
  const [draftKes, setDraftKes] = useState<Record<string, string>>({});
  const rowKey = (c: CatalogItem) => `${c.category}:${c.key}`;

  return (
    <>
      <PageHeader title="Add-ons & requests" subtitle="Price the sellable systems (charts, trade interfaces, payment gateways) and approve operators' requests." />

      {/* ── Requests inbox ─────────────────────────────────────────────────────────────────── */}
      <Section title={`Pending requests${requests.length ? ` (${requests.length})` : ''}`}>
        <TableWrap>
          <table className="w-full text-sm">
            <thead><tr><Th>Brand</Th><Th>System</Th><Th>Price</Th><Th>Requested</Th><Th> </Th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <Td>{r.name || r.slug}</Td>
                  <Td>{CAT_LABEL[r.category] ?? r.category} · <b>{r.key}</b></Td>
                  <Td>{money(r.price_cents)}</Td>
                  <Td className="whitespace-nowrap">{formatDate(r.created_at)}</Td>
                  <Td>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>Approve</Button>
                      <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}>Reject</Button>
                    </div>
                  </Td>
                </tr>
              ))}
              {requests.length === 0 ? <tr><Td>No pending requests.</Td><Td> </Td><Td> </Td><Td> </Td><Td> </Td></tr> : null}
            </tbody>
          </table>
        </TableWrap>
        {decide.isError ? <p className="mt-2 text-sm text-down">{(decide.error as Error).message}</p> : null}
      </Section>

      {/* ── Catalog + pricing ──────────────────────────────────────────────────────────────── */}
      <Section title="Catalog & pricing">
        <TableWrap>
          <table className="w-full text-sm">
            <thead><tr><Th>Category</Th><Th>System</Th><Th>Default</Th><Th>Price (KES)</Th><Th> </Th></tr></thead>
            <tbody>
              {items.map((c) => {
                const k = rowKey(c);
                const draft = draftKes[k] ?? String(c.price_cents / 100);
                const changed = Math.round(Number(draft) * 100) !== c.price_cents;
                return (
                  <tr key={k}>
                    <Td>{CAT_LABEL[c.category] ?? c.category}</Td>
                    <Td><b>{c.display_name}</b> <span className="text-muted">({c.key})</span></Td>
                    <Td>{c.is_default ? <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">FREE DEFAULT</span> : ''}</Td>
                    <Td>
                      <div className="w-40">
                        <Input label="" inputMode="decimal" value={draft} disabled={c.is_default}
                          onChange={(e) => setDraftKes((p) => ({ ...p, [k]: e.target.value }))} />
                      </div>
                    </Td>
                    <Td>
                      <Button size="sm" variant="secondary"
                        disabled={c.is_default || setPrice.isPending || !changed || !Number.isFinite(Number(draft)) || Number(draft) < 0}
                        onClick={() => setPrice.mutate({ category: c.category, key: c.key, priceCents: Math.round(Number(draft) * 100) })}>
                        Save
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        {setPrice.isError ? <p className="mt-2 text-sm text-down">{(setPrice.error as Error).message}</p> : null}
        <p className="mt-2 text-xs text-muted">Default systems (line chart, classic UI, M-Pesa) are free and can't be priced. Everything else is a paid add-on operators can request.</p>
      </Section>
    </>
  );
}

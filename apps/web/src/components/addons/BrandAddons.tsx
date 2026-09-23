'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useAddonBrand, useRequestAddon, useGrantAddon, useRevokeAddon } from '@/lib/addons/hooks';
import { useCan } from '@/lib/auth/can';
import type { BrandAddonRow } from '@/lib/addons/endpoints';

const money = (c: number) => `KES ${(c / 100).toLocaleString()}`;
const CATS: { cat: BrandAddonRow['category']; title: string; hint: string }[] = [
  { cat: 'chart', title: 'Price charts', hint: 'The live price-chart system players see.' },
  { cat: 'trade_ui', title: 'Trade interfaces', hint: 'The trade-terminal layout.' },
  { cat: 'payment_gateway', title: 'Payment gateways', hint: 'Deposit / withdrawal rails.' },
];

function Badge({ kind }: { kind: 'active' | 'owned' | 'locked' }) {
  const map = {
    active: 'bg-up/15 text-up', owned: 'bg-accent/15 text-accent', locked: 'bg-surface-2 text-muted',
  } as const;
  const label = { active: 'Active', owned: 'Owned', locked: 'Locked' }[kind];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[kind]}`}>{label}</span>;
}

/**
 * Brand-side add-on catalog (Issue 2): every sellable system shown with its locked / owned / active
 * state and price. Locked systems get a Request button (charts/UI) or an "Add {gateway} for KES X"
 * button (payments). Only the system admin can actually assign — this raises a request. `siteId` is
 * required for a platform admin (managing a brand in its platform); a site admin omits it (its token
 * resolves its own brand server-side).
 */
export function BrandAddons({ siteId }: { siteId?: string }) {
  const q = useAddonBrand(siteId);
  const req = useRequestAddon();
  const rows = q.data?.items ?? [];
  const onRequest = (r: BrandAddonRow) => req.mutate({ ...(siteId ? { site: siteId } : {}), category: r.category, key: r.key });
  // docs/42 UI-9: the System admin ASSIGNS / REMOVES directly on a brand page (the API allowed it; the UI
  // only ever offered "Request"). Every change is confirmed inline with its effect on players.
  const assigner = useCan('console.system') && !!siteId;
  if (assigner) return <OwnerAddons siteId={siteId!} rows={rows} loading={q.isLoading} />;

  return (
    <div className="flex flex-col gap-6">
      {CATS.map(({ cat, title, hint }) => {
        const list = rows.filter((r) => r.category === cat);
        return (
          <div key={cat}>
            <div className="mb-2"><h3 className="text-sm font-semibold text-fg">{title}</h3><p className="text-xs text-muted">{hint}</p></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              {list.map((r) => (
                <div key={r.key} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-fg">{r.display_name}</span>
                    <Badge kind={r.active ? 'active' : r.entitled ? 'owned' : 'locked'} />
                  </div>
                  <div className="text-xs text-muted">{r.is_default ? 'Included free' : r.price_cents > 0 ? money(r.price_cents) : 'Included'}</div>
                  {!r.entitled ? (
                    r.pending
                      ? <span className="text-xs font-medium text-warn">Requested — awaiting system admin</span>
                      : <Button size="sm" variant="secondary" disabled={req.isPending} onClick={() => onRequest(r)}>
                          {cat === 'payment_gateway'
                            ? `Add ${r.display_name}${r.price_cents > 0 ? ` for ${money(r.price_cents)}` : ''}`
                            : `Request ${r.display_name}`}
                        </Button>
                  ) : null}
                </div>
              ))}
              {list.length === 0 ? <p className="text-sm text-muted">None available.</p> : null}
            </div>
          </div>
        );
      })}
      {req.isError ? <p className="text-sm text-down">{(req.error as Error).message}</p> : null}
      {req.isSuccess ? <p className="text-sm text-up">Request sent to the system admin — you'll be notified when it's decided.</p> : null}
      <p className="text-xs text-muted">Locked systems must be assigned by the system admin. Requesting notifies them; you'll see the status update here.</p>
    </div>
  );
}

type Pending = { row: BrandAddonRow; action: 'grant' | 'revoke' } | null;

/** The System admin's view of one brand's add-ons: assign a locked system, remove an owned one. */
function OwnerAddons({ siteId, rows, loading }: { siteId: string; rows: BrandAddonRow[]; loading: boolean }) {
  const grant = useGrantAddon();
  const revoke = useRevokeAddon();
  const [pending, setPending] = useState<Pending>(null);
  const [done, setDone] = useState<string | null>(null);
  const busy = grant.isPending || revoke.isPending;
  const error = (grant.error ?? revoke.error) as Error | null;

  const effect = (p: NonNullable<Pending>): string => {
    const { row, action } = p;
    if (action === 'grant') {
      const price = row.price_cents > 0 ? ` It is billed at ${money(row.price_cents)}.` : '';
      return row.category === 'payment_gateway'
        ? `Players of this brand can use ${row.display_name} once it is configured.${price}`
        : `${row.display_name} becomes this brand's ACTIVE ${row.category === 'chart' ? 'chart' : 'trade interface'} for every player now.${price}`;
    }
    if (row.category === 'payment_gateway') return `Deposits and withdrawals through ${row.display_name} stop for this brand.`;
    return row.active
      ? `${row.display_name} is in use — players switch back to the default ${row.category === 'chart' ? 'chart' : 'interface'} now.`
      : `The brand loses access to ${row.display_name}.`;
  };

  async function confirm() {
    if (!pending) return;
    const body = { site: siteId, category: pending.row.category, key: pending.row.key };
    try {
      if (pending.action === 'grant') await grant.mutateAsync(body); else await revoke.mutateAsync(body);
      setDone(`${pending.row.display_name} ${pending.action === 'grant' ? 'assigned' : 'removed'}.`);
      setPending(null);
    } catch { /* error shown below */ }
  }

  if (loading) return <p className="text-sm text-muted">Loading add-ons…</p>;
  return (
    <div className="flex flex-col gap-6">
      {CATS.map(({ cat, title, hint }) => {
        const list = rows.filter((r) => r.category === cat);
        return (
          <div key={cat}>
            <div className="mb-2"><h3 className="text-sm font-semibold text-fg">{title}</h3><p className="text-xs text-muted">{hint}</p></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              {list.map((r) => {
                const open = pending?.row.key === r.key && pending.row.category === r.category;
                return (
                  <div key={r.key} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-fg">{r.display_name}</span>
                      <Badge kind={r.active ? 'active' : r.entitled ? 'owned' : 'locked'} />
                    </div>
                    <div className="text-xs text-muted">{r.is_default ? 'Included free' : r.price_cents > 0 ? money(r.price_cents) : 'Included'}</div>
                    {open ? (
                      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2 text-xs">
                        <p>{effect(pending!)}</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
                          <Button size="sm" variant={pending!.action === 'revoke' ? 'down' : 'primary'} onClick={confirm} disabled={busy}>
                            {pending!.action === 'grant' ? 'Confirm assign' : 'Confirm remove'}
                          </Button>
                        </div>
                      </div>
                    ) : !r.entitled ? (
                      r.pending
                        ? <Link href="/platform/addons" className="text-xs font-medium text-warn hover:underline">Requested by the brand — review in Add-ons &amp; requests</Link>
                        : <Button size="sm" variant="secondary" onClick={() => { setDone(null); setPending({ row: r, action: 'grant' }); }}>Assign…</Button>
                    ) : !r.is_default ? (
                      <Button size="sm" variant="outline" onClick={() => { setDone(null); setPending({ row: r, action: 'revoke' }); }}>Remove…</Button>
                    ) : null}
                  </div>
                );
              })}
              {list.length === 0 ? <p className="text-sm text-muted">None available.</p> : null}
            </div>
          </div>
        );
      })}
      {error ? <p className="text-sm text-down">{error.message}</p> : null}
      {done ? <p className="text-sm text-up">{done}</p> : null}
      <p className="text-xs text-muted">As the System owner, your changes apply to this brand immediately and are recorded in the audit log.</p>
    </div>
  );
}

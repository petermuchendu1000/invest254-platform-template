'use client';

import { Button } from '@/components/ui/Button';
import { useAddonBrand, useRequestAddon } from '@/lib/addons/hooks';
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

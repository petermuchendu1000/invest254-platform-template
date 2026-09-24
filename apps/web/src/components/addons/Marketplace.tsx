'use client';

import * as React from 'react';
import Link from 'next/link';
import { formatKes } from '@invest254/shared/money';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/admin/ui';
import { GatewayLogo } from '@/components/platform/GatewayLogo';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  useActivateAddon, useAddonBrand, useAddonRequests, useCancelAddonRequest, useGrantAddon,
  useRequestAddon, useRevokeAddon,
} from '@/lib/addons/hooks';
import type { AddonCategory, AddonRequestRow, BillingType, BrandAddonRow } from '@/lib/addons/endpoints';

/**
 * ADDON-1 (docs/48) — the add-ons marketplace (the Shopify App Store / Stripe Apps pattern): every system is a
 * card with a preview, a one-line promise, an honest price ("KES 50,000 one-off + KES 2,500 setup"), its state
 * for this brand (In use · Owned · Requested · Available) and ONE next action. Brands request (with a reason) or
 * switch between systems they own; the System owner assigns, removes and reviews requests right on the card.
 */
export const CATEGORY: Record<AddonCategory, { title: string; short: string; hint: string }> = {
  chart: { title: 'Price charts', short: 'Charts', hint: 'How players see the live price. One is in use at a time.' },
  trade_ui: { title: 'Trade screens', short: 'Trade screens', hint: 'The trading screen players use. One is in use at a time.' },
  payment_gateway: { title: 'Payment gateways', short: 'Gateways', hint: 'Extra ways for players to deposit. Owned gateways are set up in Payment accounts.' },
};
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** "Free" · "KES 50,000 one-off" · "KES 5,000 / month" (+ setup). */
export function priceText(t: BillingType, price: number, setup = 0): { main: string; extra: string | null } {
  const main = t === 'free' || price === 0 ? 'Free' : t === 'monthly' ? `${formatKes(price)} / month` : `${formatKes(price)} one-off`;
  return { main, extra: setup > 0 ? `+ ${formatKes(setup)} setup` : null };
}
/** What approving / assigning puts on the platform's invoices, in one sentence. */
export function billingSentence(t: BillingType, price: number, setup: number): string {
  if (t === 'free' || (price === 0 && setup === 0)) return 'It is free — nothing is billed.';
  if (t === 'monthly') return `${formatKes(price)} a month is added to the platform's invoices from the next renewal${setup > 0 ? `, plus a one-off ${formatKes(setup)} setup fee on the next invoice` : ''}.`;
  return `${formatKes(price + setup)} is added once to the platform's next invoice${setup > 0 ? ` (${formatKes(price)} + ${formatKes(setup)} setup)` : ''}.`;
}

export function AddonPreview({ category, keyName, name }: { category: AddonCategory; keyName: string; name: string }) {
  if (category === 'payment_gateway') {
    return <div className="flex h-20 items-center justify-center rounded-xl bg-surface-2">{keyName === 'mpesa'
      ? <span className="text-lg font-black tracking-tight text-up">M-PESA</span> : <GatewayLogo code={keyName} name={name} />}</div>;
  }
  const up = 'var(--pp-up, #16C784)', down = 'var(--pp-down, #EA3943)', acc = 'var(--pp-accent, #67E997)';
  const pts = [38, 30, 34, 22, 27, 16, 20, 12, 18, 9];
  const line = pts.map((y, i) => `${8 + i * 20},${y}`).join(' ');
  return (
    <div className="flex h-20 items-center justify-center overflow-hidden rounded-xl bg-surface-2" aria-hidden>
      <svg viewBox="0 0 200 50" className="h-16 w-full max-w-[220px]">
        {category === 'trade_ui' ? (keyName === 'digits' ? (
          <g fontFamily="monospace" fontSize="15" fontWeight="700">{[3, 7, 1, 8, 4, 6].map((d, i) => (
            <g key={i}><rect x={10 + i * 31} y="10" width="26" height="30" rx="5" fill={i === 3 ? acc : 'transparent'} opacity={i === 3 ? 0.25 : 1} stroke="currentColor" strokeOpacity="0.25" />
              <text x={23 + i * 31} y="31" textAnchor="middle" fill="currentColor">{d}</text></g>))}</g>
        ) : (
          <g><polyline points={line} fill="none" stroke={acc} strokeWidth="2.5" />
            <rect x="140" y="8" width="52" height="15" rx="4" fill={up} opacity="0.85" /><rect x="140" y="27" width="52" height="15" rx="4" fill={down} opacity="0.85" /></g>
        )) : keyName === 'line' ? <polyline points={line} fill="none" stroke={acc} strokeWidth="2.5" />
          : keyName === 'area' ? <g><polygon points={`8,50 ${line} 188,50`} fill={acc} opacity="0.25" /><polyline points={line} fill="none" stroke={acc} strokeWidth="2.5" /></g>
          : keyName === 'baseline' ? <g><line x1="0" y1="24" x2="200" y2="24" stroke="currentColor" strokeOpacity="0.3" strokeDasharray="3 3" />
              <polyline points={[20, 28, 18, 30, 14, 26, 12, 30, 22, 16].map((y, i) => `${8 + i * 20},${y}`).join(' ')} fill="none" stroke={acc} strokeWidth="2.5" /></g>
          : pts.map((y, i) => {
              const o = i ? pts[i - 1]! : y + 4, c = y, hi = Math.min(o, c) - 4, lo = Math.max(o, c) + 4, x = 10 + i * 19, col = c <= o ? up : down;
              return keyName === 'bars'
                ? <g key={i} stroke={col} strokeWidth="2"><line x1={x} y1={hi} x2={x} y2={lo} /><line x1={x - 5} y1={o} x2={x} y2={o} /><line x1={x} y1={c} x2={x + 5} y2={c} /></g>
                : <g key={i}><line x1={x} y1={hi} x2={x} y2={lo} stroke={col} strokeWidth="1.5" /><rect x={x - 4} y={Math.min(o, c)} width="8" height={Math.max(2, Math.abs(o - c))} fill={col} /></g>;
            })}
      </svg>
    </div>
  );
}

type State = 'in_use' | 'owned' | 'requested' | 'available' | 'hidden';
function stateOf(r: BrandAddonRow): State {
  if (r.active && r.entitled) return 'in_use';
  if (r.entitled) return 'owned';
  if (r.pending) return 'requested';
  return r.offered ? 'available' : 'hidden';
}
const STATE_PILL: Record<State, [string, string]> = {
  in_use: ['In use', 'bg-up/15 text-up'], owned: ['Owned', 'bg-accent/15 text-accent'], requested: ['Requested', 'bg-warn/15 text-warn'],
  available: ['Available', 'bg-surface-2 text-muted'], hidden: ['Not offered', 'bg-surface-2 text-muted'],
};

type Dialog =
  | { kind: 'request'; row: BrandAddonRow }
  | { kind: 'assign'; row: BrandAddonRow }
  | { kind: 'remove'; row: BrandAddonRow }
  | null;

/**
 * The marketplace for ONE brand. `owner` = the System owner managing a brand (assign / remove / review);
 * otherwise a brand admin (its own brand, no siteId) or a platform admin (siteId of a brand in its platform).
 */
export function AddonMarketplace({ siteId, owner = false, canSetUpGateways = false }: { siteId?: string; owner?: boolean; canSetUpGateways?: boolean }) {
  const q = useAddonBrand(siteId ?? null);
  const activate = useActivateAddon();
  const cancel = useCancelAddonRequest();
  const toast = useToast();
  const [cat, setCat] = React.useState<'all' | AddonCategory>('all');
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const rows = q.data?.items ?? [];
  if (q.isLoading) return <Skeleton className="h-80 w-full" />;
  if (!rows.length) return <Empty title="No add-ons available" description="The System owner hasn't offered any add-ons yet." />;
  const siteBody = siteId ? { site: siteId } : {};
  const shown = rows.filter((r) => (cat === 'all' || r.category === cat) && (owner || stateOf(r) !== 'hidden'));
  const cats = (Object.keys(CATEGORY) as AddonCategory[]).filter((c) => rows.some((r) => r.category === c));

  const use = (r: BrandAddonRow) => activate.mutate({ ...siteBody, category: r.category, key: r.key }, {
    onSuccess: () => toast.push({ tone: 'success', title: `${r.display_name} is now in use`, description: 'Players see it on their next page load.' }),
    onError: (e) => toast.push({ tone: 'error', title: 'Not switched', description: errMsg(e) }),
  });
  const withdraw = (r: BrandAddonRow) => r.request_id && cancel.mutate(r.request_id, {
    onSuccess: () => toast.push({ tone: 'success', title: 'Request withdrawn' }),
    onError: (e) => toast.push({ tone: 'error', title: 'Not withdrawn', description: errMsg(e) }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Add-on type" className="flex w-fit flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
        {(['all', ...cats] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)}
            className={cn('h-8 rounded-lg px-3 text-sm font-medium transition', cat === c ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>
            {c === 'all' ? 'All' : CATEGORY[c].short}
          </button>
        ))}
      </div>
      {(cat === 'all' ? cats : [cat]).map((c) => {
        const list = shown.filter((r) => r.category === c);
        if (!list.length) return null;
        return (
          <section key={c} className="flex flex-col gap-3" aria-label={CATEGORY[c].title}>
            <div><h3 className="text-sm font-semibold">{CATEGORY[c].title}</h3><p className="text-xs text-muted">{CATEGORY[c].hint}</p></div>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((r) => {
                const st = stateOf(r); const [label, tone] = STATE_PILL[st];
                const price = priceText(r.billing_type, r.price_cents, r.setup_fee_cents);
                const switchable = r.category !== 'payment_gateway';
                return (
                  <li key={r.key} className={cn('flex flex-col gap-3 rounded-2xl border bg-surface p-4', st === 'in_use' ? 'border-up/50' : 'border-border')} data-addon={`${r.category}:${r.key}`}>
                    <AddonPreview category={r.category} keyName={r.key} name={r.display_name} />
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold">{r.display_name}</div>
                        <div className="text-sm"><span className={cn('font-medium', price.main === 'Free' ? 'text-up' : 'text-fg')}>{r.is_default ? 'Included free' : price.main}</span>
                          {price.extra ? <span className="text-muted"> {price.extra}</span> : null}</div>
                      </div>
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', tone)}>{label}</span>
                    </div>
                    {r.description ? <p className="text-sm text-muted">{r.description}</p> : null}
                    {st === 'requested' ? <p className="text-xs text-warn">Requested {r.requested_at ? formatDate(r.requested_at) : ''}{r.request_note ? ` — “${r.request_note}”` : ''}</p> : null}
                    <div className="mt-auto flex flex-wrap gap-2">
                      {st === 'in_use' ? (
                        owner && !r.is_default ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'remove', row: r })}>Remove…</Button>
                          : <span className="text-xs text-muted">{switchable ? 'Players see this now.' : 'Available to players.'}</span>
                      ) : st === 'owned' ? (<>
                        {switchable ? <Button size="sm" onClick={() => use(r)} disabled={activate.isPending}>Use this</Button> : null}
                        {!switchable && canSetUpGateways ? <Link href="/platform/payment-accounts" className="inline-flex h-9 items-center rounded-brand border border-border px-3 text-sm font-medium hover:bg-surface-2">Set up</Link> : null}
                        {owner && !r.is_default ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'remove', row: r })}>Remove…</Button> : null}
                      </>) : st === 'requested' ? (
                        owner ? <Link href="/platform/addons" className="inline-flex h-9 items-center rounded-brand bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90">Review request</Link>
                          : <Button size="sm" variant="outline" onClick={() => withdraw(r)} disabled={cancel.isPending}>Withdraw request</Button>
                      ) : owner ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'assign', row: r })}>Assign…</Button>
                      ) : st === 'available' ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'request', row: r })}>{r.billing_type === 'free' ? 'Request' : 'Request · ' + price.main}</Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <AddonDialog dialog={dialog} siteId={siteId} onClose={() => setDialog(null)} />
    </div>
  );
}

function AddonDialog({ dialog, siteId, onClose }: { dialog: Dialog; siteId: string | undefined; onClose: () => void }) {
  const [note, setNote] = React.useState('');
  const request = useRequestAddon();
  const grant = useGrantAddon();
  const revoke = useRevokeAddon();
  const toast = useToast();
  React.useEffect(() => { setNote(''); }, [dialog]);
  if (!dialog) return null;
  const r = dialog.row;
  const bill = billingSentence(r.billing_type, r.price_cents, r.setup_fee_cents);
  const what = r.category === 'payment_gateway' ? `Players can deposit with ${r.display_name} once it is set up in Payment accounts.`
    : `${r.display_name} becomes the ${r.category === 'chart' ? 'price chart' : 'trade screen'} players see, straight away.`;
  const busy = request.isPending || grant.isPending || revoke.isPending;
  const done = (title: string) => () => { toast.push({ tone: 'success', title }); onClose(); };
  const fail = (title: string) => (e: unknown) => toast.push({ tone: 'error', title, description: errMsg(e) });

  if (dialog.kind === 'request') {
    return (
      <Modal open onClose={onClose} size="sm" title={`Request ${r.display_name}`}
        footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || note.length > 500} onClick={() => request.mutate({ ...(siteId ? { site: siteId } : {}), category: r.category, key: r.key, ...(note.trim() ? { note: note.trim() } : {}) },
            { onSuccess: done('Request sent'), onError: fail('Request not sent') })}>Send request</Button></>}>
        <div className="flex flex-col gap-3 text-sm">
          <Price row={r} />
          <p className="text-muted">The System owner reviews requests. If approved: {what} {bill}</p>
          <NoteField value={note} onChange={setNote} label="Why do you want it?" placeholder="e.g. Our players asked for candlesticks" />
        </div>
      </Modal>
    );
  }
  if (dialog.kind === 'assign') {
    return (
      <Modal open onClose={onClose} size="sm" title={`Assign ${r.display_name}?`}
        footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !siteId} onClick={() => grant.mutate({ site: siteId!, category: r.category, key: r.key }, { onSuccess: done(`${r.display_name} assigned`), onError: fail('Not assigned') })}>Assign</Button></>}>
        <div className="flex flex-col gap-3 text-sm"><Price row={r} /><p className="text-muted">{what} {bill}</p></div>
      </Modal>
    );
  }
  if (dialog.kind === 'remove') {
    const effect = r.category === 'payment_gateway' ? `Deposits through ${r.display_name} stop for this brand.`
      : r.active ? `Players switch back to the free default ${r.category === 'chart' ? 'chart' : 'trade screen'} now.` : 'The brand loses access to it.';
    return (
      <Modal open onClose={onClose} size="sm" title={`Remove ${r.display_name}?`}
        footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="down" disabled={busy || !siteId} onClick={() => revoke.mutate({ site: siteId!, category: r.category, key: r.key }, { onSuccess: done(`${r.display_name} removed`), onError: fail('Not removed') })}>Remove</Button></>}>
        <p className="text-sm text-muted">{effect} Charges not yet invoiced are cancelled; invoiced ones stay.</p>
      </Modal>
    );
  }
  return null;
}

export function RequestSummary({ req }: { req: AddonRequestRow }) {
  const p = priceText(req.billing_type, req.price_cents, req.setup_fee_cents);
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-surface-2 p-3">
        <dt className="text-muted">Brand</dt><dd className="text-right font-medium">{req.name}{req.platform_name ? <span className="text-muted"> · {req.platform_name}</span> : null}</dd>
        <dt className="text-muted">Price quoted</dt><dd className="text-right">{p.main}{p.extra ? ` ${p.extra}` : ''}</dd>
        <dt className="text-muted">Asked by</dt><dd className="text-right">{req.requested_by_name ? `@${req.requested_by_name}` : '—'} · {formatDate(req.created_at)}</dd>
      </dl>
      {req.note ? <p className="rounded-xl border border-border p-3">“{req.note}”</p> : null}
      <p className="text-muted">If you approve: {billingSentence(req.billing_type, req.price_cents, req.setup_fee_cents)} The brand is charged the price it was quoted.</p>
    </div>
  );
}

function Price({ row }: { row: BrandAddonRow }) {
  const p = priceText(row.billing_type, row.price_cents, row.setup_fee_cents);
  return (
    <div className="flex items-center justify-between rounded-xl bg-surface-2 p-3">
      <span className="text-muted">Price</span>
      <span className="font-semibold">{p.main}{p.extra ? <span className="font-normal text-muted"> {p.extra}</span> : null}</span>
    </div>
  );
}

export function NoteField({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="font-medium">{label} <span className="text-xs font-normal text-muted">(optional)</span></span>
      <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={500}
        className="rounded-brand border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent" />
      <span className="text-right text-xs text-muted">{value.length}/500</span>
    </label>
  );
}

/** A brand's (or platform's) request history, newest first, with both sides' notes. */
export function RequestHistory({ siteId, emptyText }: { siteId?: string; emptyText: string }) {
  const q = useAddonRequests();
  const rows = (q.data?.requests ?? []).filter((r) => !siteId || r.site_id === siteId);
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (!rows.length) return <Empty title="No requests yet" description={emptyText} />;
  const PILL: Record<AddonRequestRow['status'], [string, string]> = {
    requested: ['Waiting for review', 'bg-warn/15 text-warn'], approved: ['Approved', 'bg-up/15 text-up'],
    rejected: ['Declined', 'bg-down/15 text-down'], cancelled: ['Withdrawn', 'bg-surface-2 text-muted'],
  };
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface" aria-label="Add-on requests">
      {rows.map((r) => {
        const [label, tone] = PILL[r.status];
        const p = priceText(r.billing_type, r.price_cents, r.setup_fee_cents);
        return (
          <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{r.display_name}{siteId ? '' : <span className="text-muted"> · {r.name}</span>}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>{label}</span>
            </div>
            <div className="text-xs text-muted">{p.main}{p.extra ? ` ${p.extra}` : ''} · asked {formatDate(r.created_at)}{r.requested_by_name ? ` by @${r.requested_by_name}` : ''}{r.decided_at ? ` · decided ${formatDate(r.decided_at)}` : ''}</div>
            {r.note ? <div className="text-xs text-muted">Reason: “{r.note}”</div> : null}
            {r.decision_note ? <div className="text-xs">Reply: “{r.decision_note}”</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

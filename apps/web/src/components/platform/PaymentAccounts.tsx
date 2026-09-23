'use client';

/**
 * PAY-1 (docs/43) — "whose accounts does this money flow through?"
 *
 * UX / psychology (deliberate):
 *  - One question up top, answered in plain words per brand ("Players of X pay into: …") — the mental model
 *    is ownership of money, not config rows (reduces mode errors about which account is live).
 *  - Configs are DRAFTS until an explicit Go-live; the go-live dialog states the blast radius (which brands,
 *    which paybill receives deposits, which shortcode pays withdrawals) and that the System owner is told.
 *  - Readiness is shown as checkable facts (Deposits ✓ / Payouts ✗ + what is missing), so the operator can see
 *    why Go-live is refused before trying (error prevention > error messages).
 *  - Secrets are write-only: "saved •••• 1234 — leave blank to keep" (no fear of wiping a key by saving).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { useCan } from '@/lib/auth/can';
import { OwnerPlatformPicker, DEFAULT_PLATFORM_ID } from '@/components/platform/OwnerPlatformPicker';
import {
  usePaymentScopes, usePaymentScope, useSaveScopedGateway, useRemoveScopedGateway, useTestScopedGateway,
  useActivateScope, useDeactivateScope, type ScopeStateDto, type ScopeType, type ScopedConfigDto, type GatewayStatusDto,
} from '@/lib/payments/scopes';
import type { GatewaySchemaDto, ConnResultDto } from '@/lib/platform/endpoints';
import { gatewayCopy } from '@/lib/payments/gatewayCopy';

const RAILS = ['mpesa', 'megapay', 'payhero'];
// Readiness keys from the engine (paymentscopes.ts gatewayStatus) in plain words.
const MISSING_LABEL: Record<string, string> = {
  shortcode: 'business shortcode', consumerKey: 'consumer key', consumerSecret: 'consumer secret', passkey: 'passkey',
  b2cInitiator: 'payout initiator name', b2cSecurityCredential: 'payout security credential',
};

function Chip({ tone, children }: { tone: 'up' | 'warn' | 'muted' | 'down'; children: React.ReactNode }) {
  const cls = { up: 'bg-up/15 text-up', warn: 'bg-warn/15 text-warn', muted: 'bg-surface-2 text-muted', down: 'bg-down/15 text-down' }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function stateChip(s: ScopeStateDto | null | undefined) {
  if (!s || !s.active) return <Chip tone="muted">System accounts</Chip>;
  return s.payoutsEnabled ? <Chip tone="up">Own accounts · live</Chip> : <Chip tone="warn">Own accounts · deposits only</Chip>;
}

export function PaymentAccounts({ initialScope }: { initialScope?: { type: ScopeType; id: string } | undefined }) {
  const isSystem = useCan('console.system');
  const [platformId, setPlatformId] = useState(DEFAULT_PLATFORM_ID);
  const list = usePaymentScopes(isSystem ? platformId : undefined);
  const scopes = useMemo(() => list.data?.scopes ?? [], [list.data]);
  const platform = scopes.find((s) => s.scopeType === 'platform');
  const [sel, setSel] = useState<{ type: ScopeType; id: string } | null>(initialScope ?? null);
  useEffect(() => { if (!sel && platform) setSel({ type: 'platform', id: platform.scopeId }); }, [sel, platform]);

  /** Who a brand pays into right now (site active > platform active > System). */
  const ownerOf = (s: ScopeStateDto): string =>
    s.scopeType === 'site' && s.active ? `${s.name}'s own accounts` : platform?.active ? `${platform.name}'s accounts` : 'the System accounts';

  return (
    <div className="flex flex-col gap-5">
      <OwnerPlatformPicker value={platformId} onChange={(v) => { setPlatformId(v); setSel(null); }} label="Payment accounts for platform" />
      {list.isLoading ? <p className="text-sm text-muted">Loading…</p> : list.isError ? (
        <p className="text-sm text-down">{list.error instanceof ApiError ? list.error.message : 'Could not load payment accounts.'}</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
          <nav aria-label="Scopes" className="flex flex-col gap-2">
            {scopes.map((s) => {
              const on = sel?.type === s.scopeType && sel.id === s.scopeId;
              return (
                <button key={`${s.scopeType}:${s.scopeId}`} type="button" onClick={() => setSel({ type: s.scopeType, id: s.scopeId })}
                  aria-current={on ? 'true' : undefined}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${on ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:bg-surface-2'}`}>
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-fg">{s.scopeType === 'platform' ? `Whole platform · ${s.name}` : s.name}</span>
                    {stateChip(s)}
                  </span>
                  {s.scopeType === 'site' ? <span className="text-xs text-muted">Players pay into {ownerOf(s)}</span>
                    : <span className="text-xs text-muted">Default for every brand of this platform</span>}
                </button>
              );
            })}
          </nav>
          {sel ? <ScopePanel key={`${sel.type}:${sel.id}`} type={sel.type} id={sel.id} brands={scopes.filter((s) => s.scopeType === 'site')} /> : null}
        </div>
      )}
    </div>
  );
}

function ScopePanel({ type, id, brands }: { type: ScopeType; id: string; brands: ScopeStateDto[] }) {
  const q = usePaymentScope(type, id);
  const d = q.data;
  const [open, setOpen] = useState<string | null>('mpesa');
  if (q.isLoading) return <p className="text-sm text-muted">Loading accounts…</p>;
  if (!d) return <p className="text-sm text-down">{q.error instanceof ApiError ? q.error.message : 'Could not load this scope.'}</p>;
  const name = d.state?.name ?? (type === 'platform' ? 'this platform' : 'this brand');
  const affected = type === 'platform' ? brands.filter((b) => !b.active).map((b) => b.name) : [name];

  return (
    <section className="flex flex-col gap-4" aria-label={`Payment accounts of ${name}`}>
      <GoLive type={type} id={id} name={name} state={d.state} status={d.status} affected={affected} configs={d.configs} />
      {d.liveRails ? (
        <p className="text-xs text-muted">Deposit methods players of {name} see right now: <b className="text-fg">{d.liveRails.length ? d.liveRails.join(', ') : 'none'}</b>.</p>
      ) : null}
      <div className="flex flex-col gap-2">
        {Object.entries(d.schemas).map(([code, schema]) => (
          <GatewayCard key={code} type={type} id={id} code={code} schema={schema} config={d.configs[code]!} status={d.status[code]!}
            open={open === code} onToggle={() => setOpen(open === code ? null : code)} />
        ))}
      </div>
    </section>
  );
}

function GoLive({ type, id, name, state, status, affected, configs }: {
  type: ScopeType; id: string; name: string; state: ScopeStateDto | null; status: Record<string, GatewayStatusDto>;
  affected: string[]; configs: Record<string, ScopedConfigDto>;
}) {
  const toast = useToast();
  const activate = useActivateScope();
  const deactivate = useDeactivateScope();
  const [confirm, setConfirm] = useState<'on' | 'off' | null>(null);
  const [depositsOnly, setDepositsOnly] = useState(false);
  const ready = RAILS.filter((c) => status[c]?.depositsReady);
  const payouts = !!status.mpesa?.payoutsReady;
  const canGo = ready.length > 0 && (payouts || depositsOnly);
  const shortcode = configs.mpesa?.settings.shortcode;
  const b2c = configs.mpesa?.settings.b2c_shortcode || shortcode;
  const fail = (e: unknown) => toast.push({ tone: 'error', title: 'Not changed', description: e instanceof ApiError ? e.message : String(e) });

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 className="text-base font-semibold text-fg">{name}</h2>
          <p className="text-sm text-muted">
            {state?.active ? <>Money flows through <b className="text-fg">its own accounts</b>{state.payoutsEnabled ? '' : ' (withdrawals disabled)'}.</>
              : <>Money flows through the <b className="text-fg">System accounts</b>. Accounts saved below are drafts until you go live.</>}
          </p>
        </div>
        {state?.active
          ? <Button variant="outline" onClick={() => setConfirm('off')}>Switch back to System accounts</Button>
          : <Button onClick={() => setConfirm('on')} disabled={ready.length === 0} title={ready.length === 0 ? 'Set up at least one deposit account below first' : undefined}>Go live on these accounts…</Button>}
      </div>
      {/* UI-D: what going live needs, as a checklist (was two chips) */}
      <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2" aria-label="Ready to go live">
        <li className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${ready.length ? 'bg-up text-white' : 'border border-border text-muted'}`}>{ready.length ? '✓' : '1'}</span>
          <span><span className="font-medium">Deposits</span><br /><span className="text-xs text-muted">{ready.length ? `Ready: ${ready.map((c) => (c === 'mpesa' ? 'M-Pesa' : c)).join(', ')}` : 'Set up M-Pesa (or another deposit gateway) below'}</span></span>
        </li>
        <li className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${payouts ? 'bg-up text-white' : 'border border-warn text-warn'}`}>{payouts ? '✓' : '2'}</span>
          <span><span className="font-medium">Withdrawals</span><br /><span className="text-xs text-muted">{payouts ? `Paid from shortcode ${b2c ?? '—'}` : 'Add M-Pesa payout details (initiator + security credential), or go live for deposits only'}</span></span>
        </li>
      </ul>

      <Modal open={confirm === 'on'} onClose={() => setConfirm(null)} title={`Go live: ${name}`} chrome
        footer={<>
          <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button disabled={!canGo || activate.isPending} onClick={() => activate.mutate({ type, id, payoutsEnabled: !depositsOnly }, {
            onSuccess: () => { toast.push({ tone: 'success', title: `${name} is live on its own accounts` }); setConfirm(null); }, onError: fail })}>
            {activate.isPending ? 'Switching…' : 'Go live'}
          </Button>
        </>}>
        <div className="flex flex-col gap-3 text-sm">
          <p>From the next transaction, for <b>{affected.length ? affected.join(', ') : name}</b>:</p>
          <ul className="list-disc pl-5 text-sm">
            <li>Deposits go to <b>your</b> accounts ({ready.join(', ')}{shortcode ? ` · paybill/till ${shortcode}` : ''}) — not the System&apos;s.</li>
            <li>{payouts && !depositsOnly ? <>Withdrawals are paid from <b>your</b> B2C shortcode {b2c}.</> : <>Withdrawals are <b>disabled</b> until your B2C payout account is set up.</>}</li>
            <li>Gateways you have not set up are no longer offered to these players. The manual System Pay Bill is hidden.</li>
            <li>The System owner is notified. You can switch back at any time.</li>
          </ul>
          {!payouts ? (
            <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 p-2 text-xs">
              <input type="checkbox" checked={depositsOnly} onChange={(e) => setDepositsOnly(e.target.checked)} />
              <span>I understand withdrawals will be <b>disabled</b> for these players until a B2C payout account is added.</span>
            </label>
          ) : null}
        </div>
      </Modal>
      <Modal open={confirm === 'off'} onClose={() => setConfirm(null)} title={`Switch ${name} back to System accounts?`} chrome
        footer={<>
          <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="down" disabled={deactivate.isPending} onClick={() => deactivate.mutate({ type, id }, {
            onSuccess: () => { toast.push({ tone: 'success', title: `${name} is back on the System accounts` }); setConfirm(null); }, onError: fail })}>Switch back</Button>
        </>}>
        <p className="text-sm">New deposits and withdrawals will use the System accounts again. Deposits already in flight are still verified on the account they were made on. The System owner is notified.</p>
      </Modal>
    </div>
  );
}

function GatewayCard({ type, id, code, schema, config, status, open, onToggle }: {
  type: ScopeType; id: string; code: string; schema: GatewaySchemaDto; config: ScopedConfigDto; status: GatewayStatusDto; open: boolean; onToggle: () => void;
}) {
  const toast = useToast();
  const save = useSaveScopedGateway();
  const remove = useRemoveScopedGateway();
  const test = useTestScopedGateway();
  const initial = useMemo(() => Object.fromEntries(schema.fields.map((f) => [f.key, f.secret ? '' : (config.settings[f.key] ?? f.default ?? '')])), [schema, config]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  useEffect(() => setValues(initial), [initial]);
  const [result, setResult] = useState<ConnResultDto | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, typeof schema.fields>();
    for (const f of schema.fields) { const g = f.group ?? 'Account'; m.set(g, [...(m.get(g) ?? []), f]); }
    return [...m.entries()];
  }, [schema]);
  const fail = (e: unknown) => toast.push({ tone: 'error', title: 'Not saved', description: e instanceof ApiError ? e.message : String(e) });
  const statusChip = !status.configured ? <Chip tone="muted">Not set up</Chip>
    : status.depositsReady || status.payoutsReady ? <Chip tone="up">{[status.depositsReady && 'Deposits', status.payoutsReady && 'Payouts'].filter(Boolean).join(' + ')} ready</Chip>
    : <Chip tone="warn">Incomplete</Chip>;

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <span className="flex min-w-0 flex-col"><span className="text-sm font-semibold text-fg">{schema.displayName}</span><span className="text-xs text-muted">{gatewayCopy(code, schema.blurb, schema.playerAvailable).summary}</span></span>
        <span className="flex shrink-0 items-center gap-2">{statusChip}<span aria-hidden className={`text-muted transition ${open ? 'rotate-90' : ''}`}>›</span></span>
      </button>
      {open ? (
        <form className="flex flex-col gap-4 border-t border-border p-4" onSubmit={(e) => {
          e.preventDefault(); setResult(null);
          save.mutate({ type, id, code, values }, { onSuccess: () => toast.push({ tone: 'success', title: `${schema.displayName} saved`, description: 'Saved as part of this scope. It is live only while the scope is live.' }), onError: fail });
        }}>
          {status.configured && status.missing.length ? <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">Still needed: {status.missing.map((k) => MISSING_LABEL[k] ?? k).join(', ')}</p> : null}
          {groups.map(([g, fields]) => (
            <fieldset key={g} className="flex flex-col gap-3">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {fields.map((f) => {
                  const meta = config.secretMeta[f.key];
                  const label = f.secret && meta?.set ? `${f.label} (saved •••• ${meta.last4} — leave blank to keep)` : f.label;
                  return (
                    <label key={f.key} className="flex flex-col gap-1.5 text-sm">
                      <span className="font-medium text-fg">{label}{f.required ? '' : <span className="font-normal text-muted"> (optional)</span>}</span>
                      {f.kind === 'select' && f.options && f.options.length === 1 ? (
                        <span className="flex h-11 items-center rounded-brand border border-border bg-surface px-3 text-sm text-muted">{f.options[0]!.label}</span>
                      ) : f.kind === 'select' && f.options ? (
                        <select aria-label={f.label} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg">
                          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input aria-label={f.label} type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.key] ?? ''} placeholder={f.placeholder}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg" />
                      )}
                      {f.help ? <span className="text-xs text-muted">{f.help}</span> : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="secondary" disabled={test.isPending} onClick={() => test.mutate({ type, id, code, values }, { onSuccess: (r) => setResult(r.result), onError: fail })}>
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            {config.exists ? <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ type, id, code }, { onSuccess: () => toast.push({ tone: 'success', title: `${schema.displayName} removed` }), onError: fail })}>Remove</Button> : null}
            {result ? <span className={`text-sm ${result.ok ? 'text-up' : 'text-down'}`}>{result.ok ? '✓ ' : '✕ '}{result.detail}</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

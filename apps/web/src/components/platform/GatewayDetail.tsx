'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useGatewayConfigs, useSaveGatewayConfig, useTestGatewayConfig,
  usePaymentProviders, useSetProviderGlobal, useSetProviderSite, usePlatformSites,
} from '@/lib/platform/hooks';
import type { GatewayFieldDto, ConnResultDto } from '@/lib/platform/endpoints';
import { GatewayLogo } from '@/components/platform/GatewayLogo';
import { gatewayCopy } from '@/lib/payments/gatewayCopy';
import { formatDateTime } from '@/lib/format';
import { useAddonBrands } from '@/lib/addons/hooks';

const STATUS_STYLES: Record<ConnResultDto['status'], string> = {
  valid: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  invalid: 'bg-red-500/15 text-red-500 border-red-500/30',
  unreachable: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  not_configured: 'bg-border/40 text-muted border-border',
};
const STATUS_LABEL: Record<ConnResultDto['status'], string> = {
  valid: 'Connected', invalid: 'Rejected by the gateway', unreachable: 'Could not reach the gateway', not_configured: 'Details missing',
};

/** Dedicated configuration page for ONE payment gateway: availability + credentials + safe test. */
export function GatewayDetail({ code }: { code: string }) {
  const { data, isLoading } = useGatewayConfigs();
  const entry = data?.providers.find((p) => p.code === code);

  if (isLoading) return <p className="text-sm text-muted">Loading {code} configuration…</p>;
  if (!entry) {
    return (
      <div className="rounded-2xl border border-border bg-surface-2 p-6">
        <p className="text-sm text-fg">Unknown gateway “{code}”.</p>
        <Link href="/platform/payments" className="mt-2 inline-block text-sm text-accent hover:underline">← Back to Gateways</Link>
      </div>
    );
  }
  return <Detail code={code} schema={entry.schema} config={entry.config} />;
}

function Detail({ code, schema, config }: { code: string; schema: import('@/lib/platform/endpoints').GatewaySchemaDto; config: import('@/lib/platform/endpoints').GatewayConfigDto }) {
  const save = useSaveGatewayConfig();
  const test = useTestGatewayConfig();
  const { data: providers } = usePaymentProviders();
  const { data: sitesData } = usePlatformSites();
  const setGlobal = useSetProviderGlobal();
  const setSite = useSetProviderSite();
  // UI-F: a brand can only offer a gateway it has as an add-on (M-Pesa is always included). Brands
  // without it link to their Add-ons tab instead of showing a switch that would do nothing.
  const addonBrands = useAddonBrands();
  const ownsGateway = (siteId: string): boolean | null => {
    if (code === 'mpesa') return true;
    const b = addonBrands.data?.brands.find((x) => x.site_id === siteId);
    return b ? b.owned.includes(`payment_gateway:${code}`) : null;
  };

  const provider = providers?.providers.find((p) => p.code === code);
  const sites = sitesData?.sites ?? [];
  const overrideMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const o of providers?.overrides ?? []) if (o.providerCode === code) m.set(o.siteId, o.enabled);
    return m;
  }, [providers, code]);

  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of schema.fields) v[f.key] = f.secret ? '' : (config.settings[f.key] ?? f.default ?? '');
    return v;
  }, [schema, config]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<ConnResultDto | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = (k: string, val: string) => { setValues((s) => ({ ...s, [k]: val })); setSaved(false); setResult(null); setErrors((e) => ({ ...e, [k]: '' })); };

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; const urlRe = /^https?:\/\/[^\s]+$/;
    for (const f of schema.fields) {
      const raw = (values[f.key] ?? '').trim();
      const onFile = f.secret && config.secretMeta[f.key]?.set;
      if (f.required && !raw && !onFile) { errs[f.key] = `${f.label} is required`; continue; }
      if (!raw) continue;
      if (f.kind === 'email' && !emailRe.test(raw)) errs[f.key] = `${f.label} must be a valid email`;
      if (f.kind === 'url' && !urlRe.test(raw)) errs[f.key] = `${f.label} must be a valid https URL`;
      if (f.kind === 'select' && f.options && !f.options.some((o) => o.value === raw)) errs[f.key] = `${f.label} is invalid`;
      if (f.pattern && !new RegExp(f.pattern).test(raw)) errs[f.key] = `${f.label} has an unexpected format`;
    }
    return errs;
  }
  function payload(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of schema.fields) {
      const raw = values[f.key] ?? '';
      if (f.secret) { if (raw.trim() !== '') out[f.key] = raw.trim(); } else out[f.key] = raw.trim();
    }
    return out;
  }
  async function onSave() {
    setServerError(null); setResult(null);
    const errs = validate(); setErrors(errs);
    if (Object.keys(errs).some((k) => errs[k])) return;
    try { await save.mutateAsync({ code, values: payload() }); setSaved(true); }
    catch (e) { setServerError((e as Error).message || 'Save failed'); }
  }
  async function onTest() {
    setServerError(null); setSaved(false);
    try { const r = await test.mutateAsync({ code, draft: payload() }); setResult(r.result); }
    catch (e) { setServerError((e as Error).message || 'Test failed'); }
  }

  const configuredCount = Object.values(config.secretMeta).filter((m) => m?.set).length;
  const enabled = provider?.enabledGlobal ?? false;
  const copy = gatewayCopy(code, schema.blurb, schema.playerAvailable);
  const stateOf = (sid: string): 'inherit' | 'on' | 'off' => (!overrideMap.has(sid) ? 'inherit' : overrideMap.get(sid) ? 'on' : 'off');
  const pill = !schema.playerAvailable ? { label: 'Coming soon', cls: 'bg-info/15 text-info' }
    : !config.hasSecret ? { label: 'Not set up', cls: 'bg-surface-2 text-muted' }
      : enabled ? { label: 'Live for players', cls: 'bg-up/15 text-up' } : { label: 'Ready · not offered', cls: 'bg-warn/15 text-warn' };
  // Setup checklist (Stripe onboarding pattern): what is done, what is next.
  const steps: Array<{ done: boolean; label: string }> = [
    { done: config.hasSecret, label: 'Credentials saved' },
    { done: result?.status === 'valid', label: 'Connection tested' },
    ...(schema.playerAvailable ? [{ done: enabled || overrideMap.size > 0, label: 'Offered to players' }] : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb + header */}
      <div className="flex flex-col gap-2">
        <Link href="/platform/payments" className="text-xs text-muted hover:text-fg">← Gateways</Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <GatewayLogo code={code} name={schema.displayName} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-fg md:text-2xl">{schema.displayName}</h1>
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${pill.cls}`}>{pill.label}</span>
              </div>
              <p className="mt-0.5 text-sm text-muted">{copy.summary}</p>
            </div>
          </div>
          <a href={schema.docsUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-brand border border-border px-3 text-sm font-medium text-fg hover:bg-surface-2">{schema.displayName} docs ↗</a>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Credentials & settings (spans 2 cols on desktop) */}
        <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface-2 p-5 lg:col-span-2">
          <div>
            <h2 className="text-base font-semibold text-fg">Account details</h2>
            <p className="mt-1 text-sm text-muted">Keys are encrypted and never shown again. Leave a key blank to keep the saved one.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {schema.fields.map((f) => (
              <Field key={f.key} field={f} value={values[f.key] ?? ''} error={errors[f.key]}
                storedHint={f.secret ? config.secretMeta[f.key] : undefined} onChange={(v) => set(f.key, v)} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onSave} disabled={save.isPending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={onTest} disabled={test.isPending}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition hover:bg-surface disabled:opacity-50">
              {test.isPending ? 'Testing…' : 'Test connection'}
            </button>
            {saved && <span className="text-xs font-medium text-up">✓ Saved</span>}
          </div>
          {result && (
            <div className={['flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', STATUS_STYLES[result.status]].join(' ')}>
              <span className="font-semibold">{STATUS_LABEL[result.status]}:</span><span className="min-w-0">{result.detail}</span>
            </div>
          )}
          {serverError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{serverError}</div>}
        </section>

        {/* Setup + availability (side column) */}
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5" aria-label="Setup">
            <h2 className="text-base font-semibold text-fg">Setup</h2>
            <ol className="flex flex-col gap-2 text-sm">
              {steps.map((st, i) => (
                <li key={st.label} className="flex items-center gap-2">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${st.done ? 'bg-up text-white' : 'border border-border text-muted'}`}>{st.done ? '✓' : i + 1}</span>
                  <span className={st.done ? 'text-fg' : 'text-muted'}>{st.label}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted">{configuredCount} key{configuredCount === 1 ? '' : 's'} saved · last changed {config.updatedAt ? formatDateTime(config.updatedAt) : 'never'}</p>
          </section>

          <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5">
            <h2 className="text-base font-semibold text-fg">Offered to players</h2>
            {schema.playerAvailable ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">Every brand on the System accounts</div>
                    <div className="text-xs text-muted">{enabled ? 'Shown on the deposit screen' : 'Not shown'}{!config.hasSecret && !enabled ? ' · save the account details first' : ''}</div>
                  </div>
                  <ToggleSwitch checked={enabled} disabled={setGlobal.isPending || (!enabled && !config.hasSecret)} onChange={(next) => setGlobal.mutate({ code, enabled: next })} label={`Offer ${schema.displayName} to every brand`} />
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-medium text-fg">Per brand</div>
                  <p className="text-xs text-muted">“Default” follows the switch above; On or Off overrides it for that brand only. A brand needs this gateway as an add-on before it can be offered.</p>
                  <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border" aria-label="Per-brand availability">
                    {sites.filter((s2) => s2.status === 'active').map((s2) => {
                      const st = stateOf(s2.siteId);
                      return (
                        <li key={s2.siteId} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0 truncate text-sm">{s2.name}</span>
                          {ownsGateway(s2.siteId) === false ? (
                            <Link href={`/platform/clients/${s2.siteId}?tab=addons`} className="shrink-0 text-xs text-muted hover:text-accent hover:underline" title="This brand does not have this gateway as an add-on yet">
                              Not added · Add-ons
                            </Link>
                          ) : (
                          <div className="flex shrink-0 rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label={`${schema.displayName} for ${s2.name}`}>
                            {(['inherit', 'on', 'off'] as const).map((opt) => (
                              <button key={opt} type="button" role="radio" aria-checked={st === opt} disabled={setSite.isPending}
                                onClick={() => setSite.mutate({ code, siteId: s2.siteId, enabled: opt === 'inherit' ? null : opt === 'on' })}
                                className={['rounded-md px-2 py-0.5 text-xs font-medium transition', st === opt ? 'bg-surface-2 text-fg ring-1 ring-border' : 'text-muted hover:text-fg'].join(' ')}>
                                {opt === 'inherit' ? 'Default' : opt === 'on' ? 'On' : 'Off'}
                              </button>
                            ))}
                          </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-info/30 bg-info/5 p-4">
                <div className="text-sm font-medium text-info">Coming soon for players</div>
                <p className="mt-1 text-xs text-muted">
                  Players can’t pay with {schema.displayName} in the app yet. Save and test the account now — it can be offered as soon as it is switched on in the app.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (n: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={['relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50', checked ? 'bg-accent' : 'bg-border'].join(' ')}>
      <span className={['inline-block h-5 w-5 transform rounded-full bg-white transition', checked ? 'translate-x-5' : 'translate-x-0.5'].join(' ')} />
    </button>
  );
}

function Field({ field, value, error, storedHint, onChange }: {
  field: GatewayFieldDto; value: string; error?: string | undefined;
  storedHint?: { set: boolean; last4: string } | undefined; onChange: (v: string) => void;
}) {
  const base = 'rounded-lg border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent ' + (error ? 'border-red-500/60' : 'border-border');
  const secretSet = field.secret && storedHint?.set;
  const placeholder = secretSet ? `•••••••• ${storedHint?.last4 ?? ''} (leave blank to keep)` : (field.placeholder ?? '');
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span className="flex items-center gap-1">
        {field.label}{field.required && <span className="text-red-500">*</span>}
        {field.secret && <span className="rounded bg-border/50 px-1 text-[10px] uppercase tracking-wide text-muted">secret</span>}
      </span>
      {field.kind === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'}
          value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={base} />
      )}
      {error ? <span className="text-[11px] text-red-500">{error}</span> : field.help ? <span className="text-[11px] text-muted">{field.help}</span> : null}
    </label>
  );
}

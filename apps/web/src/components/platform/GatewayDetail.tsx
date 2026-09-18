'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useGatewayConfigs, useSaveGatewayConfig, useTestGatewayConfig,
  usePaymentProviders, useSetProviderGlobal, useSetProviderSite, usePlatformSites,
} from '@/lib/platform/hooks';
import type { GatewayFieldDto, ConnResultDto } from '@/lib/platform/endpoints';
import { GatewayLogo } from '@/components/platform/GatewayLogo';

const STATUS_STYLES: Record<ConnResultDto['status'], string> = {
  valid: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  invalid: 'bg-red-500/15 text-red-500 border-red-500/30',
  unreachable: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  not_configured: 'bg-border/40 text-muted border-border',
};
const STATUS_LABEL: Record<ConnResultDto['status'], string> = {
  valid: 'Connection valid', invalid: 'Rejected', unreachable: 'Unreachable', not_configured: 'Incomplete',
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
        <Link href="/platform/payments" className="mt-2 inline-block text-sm text-accent hover:underline">← Back to Payments</Link>
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

  const provider = providers?.providers.find((p) => p.code === code);
  const sites = sitesData?.sites ?? [];
  const [siteId, setSiteId] = useState('');
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
  const overrideState: 'inherit' | 'on' | 'off' = !siteId ? 'inherit' : !overrideMap.has(siteId) ? 'inherit' : overrideMap.get(siteId) ? 'on' : 'off';

  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb + header */}
      <div className="flex flex-col gap-2">
        <Link href="/platform/payments" className="text-xs text-muted hover:text-fg">← Payments</Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <GatewayLogo code={code} name={schema.displayName} size="lg" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-fg">{schema.displayName}</h1>
              <p className="text-xs text-muted">{schema.blurb}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {schema.playerAvailable ? (
              <span className={['rounded-full border px-2.5 py-1 text-xs font-medium', enabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-border bg-border/30 text-muted'].join(' ')}>
                {enabled ? 'Live for players' : 'Hidden'}
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-500">Config only</span>
            )}
            <span className={['rounded-full border px-2.5 py-1 text-xs font-medium', config.exists ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-muted'].join(' ')}>
              {config.hasSecret ? 'Configured' : config.exists ? 'Settings only' : 'Not configured'}
            </span>
            <a href={schema.docsUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-2">Docs ↗</a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Credentials & settings (spans 2 cols on desktop) */}
        <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface-2 p-5 lg:col-span-2">
          <div>
            <h2 className="text-base font-semibold text-fg">Credentials &amp; settings</h2>
            <p className="mt-1 text-sm text-muted">Secrets are encrypted with AES-256-GCM before storage. Leave a secret blank to keep the current value.</p>
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
              {save.isPending ? 'Saving…' : 'Save configuration'}
            </button>
            <button type="button" onClick={onTest} disabled={test.isPending}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition hover:bg-surface disabled:opacity-50">
              {test.isPending ? 'Testing…' : 'Test connection'}
            </button>
            {saved && <span className="text-xs font-medium text-emerald-500">✓ Saved &amp; encrypted</span>}
          </div>
          {result && (
            <div className={['flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', STATUS_STYLES[result.status]].join(' ')}>
              <span className="font-semibold">{STATUS_LABEL[result.status]}:</span><span className="min-w-0">{result.detail}</span>
            </div>
          )}
          {serverError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{serverError}</div>}
        </section>

        {/* Availability + meta (side column) */}
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5">
            <h2 className="text-base font-semibold text-fg">Availability</h2>
            {schema.playerAvailable ? (
              <>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-fg">Show to all clients</div>
                <div className="text-xs text-muted">{enabled ? 'Visible on the deposit page (unless overridden)' : 'Hidden everywhere (unless overridden)'}</div>
              </div>
              <ToggleSwitch checked={enabled} disabled={setGlobal.isPending} onChange={(next) => setGlobal.mutate({ code, enabled: next })} label={`Toggle ${schema.displayName}`} />
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
              <div className="text-sm font-medium text-fg">Per-client override</div>
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                <option value="">Select a client…</option>
                {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.name} ({s.slug})</option>)}
              </select>
              {siteId && (
                <div className="flex rounded-lg border border-border bg-surface p-0.5" role="group">
                  {(['inherit', 'on', 'off'] as const).map((opt) => (
                    <button key={opt} type="button" disabled={setSite.isPending}
                      onClick={() => setSite.mutate({ code, siteId, enabled: opt === 'inherit' ? null : opt === 'on' })}
                      className={['flex-1 rounded-md px-3 py-1 text-xs font-semibold capitalize transition',
                        overrideState === opt ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'].join(' ')}>
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted">“Inherit” follows the global switch; On/Off forces it for this client only.</p>
            </div>
              </>
            ) : (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <div className="text-sm font-medium text-amber-500">Player deposits not available yet</div>
                <p className="mt-1 text-xs text-muted">
                  {schema.displayName} has no live deposit rail in the app yet, so it can’t be switched “Live for players”.
                  Store &amp; test its credentials here now — it will be offered to players automatically once its rail ships.
                </p>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-2 p-5 text-xs text-muted">
            <h2 className="text-base font-semibold text-fg">Status</h2>
            <div className="flex justify-between"><span>Secrets on file</span><span className="text-fg">{configuredCount}</span></div>
            <div className="flex justify-between"><span>Last updated</span><span className="text-fg">{config.updatedAt ? new Date(config.updatedAt).toLocaleString() : '—'}</span></div>
            <div className="flex justify-between"><span>Encryption</span><span className="text-fg">AES-256-GCM</span></div>
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

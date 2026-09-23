'use client';

import * as React from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Empty, ConfirmButton } from '@/components/admin/ui';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { formatAgo, formatDateTime } from '@/lib/format';
import { env as appEnv } from '@/lib/env';
import { useC2bConfig, useUpdateC2bConfig, useRegisterC2b } from '@/lib/admin/hooks';
import type { C2bConfigPatch, C2bConfigRow } from '@/lib/admin/types';

/** Our own C2B endpoints for this deployment (app.payments.ts: /deposits/c2b/{confirmation,validation}). */
export function defaultC2bUrls(apiBaseUrl: string): { confirmationUrl: string; validationUrl: string } {
  const base = (apiBaseUrl || '').replace(/\/+$/, '');
  return { confirmationUrl: `${base}/deposits/c2b/confirmation`, validationUrl: `${base}/deposits/c2b/validation` };
}
/** Daraja rejects C2B URLs that are not https or that contain these words. Mirrors fn_c2b_url_ok (0163). */
export function c2bUrlProblem(url: string): string | null {
  if (!url) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?(\/[^ ]*)?$/i.test(url)) return 'Must be a public https:// link.';
  const bad = /(m-?pesa|safaricom|exec|\.exe|cmd|sql|query)/i.exec(url);
  return bad ? `Safaricom rejects URLs containing “${bad[0]}”.` : null;
}

type Form = Required<C2bConfigPatch>;
const toForm = (c: C2bConfigRow, d: ReturnType<typeof defaultC2bUrls>): Form => ({
  enabled: c.enabled, shortcode: c.shortcode, accountNumber: c.accountNumber, businessName: c.businessName, instructions: c.instructions,
  confirmationUrl: c.confirmationUrl || d.confirmationUrl, validationUrl: c.validationUrl || d.validationUrl, responseType: c.responseType,
});

/**
 * PAY-2 (docs/45): the Pay Bill players pay into from the M-PESA menu, and the C2B link with Safaricom.
 * Three questions an owner asks, top to bottom: is Safaricom sending us payments (status), what do players
 * see (Pay Bill details), and where does Safaricom send them (URLs + Register).
 */
export function C2bPanel({ canEdit }: { canEdit: boolean }) {
  const q = useC2bConfig();
  const update = useUpdateC2bConfig();
  const register = useRegisterC2b();
  const toast = useToast();
  const defaults = React.useMemo(() => defaultC2bUrls(appEnv.apiBaseUrl), []);
  const [form, setForm] = React.useState<Form | null>(null);
  React.useEffect(() => { if (q.data) setForm(toForm(q.data, defaults)); }, [q.data, defaults]);

  if (q.isLoading || (!form && !q.isError)) return <Skeleton className="h-72 w-full" />;
  if (q.isError || !q.data || !form) return <Empty title="Couldn't load the Pay Bill settings" description="Reload the page to try again." />;
  const c = q.data;

  const patch: C2bConfigPatch = {};
  (Object.keys(form) as Array<keyof Form>).forEach((k) => {
    if (form[k] !== c[k]) (patch as Record<string, unknown>)[k] = form[k];
  });
  // Our own endpoints pre-filled into empty fields are suggestions, not the owner's edits (audit C68:
  // "Save 3 changes" before touching anything read as a bug).
  const suggested = (['confirmationUrl', 'validationUrl'] as const).filter((k) => !c[k] && form[k] === defaults[k]);
  const dirty = Object.keys(patch).filter((k) => !(suggested as readonly string[]).includes(k)).length;
  const pending = Object.keys(patch).length;
  const urlErr = { confirmationUrl: c2bUrlProblem(form.confirmationUrl), validationUrl: c2bUrlProblem(form.validationUrl) };
  const shortErr = form.shortcode && !/^[0-9]{5,7}$/.test(form.shortcode) ? 'Use the 5–7 digit number from Safaricom.' : undefined;
  const invalid = !!(urlErr.confirmationUrl || urlErr.validationUrl || shortErr);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  function save() {
    update.mutate(patch, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Pay Bill settings saved' }),
      onError: (e) => toast.push({ tone: 'error', title: 'Not saved', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }
  function doRegister() {
    register.mutate(undefined, {
      onSuccess: (r) => toast.push({ tone: r.ok ? 'success' : 'error', title: r.ok ? 'Registered with Safaricom' : 'Safaricom refused the registration', description: r.message }),
      onError: (e) => toast.push({ tone: 'error', title: 'Could not register', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  const status = !c.shortcode
    ? { tone: 'muted', label: 'Not set up', text: 'Add the Pay Bill number players pay into, then register it with Safaricom.' }
    : c.registrationCurrent
      ? { tone: 'up', label: 'Registered', text: `Safaricom sends payments to ${c.registeredShortcode} here since ${c.registeredAtMs ? formatDateTime(c.registeredAtMs) : '—'}.` }
      : c.registeredAtMs
        ? { tone: 'warn', label: 'Re-register', text: 'The Pay Bill number or confirmation URL changed since the last registration. Register again so Safaricom uses the new one.' }
        : { tone: 'warn', label: 'Not registered', text: 'Safaricom has not been told where to send payments. Until you register, players’ Pay Bill payments cannot be verified.' };
  const toneCls = status.tone === 'up' ? 'border-up/40 bg-up/5' : status.tone === 'warn' ? 'border-warn/50 bg-warn/10' : 'border-border bg-surface';
  const dot = status.tone === 'up' ? 'bg-up' : status.tone === 'warn' ? 'bg-warn' : 'bg-muted';

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Status */}
      <div className={`flex flex-wrap items-start justify-between gap-4 rounded-2xl border p-4 ${toneCls}`}>
        <div className="flex min-w-0 max-w-2xl flex-col gap-1">
          <span className="flex items-center gap-2 text-sm font-semibold"><span className={`h-2 w-2 rounded-full ${dot}`} />{status.label}</span>
          <span className="text-sm text-muted">{status.text}</span>
          {c.lastRegisterAtMs && c.lastRegisterOk === false ? (
            <span className="text-xs text-down">Last attempt {formatAgo(c.lastRegisterAtMs)}: {c.lastRegisterMessage}</span>
          ) : null}
        </div>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div><dt className="text-xs text-muted">Received (7 days)</dt><dd className="font-semibold tabular-nums">{c.received7d}</dd></div>
          <div><dt className="text-xs text-muted">Not yet claimed</dt><dd className={`font-semibold tabular-nums ${c.unclaimed > 0 ? 'text-warn' : ''}`}>{c.unclaimed}</dd></div>
          <div><dt className="text-xs text-muted">Last payment</dt><dd className="font-semibold">{c.lastReceivedAtMs ? formatAgo(c.lastReceivedAtMs) : 'None yet'}</dd></div>
        </dl>
      </div>

      {/* 2. What players see */}
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">What players pay into</h3>
            <p className="text-xs text-muted">Shown on the deposit screen as “Pay Bill”. Only brands that use the System payment accounts offer it.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={form.enabled} disabled={!canEdit} onChange={(e) => set('enabled', e.target.checked)} />
            Offer Pay Bill to players
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Pay Bill / Till number" value={form.shortcode} disabled={!canEdit} inputMode="numeric" error={shortErr} onChange={(e) => set('shortcode', e.target.value.trim())} />
          <Input label="Account number players enter" hint="Up to 20 characters" value={form.accountNumber} maxLength={20} disabled={!canEdit} onChange={(e) => set('accountNumber', e.target.value)} />
          <Input label="Business name" hint="As it appears on the M-PESA confirmation" value={form.businessName} maxLength={60} disabled={!canEdit} onChange={(e) => set('businessName', e.target.value)} />
          <Input label="Extra instructions" optional value={form.instructions} maxLength={500} disabled={!canEdit} onChange={(e) => set('instructions', e.target.value)} />
        </div>
      </section>

      {/* 3. Where Safaricom sends payments */}
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <div>
          <h3 className="text-sm font-semibold">Where Safaricom sends payments</h3>
          <p className="text-xs text-muted">Filled in for this deployment. Safaricom calls the confirmation URL for every payment to your Pay Bill.</p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Input label="Confirmation URL" value={form.confirmationUrl} disabled={!canEdit} error={urlErr.confirmationUrl ?? undefined} onChange={(e) => set('confirmationUrl', e.target.value.trim())} />
          <Input label="Validation URL" optional hint="Only called if Safaricom has enabled validation on your Pay Bill." value={form.validationUrl} disabled={!canEdit} error={urlErr.validationUrl ?? undefined} onChange={(e) => set('validationUrl', e.target.value.trim())} />
          <label className="flex flex-col gap-1.5 text-sm sm:max-w-sm">
            <span className="font-medium">If the validation URL can’t be reached</span>
            <select value={form.responseType} disabled={!canEdit} onChange={(e) => set('responseType', e.target.value as Form['responseType'])}
              className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-sm outline-none focus:border-accent">
              <option value="Completed">Accept the payment (recommended)</option>
              <option value="Cancelled">Reject the payment</option>
            </select>
          </label>
        </div>
      </section>

      {canEdit ? (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-2xl md:border">
          <span className="text-sm text-muted">
            {dirty ? `${dirty} unsaved change${dirty > 1 ? 's' : ''}` : suggested.length ? 'Suggested URLs are filled in — save to use them' : c.registrationCurrent ? 'Saved and registered' : 'Saved'}
          </span>
          <div className="flex items-center gap-2">
            {dirty ? <Button variant="ghost" size="sm" onClick={() => setForm(toForm(c, defaults))}>Discard</Button> : null}
            <Button size="sm" onClick={save} disabled={pending === 0 || invalid || update.isPending}
              title={invalid ? 'Fix the highlighted fields first' : pending === 0 ? 'Nothing to save' : undefined}>
              {update.isPending ? 'Saving…' : !dirty && suggested.length ? 'Save suggested URLs' : 'Save'}
            </Button>
            <ConfirmButton
              label={c.registrationCurrent ? 'Register again' : 'Register with Safaricom'}
              confirmLabel="Yes, register now"
              variant="outline"
              busy={register.isPending}
              disabled={dirty > 0 || !c.shortcode || !c.confirmationUrl}
              onConfirm={doRegister}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

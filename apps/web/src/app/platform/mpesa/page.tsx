'use client';

import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatAgo } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { PageHeader, Section, Empty, FilterSelect } from '@/components/admin/ui';
import { useMpesaConfig, useUpdateMpesaConfig } from '@/lib/admin/hooks';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { useCan } from '@/lib/auth/can';
import type { MpesaConfigPatch, MpesaConfigRow } from '@/lib/admin/types';
import { env as appEnv } from '@/lib/env';
import { defaultMpesaEndpoints, DEFAULT_MPESA_ENV } from '@/lib/admin/mpesaDefaults';
import { PageTabs, useTabParam } from '@/components/admin/Tabs';
import { C2bPanel } from '@/components/platform/C2bPanel';

// Plain (non-secret) editable string fields and their labels/hints.
type PlainKey = 'shortcode' | 'stkCallbackUrl' | 'b2cInitiator' | 'b2cResultUrl' | 'b2cTimeoutUrl' | 'tillNumber' | 'b2cShortcode';
type Tab = 'stk' | 'b2c' | 'c2b' | 'credentials';
// UI (docs/45): grouped by what each setting is FOR — deposits the app asks for (STK), payouts (B2C),
// payments players start from the M-PESA menu (C2B / Pay Bill), and the app's secrets.
const PLAIN: { key: PlainKey; label: string; hint: string; tab: Tab }[] = [
  { key: 'shortcode', label: 'Business shortcode', hint: 'From Safaricom. The Pay Bill (or head office) number STK prompts are sent for', tab: 'stk' },
  { key: 'tillNumber', label: 'Till / store number', hint: 'Only for Buy Goods (Till). Leave blank for Pay Bill', tab: 'stk' },
  { key: 'stkCallbackUrl', label: 'Deposit callback URL', hint: 'Filled in for this deployment. Change only if told to', tab: 'stk' },
  { key: 'b2cShortcode', label: 'Payout shortcode', hint: 'Only if payouts use a different shortcode from deposits', tab: 'b2c' },
  { key: 'b2cInitiator', label: 'Initiator name', hint: 'From Safaricom. The API operator username for payouts', tab: 'b2c' },
  { key: 'b2cResultUrl', label: 'Payout result URL', hint: 'Filled in for this deployment. Change only if told to', tab: 'b2c' },
  { key: 'b2cTimeoutUrl', label: 'Payout timeout URL', hint: 'Filled in for this deployment. Change only if told to', tab: 'b2c' },
];
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'stk', label: 'Deposits (STK)', hint: 'The prompt a player approves on their phone when depositing from the app.' },
  { id: 'b2c', label: 'Payouts (B2C)', hint: 'Sending withdrawals to players’ M-PESA.' },
  { id: 'c2b', label: 'Pay Bill (C2B)', hint: 'Payments players make themselves from the M-PESA menu, verified when Safaricom tells us.' },
  { id: 'credentials', label: 'Credentials', hint: 'The Daraja app keys. Write-only: saved values are never shown.' },
];

// Secret (write-only) fields. Patch keys differ from the masked has_* flags.
type SecretKey = 'consumerKey' | 'consumerSecret' | 'passkey' | 'securityCredential';
const SECRETS: { key: SecretKey; label: string; has: keyof MpesaConfigRow }[] = [
  { key: 'consumerKey', label: 'Consumer key', has: 'hasConsumerKey' },
  { key: 'consumerSecret', label: 'Consumer secret', has: 'hasConsumerSecret' },
  { key: 'passkey', label: 'STK passkey', has: 'hasPasskey' },
  { key: 'securityCredential', label: 'B2C security credential', has: 'hasSecurityCredential' },
];

const ENV_OPTIONS = [
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'production', label: 'Production' },
];

function MpesaBody() {
  const cfgQ = useMpesaConfig();
  const update = useUpdateMpesaConfig();
  const toast = useToast();
  const canEdit = useCan('backoffice.governance');   // docs/42: token role via the shared capability list
  // Owner-tier edit is SYSTEM-only (Issue 1 / F1): only the platform owner (platform_superadmin)
  // may edit M-Pesa config; it moved out of the site back-office into the system console.

  const cfg = cfgQ.data;
  const [env, setEnv] = useState(DEFAULT_MPESA_ENV);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [txnType, setTxnType] = useState<'paybill' | 'till'>('paybill');
  const [b2cCmd, setB2cCmd] = useState<'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'>('BusinessPayment');
  const [tab, setTab] = useTabParam<Tab>(TABS.map((t) => t.id), 'stk');

  // Hydrate plain fields + environment when config arrives. Secrets always start blank (write-only).
  // OUR own callback endpoints and the production environment are auto-filled whenever unset, so the
  // operator only enters the Safaricom-issued values (shortcode + keys + passkey; B2C initiator/
  // credential for withdrawals). Any value already stored is kept as-is.
  const hydrate = () => {
    if (!cfg) return;
    const d = defaultMpesaEndpoints(appEnv.apiBaseUrl);
    setEnv(cfg.environment || DEFAULT_MPESA_ENV);
    setPlain({
      shortcode: cfg.shortcode,
      stkCallbackUrl: cfg.stkCallbackUrl || d.stkCallbackUrl,
      b2cInitiator: cfg.b2cInitiator,
      b2cResultUrl: cfg.b2cResultUrl || d.b2cResultUrl,
      b2cTimeoutUrl: cfg.b2cTimeoutUrl || d.b2cTimeoutUrl,
      tillNumber: cfg.tillNumber ?? '',
      b2cShortcode: cfg.b2cShortcode ?? '',
    });
    setTxnType(cfg.transactionType || 'paybill');
    setB2cCmd(cfg.b2cCommandId || 'BusinessPayment');
    setSecrets({});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(hydrate, [cfg]);

  // Build a patch of only changed plain fields, env change, and any non-empty secrets.
  const patch = useMemo<MpesaConfigPatch>(() => {
    if (!cfg) return {};
    const out: Record<string, string> = {};
    if (env !== cfg.environment) out.environment = env;
    for (const f of PLAIN) {
      const v = plain[f.key] ?? '';
      if (v !== (cfg[f.key] as string)) out[f.key] = v;
    }
    for (const sct of SECRETS) {
      const v = (secrets[sct.key] ?? '').trim();
      if (v !== '') out[sct.key] = v;
    }
    if (txnType !== (cfg.transactionType || 'paybill')) out.transactionType = txnType;
    if (b2cCmd !== (cfg.b2cCommandId || 'BusinessPayment')) out.b2cCommandId = b2cCmd;
    return out as MpesaConfigPatch;
  }, [cfg, env, plain, secrets, txnType, b2cCmd]);

  const dirtyCount = Object.keys(patch).length;
  // Our own endpoints pre-filled into EMPTY fields are suggestions, not the owner's edits (audit C68).
  const d0 = defaultMpesaEndpoints(appEnv.apiBaseUrl);
  const suggested = cfg ? (['stkCallbackUrl', 'b2cResultUrl', 'b2cTimeoutUrl'] as const).filter((k) => !cfg[k] && plain[k] === d0[k]).length : 0;
  const envSuggested = cfg && !cfg.environment && env === DEFAULT_MPESA_ENV ? 1 : 0;
  const userChanges = dirtyCount - suggested - envSuggested;

  function save() {
    update.mutate(patch, {
      onSuccess: () => {
        setSecrets({}); // clear entered secrets after save
        toast.push({ tone: 'success', title: 'M-Pesa config saved', description: 'In effect within a minute.' });
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <>
      <PageHeader
        title="M-Pesa defaults"
        subtitle="The System M-Pesa account every brand uses unless it has its own payment accounts."
      />

      {cfgQ.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : cfgQ.isError || !cfg ? (
        <Empty title="Couldn't load M-Pesa config" description="Try again shortly." />
      ) : (
        <>
          {!canEdit ? (
            <div className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
              You have read-only access. Only the <span className="font-medium text-fg">System owner</span> can change M-Pesa settings.
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <PageTabs tabs={TABS} value={tab} onChange={setTab} label="M-Pesa settings" />
            <p className="text-sm text-muted">{TABS.find((t) => t.id === tab)?.hint}</p>
          </div>

          {tab === 'c2b' ? <C2bPanel canEdit={canEdit} /> : (
            <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
              {tab === 'stk' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FilterSelect label="Environment" value={env} onChange={setEnv} options={ENV_OPTIONS} />
                  <FilterSelect label="Deposit type" value={txnType} onChange={(v) => setTxnType(v as 'paybill' | 'till')}
                    options={[{ value: 'paybill', label: 'Pay Bill' }, { value: 'till', label: 'Till (Buy Goods)' }]} />
                </div>
              ) : null}
              {tab === 'b2c' ? (
                <div className="sm:w-80">
                  <FilterSelect label="Payout type" value={b2cCmd} onChange={(v) => setB2cCmd(v as 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment')}
                    options={[{ value: 'BusinessPayment', label: 'Business payment (standard)' }, { value: 'SalaryPayment', label: 'Salary payment' }, { value: 'PromotionPayment', label: 'Promotion payment' }]} />
                </div>
              ) : null}
              {tab !== 'credentials' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {PLAIN.filter((f) => f.tab === tab).map((f) => (
                    <Input
                      key={f.key}
                      label={f.label}
                      hint={f.hint}
                      value={plain[f.key] ?? ''}
                      disabled={!canEdit}
                      onChange={(e) => setPlain((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {SECRETS.map((sct) => {
                    const set = Boolean(cfg[sct.has]);
                    return (
                      <Input
                        key={sct.key}
                        type="password"
                        label={sct.label}
                        hint={set ? 'Saved. Leave blank to keep it' : 'Not set yet'}
                        placeholder={set ? '•••••••• (unchanged)' : 'Enter value'}
                        autoComplete="off"
                        value={secrets[sct.key] ?? ''}
                        disabled={!canEdit}
                        onChange={(e) => setSecrets((s) => ({ ...s, [sct.key]: e.target.value }))}
                      />
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted">
                Last saved {cfg.updatedAtMs ? formatAgo(cfg.updatedAtMs) : 'never'}. Saved changes take effect within a minute, no restart needed.
              </p>
            </div>
          )}

          {canEdit && tab !== 'c2b' ? (
            <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-2xl md:border">
              <span className="text-sm text-muted">
                {userChanges > 0 ? `${userChanges} unsaved change${userChanges > 1 ? 's' : ''}` : dirtyCount > 0 ? 'Suggested endpoints are filled in — save to use them' : 'All changes saved'}
              </span>
              <div className="flex items-center gap-2">
                {userChanges > 0 ? <Button variant="ghost" size="sm" onClick={hydrate}>Discard</Button> : null}
                <Button size="sm" onClick={save} disabled={dirtyCount === 0 || update.isPending}>
                  {update.isPending ? 'Saving…' : userChanges === 0 && dirtyCount > 0 ? 'Save suggested endpoints' : 'Save'}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export default function MpesaConfigPage() {
  return (
    <RequireCapability cap="backoffice.governance" title="Owner-only area" hint="System governance is managed by the system owner from their own console session.">
      <MpesaBody />
    </RequireCapability>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatRelativeTime } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import { PageHeader, Section, Empty, FilterSelect } from '@/components/admin/ui';
import { useMpesaConfig, useUpdateMpesaConfig } from '@/lib/admin/hooks';
import { SuperadminOnly } from '@/components/admin/SuperadminOnly';
import type { MpesaConfigPatch, MpesaConfigRow } from '@/lib/admin/types';
import { env as appEnv } from '@/lib/env';
import { defaultMpesaEndpoints, DEFAULT_MPESA_ENV } from '@/lib/admin/mpesaDefaults';

// Plain (non-secret) editable string fields and their labels/hints.
type PlainKey = 'shortcode' | 'stkCallbackUrl' | 'b2cInitiator' | 'b2cResultUrl' | 'b2cTimeoutUrl' | 'tillNumber' | 'b2cShortcode';
const PLAIN: { key: PlainKey; label: string; hint: string }[] = [
  { key: 'shortcode', label: 'Paybill / shortcode', hint: 'From Safaricom. Business shortcode that receives STK pushes and sends B2C' },
  { key: 'stkCallbackUrl', label: 'STK callback URL', hint: 'Auto-filled for this deployment. Edit only if your paybill posts elsewhere' },
  { key: 'tillNumber', label: 'Till / store number', hint: 'Only for Buy Goods (Till). Used as STK PartyB. Leave blank for Paybill' },
  { key: 'b2cShortcode', label: 'B2C shortcode (PartyA)', hint: 'Only if your B2C shortcode differs from the paybill above; else leave blank' },
  { key: 'b2cInitiator', label: 'B2C initiator name', hint: 'From Safaricom. API operator username for withdrawals' },
  { key: 'b2cResultUrl', label: 'B2C result URL', hint: 'Auto-filled for this deployment. Edit only if different' },
  { key: 'b2cTimeoutUrl', label: 'B2C timeout URL', hint: 'Auto-filled for this deployment. Edit only if different' },
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
  const role = useSession((s) => s.user?.role);
  // Owner-tier edit is SYSTEM-only (Issue 1 / F1): only the platform owner (platform_superadmin)
  // may edit M-Pesa config; it moved out of the site back-office into the system console.
  const canEdit = role === 'platform_superadmin';

  const cfg = cfgQ.data;
  const [env, setEnv] = useState(DEFAULT_MPESA_ENV);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [txnType, setTxnType] = useState<'paybill' | 'till'>('paybill');
  const [b2cCmd, setB2cCmd] = useState<'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'>('BusinessPayment');

  // Hydrate plain fields + environment when config arrives. Secrets always start blank (write-only).
  // OUR own callback endpoints and the production environment are auto-filled whenever unset, so the
  // operator only enters the Safaricom-issued values (shortcode + keys + passkey; B2C initiator/
  // credential for withdrawals). Any value already stored is kept as-is.
  useEffect(() => {
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
  }, [cfg]);

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

  function save() {
    update.mutate(patch, {
      onSuccess: () => {
        setSecrets({}); // clear entered secrets after save
        toast.push({ tone: 'success', title: 'M-Pesa config saved', description: 'Credential changes apply on the next API restart.' });
      },
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <>
      <PageHeader
        title="M-Pesa configuration"
        subtitle="Daraja paybill, endpoints and credentials. Secrets are write-only — stored values are never displayed."
      />

      {cfgQ.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : cfgQ.isError || !cfg ? (
        <Empty title="Couldn't load M-Pesa config" description="Try again shortly." />
      ) : (
        <>
          {!canEdit ? (
            <div className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
              You have read-only access. Only the <span className="font-medium text-fg">system owner</span> can change M-Pesa settings.
            </div>
          ) : (
            <div className="rounded-2xl border border-warn px-4 py-3 text-sm text-warn">
              Changes to credentials and endpoints take effect when the payment service next restarts. Empty secret fields keep the current value.
            </div>
          )}

          <Section title="Environment & endpoints">
            <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
                <span>
                  Last updated:{' '}
                  <span className="font-medium text-fg">
                    {cfg.updatedAtMs ? `${formatRelativeTime(cfg.updatedAtMs)} ago` : 'never'}
                    {cfg.updatedBy ? ` by ${cfg.updatedBy.slice(0, 8)}…` : ''}
                  </span>
                </span>
              </div>

              <div className="w-48">
                <FilterSelect label="Environment" value={env} onChange={setEnv} options={ENV_OPTIONS} />
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="w-56">
                  <FilterSelect label="STK type" value={txnType} onChange={(v) => setTxnType(v as 'paybill' | 'till')}
                    options={[{ value: 'paybill', label: 'Paybill (Pay Bill)' }, { value: 'till', label: 'Till (Buy Goods)' }]} />
                </div>
                <div className="w-56">
                  <FilterSelect label="B2C command" value={b2cCmd} onChange={(v) => setB2cCmd(v as 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment')}
                    options={[{ value: 'BusinessPayment', label: 'Business Payment' }, { value: 'SalaryPayment', label: 'Salary Payment' }, { value: 'PromotionPayment', label: 'Promotion Payment' }]} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PLAIN.map((f) => (
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
            </div>
          </Section>

          <Section title="Credentials (write-only)">
            <div className="grid grid-cols-1 gap-3 rounded-2xl border border-border bg-surface p-4 sm:grid-cols-2">
              {SECRETS.map((sct) => {
                const set = Boolean(cfg[sct.has]);
                return (
                  <Input
                    key={sct.key}
                    type="password"
                    label={sct.label}
                    hint={set ? 'A value is set — leave blank to keep it' : 'Not set'}
                    placeholder={set ? '•••••••• (unchanged)' : 'Enter value'}
                    autoComplete="off"
                    value={secrets[sct.key] ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => setSecrets((s) => ({ ...s, [sct.key]: e.target.value }))}
                  />
                );
              })}
            </div>
          </Section>

          {canEdit ? (
            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={dirtyCount === 0 || update.isPending}>
                {update.isPending ? 'Saving…' : dirtyCount > 0 ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'No changes'}
              </Button>
              {dirtyCount > 0 ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const d = defaultMpesaEndpoints(appEnv.apiBaseUrl);
                    setEnv(cfg.environment || DEFAULT_MPESA_ENV);
                    setPlain({
                      shortcode: cfg.shortcode,
                      stkCallbackUrl: cfg.stkCallbackUrl || d.stkCallbackUrl,
                      b2cInitiator: cfg.b2cInitiator,
                      b2cResultUrl: cfg.b2cResultUrl || d.b2cResultUrl,
                      b2cTimeoutUrl: cfg.b2cTimeoutUrl || d.b2cTimeoutUrl,
                    });
                    setSecrets({});
                  }}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export default function MpesaConfigPage() {
  return (
    <SuperadminOnly>
      <MpesaBody />
    </SuperadminOnly>
  );
}

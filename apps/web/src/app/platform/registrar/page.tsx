'use client';

import { useEffect, useState } from 'react';
import { PageHeader, Section } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useRegistrarConfig, useSetRegistrarConfig, useTestRegistrarConfig } from '@/lib/platform/hooks';
import { useCan } from '@/lib/auth/can';
import { OwnerPlatformPicker, DEFAULT_PLATFORM_ID } from '@/components/platform/OwnerPlatformPicker';

/**
 * Domain registrar (Namecheap) configuration — Issue 1 #3.
 *
 * A platform admin connects its OWN Namecheap account so new client domains are pointed automatically
 * during onboarding. The API key is encrypted server-side and never returned (only a masked hint). The
 * IP that Namecheap must whitelist (this platform's server egress IP) is auto-detected and shown here.
 */
export default function RegistrarConfigPage() {
  // docs/42 UI-9: the System admin chooses WHICH platform's registrar it is editing (was always the
  // default platform); a platform admin edits its own (pinned server-side, no picker).
  const isSystem = useCan('console.system');
  const [platformId, setPlatformId] = useState(DEFAULT_PLATFORM_ID);
  const target = isSystem ? platformId : undefined;
  const cfgQ = useRegistrarConfig(target);
  const save = useSetRegistrarConfig(target);
  const testMut = useTestRegistrarConfig(target);

  const cfg = cfgQ.data;
  const [apiUser, setApiUser] = useState('');
  const [userName, setUserName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the form from the stored (non-secret) settings once loaded. The key stays blank (write-only).
  useEffect(() => {
    if (!cfg) return;
    setApiUser(cfg.settings.api_user ?? '');
    setUserName(cfg.settings.username ?? cfg.settings.api_user ?? '');
    setApiKey(''); setSaved(false); testMut.reset();
  }, [cfg?.exists, cfg?.platformId]); // eslint-disable-line react-hooks/exhaustive-deps

  const egressIp = cfg?.egressIp ?? null;
  const last4 = cfg?.secretMeta?.api_key?.last4 ?? '';
  const encOff = cfg ? !cfg.encryptionConfigured : false;

  const draft = () => ({
    apiUser: apiUser.trim(),
    userName: (userName.trim() || apiUser.trim()),
    ...(egressIp ? { clientIp: egressIp } : {}),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const copyIp = async () => {
    if (!egressIp) return;
    try { await navigator.clipboard.writeText(egressIp); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  };

  const canSave = apiUser.trim().length > 0 && (cfg?.hasSecret || apiKey.trim().length > 0) && !encOff;

  return (
    <>
      <PageHeader
        title="Domain registrar"
      />

      {isSystem ? (
        <div className="flex flex-col gap-2">
          <OwnerPlatformPicker value={platformId} onChange={setPlatformId} label="Registrar for platform" />
          {platformId === DEFAULT_PLATFORM_ID && cfg && !cfg.exists ? (
            <p className="text-xs text-muted">Nothing saved for the default platform: onboarding uses the server&apos;s built-in Namecheap account. Saving here replaces it for the default platform.</p>
          ) : null}
        </div>
      ) : null}

      {encOff ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-fg">
          Secure credential storage isn’t configured on this deployment yet, so the API key can’t be saved.
          Ask the platform operator to set <code className="rounded bg-surface-2 px-1">REGISTRAR_CONFIG_ENC_KEY</code> (or the
          existing payments key). You can still whitelist the IP below in the meantime.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {/* ── Credentials form ─────────────────────────────────────────────────────────────── */}
        <div className="md:col-span-2">
        <Section title="Namecheap API credentials">
          <form
            className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4"
            onSubmit={(e) => {
              e.preventDefault();
              setSaved(false);
              save.mutate(draft(), { onSuccess: () => { setSaved(true); setApiKey(''); } });
            }}
          >
            {/* The IP to whitelist — auto-detected, read-only, copyable. */}
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">IP to whitelist in Namecheap</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-surface-2 px-2 py-1 font-mono text-sm text-fg">{egressIp ?? 'detecting…'}</code>
                <Button type="button" variant="secondary" size="sm" onClick={copyIp} disabled={!egressIp}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted">
                This is the platform server’s egress IP. Namecheap only accepts API calls from whitelisted IPs, so add
                this exact value under <b>Profile → Tools → API Access → Whitelisted IPs</b>. It is saved with your config
                automatically — you don’t need to type it.
              </p>
            </div>

            <Input label="API user" name="apiUser" value={apiUser} onChange={(e) => setApiUser(e.target.value)} placeholder="your-namecheap-username" required />
            <Input label="Account username" name="userName" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="usually the same as the API user" optional />
            <Input
              label={cfg?.hasSecret ? `API key (saved •••• ${last4} — leave blank to keep)` : 'API key'}
              name="apiKey" type="password" autoComplete="off"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={cfg?.hasSecret ? '•••• •••• •••• keep current' : 'paste your Namecheap API key'}
              {...(cfg?.hasSecret ? { optional: true } : { required: true })}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={save.isPending || !canSave}>
                {save.isPending ? 'Saving…' : 'Save configuration'}
              </Button>
              <Button
                type="button" variant="secondary"
                disabled={testMut.isPending || (!apiUser.trim() && !cfg?.hasSecret)}
                onClick={() => { setSaved(false); testMut.mutate(draft()); }}
              >
                {testMut.isPending ? 'Testing…' : 'Test connection'}
              </Button>
              {saved ? <span className="text-sm text-up">Saved. Your registrar is connected.</span> : null}
              {save.isError ? <span className="text-sm text-down">{(save.error as Error).message}</span> : null}
            </div>

            {/* Test result — surfaces the exact IP-whitelist error when the IP isn't yet added. */}
            {testMut.data ? (
              <div className={[
                'rounded-xl border px-3 py-2 text-sm',
                testMut.data.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-fg' : 'border-down/40 bg-down/10 text-fg',
              ].join(' ')}>
                {testMut.data.ok ? '✓ ' : '✕ '}{testMut.data.detail}
              </div>
            ) : null}
            {testMut.isError ? <div className="rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-sm text-fg">{(testMut.error as Error).message}</div> : null}
          </form>
        </Section>
        </div>

        {/* ── Guided steps ─────────────────────────────────────────────────────────────────── */}
        <Section title="How to connect (2 minutes)">
          <ol className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 text-sm text-fg">
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">1</span>
              <span>Sign in to <b>namecheap.com</b> → <b>Profile → Tools</b>, find <b>Namecheap API Access</b> and toggle it <b>ON</b> (you may need to meet Namecheap’s account requirements).</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">2</span>
              <span>Copy your <b>API key</b> from that page and paste it on the left. Your <b>API user</b> is your Namecheap username.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">3</span>
              <span>On the same page, under <b>Whitelisted IPs</b>, add the <b>IP shown on the left</b>. Namecheap rejects calls from any other IP.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">4</span>
              <span>Click <b>Test connection</b>. When it succeeds, <b>Save</b>. New client domains you onboard will then be pointed to the platform automatically.</span>
            </li>
            <li className="mt-1 rounded-lg bg-surface-2 p-3 text-xs text-muted">
              🔒 Your API key is encrypted before it’s stored and is never shown again — only the last 4 characters, so you can confirm which key is saved.
            </li>
          </ol>
        </Section>
      </div>
    </>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { usePaymentProviders, useSetProviderGlobal, useSetProviderSite, usePlatformSites } from '@/lib/platform/hooks';

/**
 * Superadmin control over WHICH deposit gateways players see (migration 0116).
 *  - Each provider has a platform-global on/off that affects EVERY brand without an override.
 *  - Per-brand overrides force a gateway on/off for one client (Inherit reverts to the global default).
 * Multiple gateways can be enabled at once; each enabled one becomes a tab on the deposit sheet.
 */
export function PaymentGatewaysSection() {
  const { data, isLoading } = usePaymentProviders();
  const { data: sitesData } = usePlatformSites();
  const setGlobal = useSetProviderGlobal();
  const setSite = useSetProviderSite();

  const sites = sitesData?.sites ?? [];
  const [siteId, setSiteId] = useState<string>('');

  const overrideFor = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const o of data?.overrides ?? []) m.set(`${o.siteId}:${o.providerCode}`, o.enabled);
    return m;
  }, [data]);

  if (isLoading) return <p className="text-sm text-muted">Loading payment gateways…</p>;
  const providers = data?.providers ?? [];

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface-2 p-5">
      <div>
        <h2 className="text-base font-semibold text-fg">Payment gateways</h2>
        <p className="mt-1 text-sm text-muted">
          Switch which deposit gateways appear on the deposit page — globally for all clients, or overridden per client.
        </p>
      </div>

      {/* Global switches */}
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {providers.map((p) => (
          <div key={p.code} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-fg">{p.displayName}</div>
              <div className="text-xs text-muted">
                {p.enabledGlobal ? 'Shown for all clients (unless overridden)' : 'Hidden for all clients (unless overridden)'}
              </div>
            </div>
            <ToggleSwitch
              checked={p.enabledGlobal}
              disabled={setGlobal.isPending}
              onChange={(next) => setGlobal.mutate({ code: p.code, enabled: next })}
              label={`Toggle ${p.displayName} globally`}
            />
          </div>
        ))}
      </div>

      {/* Per-brand overrides */}
      <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="text-sm font-semibold text-fg">Per-client override</div>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Client (brand)
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="">Select a client…</option>
            {sites.map((s) => (
              <option key={s.siteId} value={s.siteId}>{s.name} ({s.slug})</option>
            ))}
          </select>
        </label>

        {siteId ? (
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {providers.map((p) => {
              const key = `${siteId}:${p.code}`;
              const has = overrideFor.has(key);
              const state: 'inherit' | 'on' | 'off' = !has ? 'inherit' : overrideFor.get(key) ? 'on' : 'off';
              return (
                <div key={p.code} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="text-sm text-fg">{p.displayName}</span>
                  <div className="flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label={`${p.displayName} override`}>
                    {(['inherit', 'on', 'off'] as const).map((opt) => {
                      const active = state === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          disabled={setSite.isPending}
                          onClick={() =>
                            setSite.mutate({ code: p.code, siteId, enabled: opt === 'inherit' ? null : opt === 'on' })
                          }
                          className={[
                            'rounded-md px-3 py-1 text-xs font-semibold capitalize transition',
                            active ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
                          ].join(' ')}
                        >
                          {opt === 'inherit' ? 'Inherit' : opt === 'on' ? 'On' : 'Off'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <p className="px-3 py-2 text-xs text-muted">
              “Inherit” follows the global switch. “On/Off” forces this gateway for this client only.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-border',
      ].join(' ')}
    >
      <span className={['inline-block h-5 w-5 transform rounded-full bg-white transition', checked ? 'translate-x-5' : 'translate-x-0.5'].join(' ')} />
    </button>
  );
}

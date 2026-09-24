'use client';

import { useMemo, useState } from 'react';
import { PageHeader, Section } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useGlobalConfig, useSetGlobalConfig, usePlatformSites } from '@/lib/platform/hooks';
import type { GlobalConfigDto } from '@/lib/platform/endpoints';
import Link from 'next/link';
import { CohortEconomySection, PaymentsEconomySection } from '@/components/platform/GlobalEconomy';
import { formatKes } from '@invest254/shared/money';

const money = (cents: number, _cur = 'KES') => formatKes(cents);

/** The five master switches, mapped to their DB field + a plain-language description. */
const SYSTEMS: { key: keyof GlobalConfigDto; api: string; label: string; desc: string }[] = [
  { key: 'depositsEnabled', api: 'deposits_enabled', label: 'Deposits', desc: 'M-Pesa STK deposits across every brand' },
  { key: 'withdrawalsEnabled', api: 'withdrawals_enabled', label: 'Withdrawals', desc: 'Withdrawal requests across every brand' },
  { key: 'playEnabled', api: 'play_enabled', label: 'Play (open trades)', desc: 'Opening new positions — in-flight trades still settle normally' },
  { key: 'marketersEnabled', api: 'marketers_enabled', label: 'Marketer app', desc: 'Marketer login across every brand' },
  { key: 'registrationsEnabled', api: 'registrations_enabled', label: 'New registrations', desc: 'New player signups across every brand' },
];

export default function GlobalConfigPage() {
  const cfgQ = useGlobalConfig();
  const sitesQ = usePlatformSites();
  const setCfg = useSetGlobalConfig();

  const cfg = cfgQ.data?.config;
  const sites = useMemo(() => sitesQ.data?.sites ?? [], [sitesQ.data]);
  const activeSites = useMemo(() => sites.filter((s) => s.status === 'active'), [sites]);
  const nameById = useMemo(() => new Map(sites.map((s) => [s.siteId, s.name])), [sites]);

  const [confirmOff, setConfirmOff] = useState<(typeof SYSTEMS)[number] | null>(null);
  const [bannerDraft, setBannerDraft] = useState<string | null>(null);

  const anyOff = cfg ? SYSTEMS.some((s) => cfg[s.key] === false) : false;

  function onToggle(sys: (typeof SYSTEMS)[number]) {
    if (!cfg) return;
    if (cfg[sys.key] === true) setConfirmOff(sys);          // turning OFF is disruptive → confirm
    else setCfg.mutate({ [sys.api]: true });                // turning ON is safe → immediate
  }

  const bannerValue = bannerDraft ?? cfg?.maintenanceMessage ?? '';
  function saveBanner() {
    setCfg.mutate({ maintenance_message: bannerValue.trim() || null }, { onSuccess: () => setBannerDraft(null) });
  }

  if (cfgQ.isLoading || sitesQ.isLoading) return <p className="text-sm text-muted">Loading global configuration…</p>;
  if (!cfg) return <p className="text-sm text-down">Couldn&apos;t load global configuration.</p>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Controls & economy"
        subtitle={`One control plane over all ${activeSites.length} active brand${activeSites.length === 1 ? '' : 's'} · config v${cfg.version}`}
      />

      {anyOff && (
        <Card className="border-down/40 bg-down/5">
          <p className="text-sm font-medium text-down">⚠ One or more systems are currently OFF platform-wide.</p>
          <p className="mt-1 text-xs text-muted">
            {SYSTEMS.filter((s) => cfg[s.key] === false).map((s) => s.label).join(', ')} disabled for every brand.
          </p>
        </Card>
      )}

      {/* ── Master switches ── */}
      <Section title="Master systems — applies to every client">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SYSTEMS.map((sys) => {
            const on = cfg[sys.key] === true;
            return (
              <Card key={sys.api} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-fg">{sys.label}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${on ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                      {on ? 'On' : 'Off'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{sys.desc}</p>
                </div>
                <Button
                  size="sm"
                  variant={on ? 'down' : 'up'}
                  disabled={setCfg.isPending}
                  onClick={() => onToggle(sys)}
                >
                  {on ? 'Turn off' : 'Turn on'}
                </Button>
              </Card>
            );
          })}
        </div>
      </Section>

      {/* ── Maintenance banner ── */}
      <Section title="Maintenance banner">
        <Card className="flex flex-col gap-3">
          <p className="text-xs text-muted">Shown to every player of every brand. Leave empty to remove it.</p>
          <Input
            value={bannerValue}
            onChange={(e) => setBannerDraft(e.target.value)}
            placeholder="e.g. Scheduled maintenance 02:00–03:00 EAT"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={saveBanner} disabled={setCfg.isPending || (bannerDraft === null)}>Save banner</Button>
            {cfg.maintenanceMessage && (
              <Button size="sm" variant="outline" onClick={() => setCfg.mutate({ maintenance_message: null }, { onSuccess: () => setBannerDraft(null) })} disabled={setCfg.isPending}>
                Clear
              </Button>
            )}
          </div>
        </Card>
      </Section>

      {/* ── Global game economy: separate PLAYER and MARKETER sets (pool-off / statistical path) ── */}
      <CohortEconomySection
        apiKey="player_economy" kind="players" title="Player economy"
        description="Overrides the game economy for regular players on every client when pool mode is OFF (the statistical settlement path). Enforced fields beat each brand's site config and per-user overrides."
        server={cfg.playerEconomy} sites={sites} version={cfg.version} setCfg={setCfg}
      />
      <CohortEconomySection
        apiKey="marketer_economy" kind="marketers" title="Marketer economy"
        description="A SEPARATE economy for marketer/affiliate accounts (always statistical, pool-exempt). Use it to run a distinct win-rate/edge/cap for marketers across every client."
        server={cfg.marketerEconomy} sites={sites} version={cfg.version} setCfg={setCfg}
      />

      {/* ── Payments (min/max deposit + min withdrawal) ── */}
      <PaymentsEconomySection server={cfg.payments} activeCount={activeSites.length} setCfg={setCfg} />

      {/* Payment gateways now live on their own dedicated pages (kept out of this page for clarity) */}
      <Section title="Payment gateways">
        <Link href="/platform/payments" className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2 p-5 transition hover:border-accent/50 hover:bg-surface">
          <div>
            <div className="text-sm font-semibold text-fg">Configure payment gateways</div>
            <div className="mt-1 text-sm text-muted">Mega Pay, Paystack, Binance Pay, PayHero — credentials, availability &amp; connection tests, each on its own page.</div>
          </div>
          <span className="shrink-0 text-sm font-semibold text-accent">Open Payments →</span>
        </Link>
      </Section>

      {/* POOL-1 (docs/46): the pool lives on ONE page (it used to be duplicated here with different labels). */}
      <Section title="Withdrawal pool">
        <Link href="/platform/pool" className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2 p-5 transition hover:border-accent/50 hover:bg-surface">
          <div>
            <div className="text-sm font-semibold text-fg">Daily payout budgets</div>
            <div className="mt-1 text-sm text-muted">Each brand’s budget today, automatic distribution and history — for one platform or all of them.</div>
          </div>
          <span className="shrink-0 text-sm font-semibold text-accent">Open Withdrawal pool →</span>
        </Link>
      </Section>

      {/* ── Confirm: turn a system OFF (disruptive, platform-wide) ── */}
      <Modal open={!!confirmOff} onClose={() => setConfirmOff(null)} title={`Turn off ${confirmOff?.label ?? ''}?`}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            This immediately disables <strong className="text-fg">{confirmOff?.label}</strong> for <strong className="text-fg">every brand</strong>.
            Users will be blocked until you turn it back on.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmOff(null)}>Cancel</Button>
            <Button variant="down" size="sm" disabled={setCfg.isPending}
              onClick={() => { if (confirmOff) setCfg.mutate({ [confirmOff.api]: false }, { onSuccess: () => setConfirmOff(null) }); }}>
              Yes, turn off platform-wide
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}

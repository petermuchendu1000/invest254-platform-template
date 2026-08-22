'use client';

import { useMemo, useState } from 'react';
import { PageHeader, StatCard, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  useGlobalConfig, useSetGlobalConfig, useDistributePool, usePoolDistributions, usePlatformSites,
  usePoolDemand, useDistributePoolDynamic,
} from '@/lib/platform/hooks';
import type { GlobalConfigDto } from '@/lib/platform/endpoints';
import { CohortEconomySection, PaymentsEconomySection } from '@/components/platform/GlobalEconomy';

const money = (cents: number, cur = 'KES') => `${cur} ${(cents / 100).toLocaleString()}`;

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
  const distMut = useDistributePool();
  const distQ = usePoolDistributions();

  const cfg = cfgQ.data?.config;
  const sites = useMemo(() => sitesQ.data?.sites ?? [], [sitesQ.data]);
  const activeSites = useMemo(() => sites.filter((s) => s.status === 'active'), [sites]);
  const nameById = useMemo(() => new Map(sites.map((s) => [s.siteId, s.name])), [sites]);

  const [confirmOff, setConfirmOff] = useState<(typeof SYSTEMS)[number] | null>(null);
  const [bannerDraft, setBannerDraft] = useState<string | null>(null);

  // ── Pool distributor state ──
  const [mode, setMode] = useState<'equal' | 'per_site'>('equal');
  const [totalKes, setTotalKes] = useState('');
  const [perSiteKes, setPerSiteKes] = useState<Record<string, string>>({});
  const [poolConfirm, setPoolConfirm] = useState(false);

  // ── Dynamic (demand-based) distributor state (docs/25 §15) ──
  const dynMut = useDistributePoolDynamic();
  const [dynTotalKes, setDynTotalKes] = useState('');
  const [dynConfirm, setDynConfirm] = useState(false);
  const dynTotalCents = dynTotalKes ? Math.round(Number(dynTotalKes) * 100) : undefined;
  const demandQ = usePoolDemand({ totalCents: dynTotalCents, lookbackDays: 14 });
  const demand = demandQ.data?.preview;

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

  // Pool preview (client-side mirror of fn_platform_distribute_pool).
  const totalCents = Math.round((Number(totalKes) || 0) * 100);
  const equalBase = activeSites.length ? Math.floor(totalCents / activeSites.length) : 0;
  const equalRem = activeSites.length ? totalCents - equalBase * activeSites.length : 0;
  const perSitePreview = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    if (mode === 'equal') activeSites.forEach((s, i) => { out[s.siteId] = equalBase + (i === 0 ? equalRem : 0); });
    else for (const s of activeSites) { const v = Math.round((Number(perSiteKes[s.siteId]) || 0) * 100); if (v > 0) out[s.siteId] = v; }
    return out;
  }, [mode, activeSites, equalBase, equalRem, perSiteKes]);
  const previewTotal = Object.values(perSitePreview).reduce((a, b) => a + b, 0);
  const canDistribute = mode === 'equal' ? totalCents > 0 : Object.keys(perSitePreview).length > 0;

  function runDistribute() {
    const body = mode === 'equal'
      ? { mode: 'equal', totalCents }
      : { mode: 'per_site', overrides: perSitePreview };
    distMut.mutate(body, { onSuccess: () => { setPoolConfirm(false); setTotalKes(''); setPerSiteKes({}); } });
  }

  if (cfgQ.isLoading || sitesQ.isLoading) return <p className="text-sm text-muted">Loading global configuration…</p>;
  if (!cfg) return <p className="text-sm text-down">Couldn&apos;t load global configuration.</p>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Global configuration"
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
          <p className="text-xs text-muted">Shown to every brand&apos;s users (via <code>/config</code>). Leave empty to clear.</p>
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

      {/* ── Global withdrawal-pool distributor ── */}
      <Section title="Global withdrawal pool — distribute to all clients">
        <Card className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Active brands" value={activeSites.length} />
            <StatCard label="Last global pool" money={cfg.globalDailyPoolCents ?? 0} />
            <StatCard label="This distribution" money={previewTotal} tone={previewTotal > 0 ? 'up' : 'default'} />
          </div>

          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'equal' ? 'primary' : 'outline'} onClick={() => setMode('equal')}>Split equally</Button>
            <Button size="sm" variant={mode === 'per_site' ? 'primary' : 'outline'} onClick={() => setMode('per_site')}>Per brand</Button>
          </div>

          {mode === 'equal' ? (
            <div className="flex flex-col gap-2">
              <Input
                label="Total pool (KES)"
                inputMode="numeric"
                value={totalKes}
                onChange={(e) => setTotalKes(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 900000"
              />
              <p className="text-xs text-muted">
                Splits to <strong className="text-fg">{money(equalBase)}</strong> each
                {equalRem > 0 ? <> (+{money(equalRem)} to the first brand)</> : null} across {activeSites.length} brands.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {activeSites.map((s) => (
                <Input
                  key={s.siteId}
                  label={`${s.name} (KES)`}
                  inputMode="numeric"
                  value={perSiteKes[s.siteId] ?? ''}
                  onChange={(e) => setPerSiteKes((p) => ({ ...p, [s.siteId]: e.target.value.replace(/[^0-9.]/g, '') }))}
                  placeholder="0"
                />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">New pool total: <strong className="text-fg tabular-nums">{money(previewTotal)}</strong></span>
            <Button onClick={() => setPoolConfirm(true)} disabled={!canDistribute || distMut.isPending}>
              {distMut.isPending ? 'Distributing…' : 'Distribute pool'}
            </Button>
          </div>
        </Card>
      </Section>

      {/* ── Dynamic distribution: allocate the global pool by DEMAND (docs/25 §15) ── */}
      <Section title="Dynamic distribution — allocate by demand">
        <Card className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            Allocates the global pool across brands in proportion to <strong className="text-fg">forecast demand</strong> —
            an EMA of recent player turnover × each brand&apos;s target RTP (1 − house edge) — water-filled with a floor and a cap.
            Idle brands get nothing; high-demand brands get more. Because the engine now pays realized RTP = min(target,
            pool/turnover), this funds each brand toward its house-edge target with minimal idle capital.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
            <div className="flex-1">
              <Input
                label="Global total (KES) — blank = keep current sum"
                inputMode="numeric"
                value={dynTotalKes}
                onChange={(e) => setDynTotalKes(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 1700000"
              />
            </div>
            <p className="text-xs text-muted sm:pb-2">Forecast window: last 14 days · marketer trades excluded (player demand only).</p>
          </div>

          {demandQ.isLoading ? (
            <p className="text-sm text-muted">Computing demand…</p>
          ) : demand ? (
            <TableWrap>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>Brand</Th>
                    <Th className="text-right">Forecast/day</Th>
                    <Th className="text-right">Required</Th>
                    <Th className="text-right">Current</Th>
                    <Th className="text-right">Suggested</Th>
                    <Th className="text-right">Coverage</Th>
                  </tr>
                </thead>
                <tbody>
                  {demand.rows.map((r) => (
                    <tr key={r.siteId} className="border-t border-border">
                      <Td>{r.slug}</Td>
                      <Td className="text-right tabular-nums">{money(r.forecastTurnoverCents)}</Td>
                      <Td className="text-right tabular-nums">{money(r.requiredCents)}</Td>
                      <Td className="text-right tabular-nums text-muted">{money(r.currentPoolCents)}</Td>
                      <Td className="text-right tabular-nums font-semibold">{money(r.suggestedCents)}</Td>
                      <Td className="text-right tabular-nums">
                        {r.requiredCents > 0
                          ? <span className={r.coverage >= 0.999 ? 'text-up' : r.coverage >= 0.8 ? 'text-fg' : 'text-down'}>{Math.round(r.coverage * 100)}%</span>
                          : <span className="text-muted">—</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <p className="text-sm text-muted">No demand data.</p>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">
              Suggested total: <strong className="text-fg tabular-nums">{money(demand?.suggestedTotalCents ?? 0)}</strong>
              {(demand?.reserveCents ?? 0) > 0 ? <> · reserve {money(demand!.reserveCents)}</> : null}
            </span>
            <Button onClick={() => setDynConfirm(true)} disabled={!demand || demand.suggestedTotalCents <= 0 || dynMut.isPending}>
              {dynMut.isPending ? 'Distributing…' : 'Distribute by demand'}
            </Button>
          </div>
        </Card>
      </Section>

      {/* ── Distribution history ── */}
      <Section title="Distribution history">
        {(distQ.data?.distributions ?? []).length === 0 ? (
          <Card><p className="text-sm text-muted">No pool distributions yet.</p></Card>
        ) : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr><Th>When</Th><Th>Mode</Th><Th>Brands</Th><Th className="text-right">Total</Th></tr></thead>
              <tbody>
                {(distQ.data?.distributions ?? []).map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <Td>{new Date(d.createdAt).toLocaleString()}</Td>
                    <Td>{d.mode}</Td>
                    <Td>{d.siteCount}</Td>
                    <Td className="text-right tabular-nums">{money(d.totalCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
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

      {/* ── Confirm: distribute pool (shows per-brand breakdown) ── */}
      <Modal open={poolConfirm} onClose={() => setPoolConfirm(false)} title="Confirm pool distribution">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Sets each brand&apos;s daily withdrawal-pool cap to:</p>
          <div className="max-h-60 overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(perSitePreview).map(([id, cents]) => (
                  <tr key={id} className="border-b border-border last:border-0">
                    <Td>{nameById.get(id) ?? id.slice(0, 8)}</Td>
                    <Td className="text-right tabular-nums">{money(cents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">Total: <strong className="tabular-nums">{money(previewTotal)}</strong></p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPoolConfirm(false)}>Cancel</Button>
            <Button size="sm" onClick={runDistribute} disabled={distMut.isPending}>
              {distMut.isPending ? 'Distributing…' : 'Confirm & distribute'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Confirm: dynamic (demand-based) distribution ── */}
      <Modal open={dynConfirm} onClose={() => setDynConfirm(false)} title="Confirm demand-based distribution">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Sets each brand&apos;s daily withdrawal-pool cap from forecast demand:</p>
          <div className="max-h-60 overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <tbody>
                {(demand?.rows ?? []).map((r) => (
                  <tr key={r.siteId} className="border-b border-border last:border-0">
                    <Td>{r.slug}</Td>
                    <Td className="text-right tabular-nums">{money(r.suggestedCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">Total: <strong className="tabular-nums">{money(demand?.suggestedTotalCents ?? 0)}</strong></p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDynConfirm(false)}>Cancel</Button>
            <Button size="sm" disabled={dynMut.isPending}
              onClick={() => dynMut.mutate({ totalCents: dynTotalCents, lookbackDays: 14 }, { onSuccess: () => setDynConfirm(false) })}>
              {dynMut.isPending ? 'Distributing…' : 'Confirm & distribute'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

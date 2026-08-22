'use client';

/**
 * Global ECONOMY editors (migration 0099) for the platform_superadmin console.
 *
 * UX grounded in the research for high-stakes multi-tenant admin controls:
 *  - SCOPE-FIRST: every section states its blast radius ("applies to all N active clients").
 *  - EXPLICIT INHERITANCE/LOCK: each field carries an Enforced / "Clients keep own" badge; enforcing a
 *    field is the "policy lock" that overrides every brand.
 *  - LIVE FEASIBILITY: an enforced pricing set is checked with the SAME checkFeasible the engine uses,
 *    both as a representative preview and per-brand (names the clients that would fall back).
 *  - POSITIVE FRICTION: saving opens a confirmation that names the affected population and shows the
 *    diff (which fields become enforced / un-enforced) before committing — System 1 → System 2.
 *  - RECOVERABILITY: config is versioned server-side; each section shows the live config version.
 */
import { useEffect, useMemo, useState } from 'react';
import { Section, Th, Td } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  COHORT_FIELD_SPECS, PAYMENT_FIELD_SPECS, COHORT_KEYS, PAYMENT_KEYS,
  applyCohortEconomy, cohortFeasibility,
  type CohortKey, type PaymentKey, type CohortEconomy, type PaymentsEconomy, type EconFieldSpec,
} from '@invest254/shared/globaleconomy';
import { DEFAULT_CONFIG, rtp, type GameConfig } from '@invest254/shared/config';
import type { SiteWithConfig } from '@/lib/platform/endpoints';
import type { UseMutationResult } from '@tanstack/react-query';

type SetCfg = UseMutationResult<unknown, unknown, Record<string, unknown>, unknown>;
type DraftField = { on: boolean; input: string };
type Draft = Record<string, DraftField>;

// ── value <-> display conversions (stored: pct 0..1, kes cents, x/int as-is) ──
function toDisplay(spec: EconFieldSpec, v: number): string {
  if (spec.kind === 'pct') return String(+(v * 100).toFixed(4));
  if (spec.kind === 'kes') return String(+(v / 100).toFixed(2));
  return String(v);
}
function toStored(spec: EconFieldSpec, input: string): number | null {
  const n = Number(input);
  if (input.trim() === '' || !Number.isFinite(n)) return null;
  if (spec.kind === 'pct') return n / 100;
  if (spec.kind === 'kes') return Math.round(n * 100);
  if (spec.kind === 'int') return Math.round(n);
  return n; // x
}
function unit(spec: EconFieldSpec): string {
  return spec.kind === 'pct' ? '%' : spec.kind === 'kes' ? 'KES' : spec.kind === 'x' ? '×' : 's';
}

function draftFromBlock<K extends string>(keys: readonly K[], specs: Record<K, EconFieldSpec>, block: Partial<Record<K, { v: number; on: boolean }>>): Draft {
  const d: Draft = {};
  for (const k of keys) {
    const f = block[k];
    d[k] = f ? { on: f.on, input: toDisplay(specs[k], f.v) } : { on: false, input: '' };
  }
  return d;
}

/** Build the { key: {v,on} } patch block from a draft, and the enforced-only economy for feasibility. */
function buildBlock<K extends string>(keys: readonly K[], specs: Record<K, EconFieldSpec>, draft: Draft) {
  const patch: Record<string, { v: number; on: boolean }> = {};
  const enforced: Partial<Record<K, { v: number; on: boolean }>> = {};
  const errors: string[] = [];
  for (const k of keys) {
    const df = draft[k]!;
    const stored = toStored(specs[k], df.input);
    if (df.on) {
      if (stored === null) { errors.push(`${specs[k].label}: enter a value to enforce it`); continue; }
      // bounds mirror the DB validator / config.ts
      const s = specs[k];
      if (s.min !== undefined && stored < s.min) errors.push(`${s.label}: must be ≥ ${s.kind === 'pct' ? s.min * 100 + '%' : s.min}`);
      if (s.max !== undefined && stored > s.max) errors.push(`${s.label}: must be ≤ ${s.kind === 'pct' ? s.max * 100 + '%' : s.max}`);
      if (s.integer && !Number.isInteger(stored)) errors.push(`${s.label}: must be a whole number`);
      patch[k] = { v: stored, on: true };
      enforced[k as K] = { v: stored, on: true };
    } else if (stored !== null) {
      patch[k] = { v: stored, on: false }; // keep the value, not enforced
    }
  }
  return { patch, enforced, errors };
}

// Small accessible enforce switch.
function Toggle({ on, onChange, disabled, labelledBy }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; labelledBy?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-labelledby={labelledBy} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${on ? 'bg-accent' : 'bg-surface-2 border border-border'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function EnforceBadge({ on }: { on: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${on ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-muted'}`}>
      {on ? 'Enforced · all clients' : 'Clients keep own'}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cohort (player / marketer) economy section
// ─────────────────────────────────────────────────────────────────────────────────────────────
export function CohortEconomySection(props: {
  apiKey: 'player_economy' | 'marketer_economy';
  kind: 'players' | 'marketers';
  title: string;
  description: string;
  server: CohortEconomy;
  sites: SiteWithConfig[];
  version: number;
  setCfg: SetCfg;
}) {
  const { apiKey, kind, title, description, server, sites, version, setCfg } = props;
  const serverKey = JSON.stringify(server);
  const [draft, setDraft] = useState<Draft>(() => draftFromBlock(COHORT_KEYS, COHORT_FIELD_SPECS, server));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setDraft(draftFromBlock(COHORT_KEYS, COHORT_FIELD_SPECS, server)); }, [serverKey]);

  const built = useMemo(() => buildBlock(COHORT_KEYS, COHORT_FIELD_SPECS, draft), [draft]);
  const dirty = useMemo(() => JSON.stringify(draftFromBlock(COHORT_KEYS, COHORT_FIELD_SPECS, server)) !== JSON.stringify(draft), [serverKey, draft]);
  const enforcedCount = Object.values(built.enforced).length;
  const activeSites = useMemo(() => sites.filter((s) => s.status === 'active'), [sites]);

  // Representative feasibility (over DEFAULT_CONFIG) + per-brand fallback list.
  const preview = useMemo(() => cohortFeasibility(DEFAULT_CONFIG, built.enforced as CohortEconomy), [built.enforced]);
  const previewCfg = useMemo(() => applyCohortEconomy(DEFAULT_CONFIG, built.enforced as CohortEconomy), [built.enforced]);
  const infeasibleSites = useMemo(() => {
    if (enforcedCount === 0) return [] as string[];
    return activeSites
      .filter((s) => !cohortFeasibility(s.config as unknown as GameConfig, built.enforced as CohortEconomy).ok)
      .map((s) => s.name);
  }, [activeSites, built.enforced, enforcedCount]);

  function save() {
    if (built.errors.length) return;
    setCfg.mutate({ [apiKey]: built.patch }, { onSuccess: () => setConfirm(false) });
  }

  const setField = (k: CohortKey, patch: Partial<DraftField>) =>
    setDraft((d) => ({ ...d, [k]: { ...d[k]!, ...patch } }));

  return (
    <Section title={`${title} — game config when pool mode is OFF`}>
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-2xl text-xs text-muted">{description}</p>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">config v{version}</span>
        </div>

        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {COHORT_KEYS.map((k) => {
            const spec = COHORT_FIELD_SPECS[k];
            const df = draft[k]!;
            const id = `${apiKey}-${k}`;
            return (
              <div key={k} className="grid grid-cols-1 items-center gap-2 p-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span id={id} className="text-sm font-semibold text-fg">{spec.label}</span>
                    <EnforceBadge on={df.on} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{spec.hint}</p>
                </div>
                <div className="w-full sm:w-40">
                  <Input
                    inputMode="decimal"
                    aria-label={`${spec.label} value (${unit(spec)})`}
                    value={df.input}
                    onChange={(e) => setField(k, { input: e.target.value.replace(/[^0-9.]/g, '') })}
                    trailing={<span className="pr-1 text-xs text-muted">{unit(spec)}</span>}
                    placeholder="—"
                  />
                </div>
                <div className="flex items-center justify-end gap-2 sm:pl-2">
                  <span className="text-[11px] text-muted">Enforce</span>
                  <Toggle on={df.on} labelledBy={id} disabled={setCfg.isPending} onChange={(v) => setField(k, { on: v })} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Live feasibility read-out */}
        {enforcedCount > 0 && (
          <div className={`rounded-xl border p-3 text-xs ${preview.ok ? 'border-up/40 bg-up/5' : 'border-warn/40 bg-warn/5'}`}>
            <p className="font-medium">
              {preview.ok
                ? `✓ Feasible — RTP ${(rtp(previewCfg) * 100).toFixed(1)}%, mean winning multiple ≈ ×${preview.requiredMeanWinMultiplier.toFixed(2)}`
                : `⚠ Infeasible in isolation: ${preview.reason}`}
            </p>
            {infeasibleSites.length > 0 && (
              <p className="mt-1 text-warn">
                {infeasibleSites.length} client{infeasibleSites.length === 1 ? '' : 's'} would become infeasible and KEEP their own economy for the pricing fields (safe fallback): {infeasibleSites.join(', ')}.
              </p>
            )}
          </div>
        )}
        {built.errors.length > 0 && (
          <ul className="rounded-xl border border-down/40 bg-down/5 p-3 text-xs text-down">
            {built.errors.map((e, i) => <li key={i}>• {e}</li>)}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {enforcedCount === 0 ? 'Nothing enforced — every client keeps its own economy.'
              : `${enforcedCount} field${enforcedCount === 1 ? '' : 's'} enforced across all ${activeSites.length} active client${activeSites.length === 1 ? '' : 's'}.`}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!dirty || setCfg.isPending}
              onClick={() => setDraft(draftFromBlock(COHORT_KEYS, COHORT_FIELD_SPECS, server))}>Reset</Button>
            <Button size="sm" disabled={!dirty || built.errors.length > 0 || setCfg.isPending}
              onClick={() => setConfirm(true)}>Review &amp; save</Button>
          </div>
        </div>
      </Card>

      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Apply ${title.toLowerCase()} to all clients?`}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            These changes take effect for <strong className="text-fg">{kind}</strong> on the statistical (pool-off) path across{' '}
            <strong className="text-fg">all {activeSites.length} active client{activeSites.length === 1 ? '' : 's'}</strong>. Enforced fields override each brand&apos;s own config and per-user overrides.
          </p>
          <div className="max-h-56 overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead><tr><Th>Field</Th><Th>Value</Th><Th>State</Th></tr></thead>
              <tbody>
                {COHORT_KEYS.map((k) => {
                  const spec = COHORT_FIELD_SPECS[k]; const df = draft[k]!;
                  const stored = toStored(spec, df.input);
                  return (
                    <tr key={k} className="border-t border-border">
                      <Td>{spec.label}</Td>
                      <Td className="tabular-nums">{stored === null ? '—' : `${df.input}${unit(spec)}`}</Td>
                      <Td>{df.on ? <span className="text-accent">Enforced</span> : <span className="text-muted">Off</span>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {infeasibleSites.length > 0 && (
            <p className="rounded-lg border border-warn/40 bg-warn/5 p-2 text-xs text-warn">
              ⚠ {infeasibleSites.join(', ')} would keep their own pricing (fallback) because the enforced set is infeasible against their base config.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button size="sm" disabled={setCfg.isPending} onClick={save}>
              {setCfg.isPending ? 'Saving…' : `Enforce for all ${activeSites.length} clients`}
            </Button>
          </div>
        </div>
      </Modal>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payments section (min/max deposit + min withdrawal)
// ─────────────────────────────────────────────────────────────────────────────────────────────
export function PaymentsEconomySection(props: { server: PaymentsEconomy; activeCount: number; setCfg: SetCfg }) {
  const { server, activeCount, setCfg } = props;
  const serverKey = JSON.stringify(server);
  const [draft, setDraft] = useState<Draft>(() => draftFromBlock(PAYMENT_KEYS, PAYMENT_FIELD_SPECS, server));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setDraft(draftFromBlock(PAYMENT_KEYS, PAYMENT_FIELD_SPECS, server)); }, [serverKey]);

  const built = useMemo(() => buildBlock(PAYMENT_KEYS, PAYMENT_FIELD_SPECS, draft), [draft]);
  const dirty = useMemo(() => JSON.stringify(draftFromBlock(PAYMENT_KEYS, PAYMENT_FIELD_SPECS, server)) !== JSON.stringify(draft), [serverKey, draft]);
  const enforcedCount = Object.values(built.enforced).length;

  // Cross-field: max deposit (if enforced) must be ≥ min deposit (if enforced).
  const crossErr = useMemo(() => {
    const mn = built.enforced.minDepositCents?.v; const mx = built.enforced.maxDepositCents?.v;
    return mn != null && mx != null && mx < mn ? 'Max deposit must be ≥ min deposit.' : null;
  }, [built.enforced]);

  const setField = (k: PaymentKey, patch: Partial<DraftField>) => setDraft((d) => ({ ...d, [k]: { ...d[k]!, ...patch } }));
  function save() {
    if (built.errors.length || crossErr) return;
    setCfg.mutate({ payments: built.patch }, { onSuccess: () => setConfirm(false) });
  }

  return (
    <Section title="Payments — applies to every client">
      <Card className="flex flex-col gap-4">
        <p className="max-w-2xl text-xs text-muted">
          Platform-wide payment limits. An enforced value overrides every brand (min deposit was a fixed
          KES 200 before this console). Leave a field un-enforced to keep the existing behaviour.
        </p>
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {PAYMENT_KEYS.map((k) => {
            const spec = PAYMENT_FIELD_SPECS[k]; const df = draft[k]!; const id = `payments-${k}`;
            return (
              <div key={k} className="grid grid-cols-1 items-center gap-2 p-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span id={id} className="text-sm font-semibold text-fg">{spec.label}</span>
                    <EnforceBadge on={df.on} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{spec.hint}</p>
                </div>
                <div className="w-full sm:w-40">
                  <Input inputMode="decimal" aria-label={`${spec.label} (KES)`} value={df.input}
                    onChange={(e) => setField(k, { input: e.target.value.replace(/[^0-9.]/g, '') })}
                    trailing={<span className="pr-1 text-xs text-muted">KES</span>} placeholder="—" />
                </div>
                <div className="flex items-center justify-end gap-2 sm:pl-2">
                  <span className="text-[11px] text-muted">Enforce</span>
                  <Toggle on={df.on} labelledBy={id} disabled={setCfg.isPending} onChange={(v) => setField(k, { on: v })} />
                </div>
              </div>
            );
          })}
        </div>
        {(built.errors.length > 0 || crossErr) && (
          <ul className="rounded-xl border border-down/40 bg-down/5 p-3 text-xs text-down">
            {built.errors.map((e, i) => <li key={i}>• {e}</li>)}
            {crossErr && <li>• {crossErr}</li>}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {enforcedCount === 0 ? 'Nothing enforced — brands use their existing limits.' : `${enforcedCount} limit${enforcedCount === 1 ? '' : 's'} enforced across all ${activeCount} clients.`}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!dirty || setCfg.isPending}
              onClick={() => setDraft(draftFromBlock(PAYMENT_KEYS, PAYMENT_FIELD_SPECS, server))}>Reset</Button>
            <Button size="sm" disabled={!dirty || built.errors.length > 0 || !!crossErr || setCfg.isPending}
              onClick={() => setConfirm(true)}>Review &amp; save</Button>
          </div>
        </div>
      </Card>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Apply payment limits to all clients?">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Enforced limits override every brand&apos;s deposit/withdrawal floors across <strong className="text-fg">all {activeCount} active clients</strong>.</p>
          <div className="rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead><tr><Th>Limit</Th><Th>Value</Th><Th>State</Th></tr></thead>
              <tbody>
                {PAYMENT_KEYS.map((k) => {
                  const spec = PAYMENT_FIELD_SPECS[k]; const df = draft[k]!; const stored = toStored(spec, df.input);
                  return (
                    <tr key={k} className="border-t border-border">
                      <Td>{spec.label}</Td>
                      <Td className="tabular-nums">{stored === null ? '—' : `KES ${df.input}`}</Td>
                      <Td>{df.on ? <span className="text-accent">Enforced</span> : <span className="text-muted">Off</span>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button size="sm" disabled={setCfg.isPending} onClick={save}>{setCfg.isPending ? 'Saving…' : 'Enforce for all clients'}</Button>
          </div>
        </div>
      </Modal>
    </Section>
  );
}

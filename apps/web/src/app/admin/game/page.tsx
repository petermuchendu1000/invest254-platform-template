'use client';

import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatRelativeTime } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
// Subpath import on purpose: the package barrel re-exports prng.ts, which imports
// node:crypto and cannot be bundled for the browser. config.ts is dependency-free.
import { checkFeasible } from '@invest254/shared/config';

// Display formatters that never throw on a missing/instant-stale field. The admin
// panel must stay usable even if it briefly talks to an API build that predates a
// derived field (e.g. requiredMeanWinMultiplier) — we recompute from the raw knobs
// the API has always returned (houseEdge / targetWinRate) rather than trusting the
// derived echo, and render an em-dash for anything non-finite.
const fmtPct = (x: number): string => (Number.isFinite(x) ? (x * 100).toFixed(2) : '—');
const fmtMult = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');
import { PageHeader, Section, TableWrap, Th, Td, Empty, ConfirmButton } from '@/components/admin/ui';
import { useGameConfig, useUpdateGameConfig, useWithdrawalPool, useSetWithdrawalPool } from '@/lib/admin/hooks';
import { SuperadminOnly } from '@/components/admin/SuperadminOnly';
import type { GameConfigPatch, GameConfigRow } from '@/lib/admin/types';

// Editable engine knobs. `kes` fields are cents edited in KES; `pct` fields are fractions
// (0–1) edited as a percentage (0–100) so an operator types "75", not "0.75".
type FieldKey = keyof GameConfigPatch;
const FIELDS: { key: FieldKey; label: string; hint: string; kes?: boolean; pct?: boolean; step?: string }[] = [
  { key: 'targetWinRate', label: 'Win rate (%)', hint: 'Share of rounds a player wins. Type a percentage — e.g. 75 means players win 75% of the time.', pct: true, step: '1' },
  { key: 'houseEdge', label: 'House edge (%)', hint: 'The house margin. Type a percentage — e.g. 10. Players get back 100% − house edge over time.', pct: true, step: '0.5' },
  { key: 'minStakeCents', label: 'Min stake (KES)', hint: 'Smallest stake a player can place', kes: true, step: '1' },
  { key: 'maxStakeCents', label: 'Max stake (KES)', hint: 'Largest stake a player can place', kes: true, step: '1' },
  { key: 'minWithdrawalCents', label: 'Min withdrawal (KES)', hint: 'Smallest amount a player can withdraw. Requests below this are rejected.', kes: true, step: '1' },
  { key: 'defaultDurationS', label: 'Round duration (s)', hint: 'How long a round lasts, in seconds (1–3600)', step: '1' },
  { key: 'maxMultiplier', label: 'Max payout multiple (×)', hint: 'Hard cap on a single winning round payout', step: '0.1' },
  { key: 'driftBias', label: 'Drift bias (advanced)', hint: 'Directional bias of the price walk (−1 to 1). Leave as-is unless you know why.', step: '0.001' },
  { key: 'volatility', label: 'Volatility (advanced)', hint: 'Amplitude of price movement (> 0). Leave as-is unless you know why.', step: '0.001' },
  { key: 'tickRateMs', label: 'Tick rate (ms) (advanced)', hint: 'Price update interval, 50–60000 ms', step: '10' },
];

/** Current config value formatted for its input (cents → KES; fraction → percent). */
function toField(cfg: GameConfigRow, f: (typeof FIELDS)[number]): string {
  const raw = cfg[f.key] as number;
  if (f.kes) return String(raw / 100);
  if (f.pct) return String(Math.round(raw * 1000) / 10); // 0.75 -> 75 (1dp)
  return String(raw);
}

function GameBody() {
  const cfgQ = useGameConfig();
  const update = useUpdateGameConfig();
  const toast = useToast();
  const [form, setForm] = useState<Record<string, string>>({});

  // Hydrate the form once config arrives (and after a successful save).
  const cfg = cfgQ.data;
  useEffect(() => {
    if (cfg) setForm(Object.fromEntries(FIELDS.map((f) => [f.key, toField(cfg, f)])));
  }, [cfg]);

  // Only send fields the operator actually changed.
  const patch = useMemo<GameConfigPatch>(() => {
    if (!cfg) return {};
    const out: Record<string, number> = {};
    for (const f of FIELDS) {
      const cur = form[f.key];
      if (cur === undefined || cur === '') continue;
      const next = f.kes ? Math.round(Number(cur) * 100) : f.pct ? Number(cur) / 100 : Number(cur);
      if (!Number.isFinite(next)) continue;
      if (next !== (cfg[f.key] as number)) out[f.key] = next;
    }
    return out as GameConfigPatch;
  }, [form, cfg]);

  const dirtyCount = Object.keys(patch).length;

  /**
   * Preview the economics of the pending edit using the SAME rule the database CHECK and the
   * engine's hot-reload guard apply. RTP / targetWinRate is the mean multiple winners must be
   * paid, and it has to land in (1, maxMultiplier] or the settlement calibrator cannot solve
   * -- so we block the save here instead of letting the operator discover it as a 400.
   */
  const preview = useMemo(() => {
    if (!cfg) return null;
    const merged = { ...cfg, ...patch };
    return checkFeasible({
      houseEdge: merged.houseEdge,
      maxMultiplier: merged.maxMultiplier,
      minStakeCents: merged.minStakeCents,
      maxStakeCents: merged.maxStakeCents,
      minWithdrawalCents: merged.minWithdrawalCents,
      defaultDurationS: merged.defaultDurationS,
      tickRateMs: merged.tickRateMs,
      driftBias: merged.driftBias,
      volatility: merged.volatility,
      targetWinRate: merged.targetWinRate,
    });
  }, [cfg, patch]);
  const blocked = !!preview && !preview.ok;
  const pendingRtp = cfg ? 1 - Number(({ ...cfg, ...patch }).houseEdge) : 0;

  // Derive the live economics from the raw knobs so a stale/partial API payload can never
  // white-screen this page (issue: `.toFixed` on an undefined derived field). See fmt* above.
  const liveHouseEdge = Number(cfg?.houseEdge);
  const liveTargetWinRate = Number(cfg?.targetWinRate);
  const liveRtp = Number.isFinite(liveHouseEdge) ? 1 - liveHouseEdge : NaN;
  const liveMeanWin = Number.isFinite(liveRtp) && liveTargetWinRate > 0 ? liveRtp / liveTargetWinRate : NaN;
  const liveVersion = Number(cfg?.version);

  function save() {
    update.mutate(patch as Record<string, number>, {
      onSuccess: (next) => toast.push({ tone: 'success', title: `Game config updated (v${next.version})`, description: `${dirtyCount} field(s) live on the next round.` }),
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <>
      <PageHeader
        title="Game configuration"
        subtitle="Live engine parameters, read straight from the database by the game engine. Win rate and house edge are entered as percentages. Saving bumps the config version and applies on the next round; trades already open keep the parameters they were priced with."
      />

      <Section title="Engine parameters">
        {cfgQ.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : cfgQ.isError || !cfg ? (
          <Empty title="Couldn't load game config" description="Try again shortly." />
        ) : (
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
              <span>
                RTP target: <span className="font-medium text-fg tabular-nums">{fmtPct(liveRtp)}%</span>
              </span>
              <span>
                Live version: <span className="font-medium text-fg tabular-nums">v{Number.isFinite(liveVersion) ? liveVersion : '—'}</span>
              </span>
              <span>
                Mean winning multiple:{' '}
                <span className="font-medium text-fg tabular-nums">{fmtMult(liveMeanWin)}x</span>
              </span>
              <span>
                Last updated:{' '}
                <span className="font-medium text-fg">
                  {cfg.updatedAtMs ? `${formatRelativeTime(cfg.updatedAtMs)} ago` : '—'}
                  {cfg.updatedBy ? ` by ${cfg.updatedBy.slice(0, 8)}…` : ''}
                </span>
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <Input
                  key={f.key}
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  label={f.label}
                  hint={f.hint}
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              ))}
            </div>
            {dirtyCount > 0 && preview ? (
              <div
                className={
                  blocked
                    ? 'rounded-xl border border-down/40 bg-down/10 p-3 text-xs text-down'
                    : 'rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted'
                }
                role={blocked ? 'alert' : undefined}
              >
                {blocked ? (
                  <>
                    <span className="font-semibold">Cannot apply: </span>
                    {preview.reason}
                  </>
                ) : (
                  <>
                    After saving, RTP becomes{' '}
                    <span className="font-semibold text-fg tabular-nums">{fmtPct(pendingRtp)}%</span>, paid as a mean
                    winning multiple of{' '}
                    <span className="font-semibold text-fg tabular-nums">{fmtMult(preview.requiredMeanWinMultiplier)}x</span>.
                    Applies to the next round; trades already open keep the parameters they were priced with.
                  </>
                )}
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={dirtyCount === 0 || blocked || update.isPending}>
                {update.isPending ? 'Saving…' : blocked ? 'Invalid configuration' : dirtyCount > 0 ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'No changes'}
              </Button>
              {dirtyCount > 0 ? (
                <Button variant="ghost" onClick={() => cfg && setForm(Object.fromEntries(FIELDS.map((f) => [f.key, toField(cfg, f)])))}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Section>

      <WithdrawalPoolSection />
    </>
  );
}

function poolKes(c: number | undefined): string {
  return 'KES ' + ((c ?? 0) / 100).toLocaleString('en-KE');
}

function WithdrawalPoolSection() {
  const poolQ = useWithdrawalPool();
  const setPool = useSetWithdrawalPool();
  const toast = useToast();
  const [amountKes, setAmountKes] = useState('');
  const p = poolQ.data;
  useEffect(() => { if (p) setAmountKes(String((p.amountCents / 100))); }, [p?.amountCents]);

  function save() {
    const kes = Number(amountKes);
    if (!Number.isFinite(kes) || kes < 0) { toast.push({ tone: 'error', title: 'Invalid amount', description: 'Enter a non-negative KES amount.' }); return; }
    setPool.mutate({ amountCents: Math.round(kes * 100) }, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Daily pool set', description: `KES ${kes.toLocaleString('en-KE')} for today (EAT).` }),
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: e instanceof ApiError ? e.message : 'Try again.' }),
    });
  }

  return (
    <Section title="Daily withdrawal pool">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm text-muted">
          The maximum total winnings the house will pay out today (EAT midnight–midnight). Winnings can never exceed
          this; the engine paces it across the day. Set it every day — with no budget set, players cannot win.
        </p>
        {poolQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted">Budget</p>
                <p className="mt-0.5 font-mono text-sm text-fg">{poolKes(p?.amountCents)}</p>
              </div>
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted">Paid today</p>
                <p className="mt-0.5 font-mono text-sm text-fg">{poolKes(p?.paidCents)}</p>
              </div>
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted">Reserved</p>
                <p className="mt-0.5 font-mono text-sm text-fg">{poolKes(p?.reservedCents)}</p>
              </div>
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted">Available</p>
                <p className="mt-0.5 font-mono text-sm text-up">{poolKes(p?.availableCents)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-48">
                <Input label="Set today's budget (KES)" inputMode="decimal" value={amountKes}
                  onChange={(e) => setAmountKes(e.target.value.replace(/[^0-9.]/g, ''))} />
              </div>
              <ConfirmButton label="Set daily pool" confirmLabel="Confirm" busy={setPool.isPending} onConfirm={save} />
            </div>
            {p?.updatedAtMs ? (
              <p className="text-xs text-muted">
                Updated {formatRelativeTime(p.updatedAtMs)} ago{p.setBy ? ` by ${p.setBy.slice(0, 8)}…` : ''}.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Section>
  );
}

export default function GamePage() {
  return (
    <SuperadminOnly>
      <GameBody />
    </SuperadminOnly>
  );
}

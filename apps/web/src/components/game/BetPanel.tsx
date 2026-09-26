'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, kesToCents } from '@invest254/shared/money';
import type { Direction } from '@invest254/shared';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useStakeLimits } from '@/lib/game/useStakeLimits';
import { pillLabel } from '@/lib/game/stakeLadder';
import { useDisplayMoney } from '@/lib/money';
import { Skeleton } from '@/components/ui/Skeleton';
import { Segmented } from '@/components/ui/Segmented';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useWallet } from '@/lib/wallet/hooks';
import { useHydrated } from '@/lib/useHydrated';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { useBrand } from '@/lib/brand/BrandProvider';
import { LivePnl } from '@/components/game/LivePnl';

const DURATION_OPTIONS = [10, 30, 60, 120];
// Stepper granularity for the +/- buttons on the stake field (KES).
const STEP_KES = 50;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ceil2 = (n: number) => Math.ceil(n * 100) / 100;

export function BetPanel() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const pendingTrade = useDepositUi((s) => s.pending);
  const clearPending = useDepositUi((s) => s.clearPending);

  const brand = useBrand();
  const { fmt, both, symbol, isForeign, toDisplay, toKesCents, currency } = useDisplayMoney();
  // Quick stakes (STAKE-1): the first pills of the brand's ladder — the admin's minimum, ×2, ×4 —
  // every one a multiple of 5 in the brand currency.
  const limits = useStakeLimits();
  const chips = limits.ladder.slice(0, 3).map((v) => ({ key: v, value: v, label: `${isForeign ? symbol : ''}${pillLabel(v)}` }));
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });
  const { data: wallet } = useWallet();
  const { status, activePosition, openPosition, sell } = useGameSocket();

  const minStakeCents = limits.minCents;
  const maxStakeCents = limits.maxCents;
  const defaultDurationS = config?.defaultDurationS ?? 10;

  const [stake, setStake] = useState<string>('');
  const [durationS, setDurationS] = useState<number>(defaultDurationS);
  // The free-text stake field is hidden behind a "Custom" chip to give the chart more room.
  const [customOpen, setCustomOpen] = useState(false);
  // Direction the player picked before topping up. Purely informational: it drives the
  // "funds added" hint after a deposit settles. It never gates or re-fires the trade.
  const [resumeDir, setResumeDir] = useState<Direction | null>(null);

  // Seed the stake with the minimum pill ONCE when the limits load (BUGLOG #103: re-seeding whenever
  // the field was empty turned "delete, type 200" into "50200").
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !limits.ready) return;
    seededRef.current = true;
    if (stake === '') setStake(String(limits.min));
  }, [limits.ready, limits.min, stake]);
  useEffect(() => {
    if (config) setDurationS((d) => (d === 10 && defaultDurationS !== 10 ? defaultDurationS : d));
  }, [config, defaultDurationS]);

  const durations = useMemo(
    () => Array.from(new Set([...DURATION_OPTIONS, defaultDurationS])).sort((a, b) => a - b),
    [defaultDurationS],
  );

  const stakeCents = useMemo(() => {
    const n = Number.parseFloat(stake);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return isForeign ? toKesCents(n) : kesToCents(n);
  }, [stake, isForeign, toKesCents]);

  // Bonus funds are stakeable (bonus-first; migration 0094), so affordability counts real + bonus.
  // This is what lets a KES 200 welcome bonus + a small top-up reach the min stake.
  const spendable = (wallet?.real ?? 0) + (wallet?.bonus ?? 0);
  const validStake = Number.isInteger(stakeCents) && stakeCents >= minStakeCents;
  const overMax = maxStakeCents !== undefined && Number.isFinite(stakeCents) && stakeCents > maxStakeCents;
  const overBalance = !!token && Number.isFinite(stakeCents) && stakeCents > spendable;
  const connecting = status !== 'open';

  // Editing the stake invalidates the "funds added" hint from a previous top-up.
  useEffect(() => { setResumeDir(null); }, [stake]);

  // Resume after a top-up: once the deposit lands and the balance covers the saved trade,
  // surface a hint pointing at the direction the player originally picked. A single tap
  // places the trade -- we never auto-fire real money, and we never demand an extra tap.
  useEffect(() => {
    if (!pendingTrade || activePosition || status !== 'open') return;
    if (!Number.isFinite(spendable) || spendable < pendingTrade.stakeCents) return;
    setResumeDir(pendingTrade.direction);
    clearPending();
  }, [pendingTrade, activePosition, status, spendable, clearPending]);

  const errorHint = (() => {
    if (!Number.isFinite(stakeCents)) return null;
    if (!validStake) return `Min ${both(minStakeCents)}`;
    if (overMax && maxStakeCents !== undefined) return `Maximum stake is ${both(maxStakeCents)}.`;
    return null;
  })();

  function chipActive(value: number): boolean {
    const n = Number.parseFloat(stake);
    return Number.isFinite(n) && n === value;
  }

  function bumpStake(delta: number) {
    // KES brands step by whole KES (STEP_KES, snapped); foreign brands step by whole display units.
    const minU = isForeign ? ceil2(toDisplay(minStakeCents)) : centsToKes(minStakeCents);
    const cur = Number.parseFloat(stake);
    const base = Number.isFinite(cur) ? cur : minU;
    let next = isForeign ? round2(base + delta) : Math.round((base + delta) / STEP_KES) * STEP_KES;
    if (next < minU) next = minU;
    if (maxStakeCents !== undefined) {
      const maxU = isForeign ? Math.floor(toDisplay(maxStakeCents) * 100) / 100 : centsToKes(maxStakeCents);
      if (next > maxU) next = maxU;
    }
    setStake(String(next));
  }

  const durationOptions = useMemo(
    () => durations.map((d) => ({ id: String(d), label: d < 60 || d % 60 ? `${d}s` : `${d / 60}m` })),
    [durations],
  );

  function handleDirection(dir: Direction) {
    if (!validStake || overMax) return;
    // Business logic first: a logged-out tap is real buying intent. Open the deposit sheet
    // seeded with this stake (the sheet routes to sign up/login, then resumes the deposit),
    // so funding leads and the account is created along the way -- not the other way round.
    if (!token) {
      openDeposit({ amountCents: stakeCents, pending: { direction: dir, stakeCents } });
      return;
    }
    // Highest-intent moment: no/short balance -> convert the tap into a funded deposit, then resume.
    if (overBalance) {
      openDeposit({ amountCents: stakeCents, pending: { direction: dir, stakeCents } });
      return;
    }
    // One tap = one trade. No confirmation step: the stake is already explicit on screen,
    // the position is reversible via Cash Out, and every extra tap is measurable drop-off.
    openPosition({ stakeCents, direction: dir, durationS });
    setResumeDir(null);
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (!hydrated) {
    return (
      <Card className="flex flex-col gap-2.5 rounded-xl p-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-10 w-full" />
      </Card>
    );
  }

  // ── A position is in flight — live P&L + cash-out (single-open rule) ─────────
  if (activePosition) {
    const canCashOut =
      activePosition.phase === 'open' && activePosition.sellable && !!activePosition.positionId;
    return (
      <Card className="flex flex-col gap-2.5 rounded-xl p-3">
        <LivePnl pos={activePosition} />
        <Button variant="secondary" size="md" fullWidth className="!h-11" disabled={!canCashOut} onClick={sell}>
          {activePosition.phase === 'settling'
            ? 'Cashing out…'
            : canCashOut
              ? 'Cash Out'
              : 'Auto-sells at expiry'}
        </Button>
      </Card>
    );
  }

  // ── Idle — stake + duration + BUY/SELL (always visible) ──────────────────
  return (
    <Card className="flex flex-col gap-2.5 rounded-xl p-3">
      {/* Quick stakes + Custom. The free-text field only appears when Custom is tapped (space for the chart). */}
      <div className="grid grid-cols-4 gap-2">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => { setStake(String(chip.value)); setCustomOpen(false); }}
            className={cn(
              'h-11 rounded-xl border text-sm font-semibold tabular-nums transition lg:h-9 lg:rounded-lg',
              !customOpen && chipActive(chip.value)
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent/60',
            )}
          >
            {chip.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          aria-expanded={customOpen}
          className={cn(
            'h-11 rounded-xl border text-sm font-semibold transition lg:h-9 lg:rounded-lg',
            customOpen || !chips.some((c) => chipActive(c.value))
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-2 text-fg hover:border-accent/60',
          )}
        >
          Custom
        </button>
      </div>

      {customOpen ? (
      <label className="flex cursor-text items-center gap-2 rounded-xl border border-border bg-surface-2 py-1 pl-3 pr-1 transition focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        <span className="rounded-md bg-surface px-2 py-1 text-xs font-semibold text-muted">{symbol}</span>
        <input
          inputMode="decimal"
          autoFocus
          value={stake}
          onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          aria-label={`Stake amount in ${currency}`}
          className="h-11 w-full bg-transparent text-xl font-bold tabular-nums text-fg outline-none placeholder:text-muted"
        />
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Decrease stake"
            onClick={() => bumpStake(isForeign ? -1 : -STEP_KES)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface text-lg font-bold leading-none text-muted transition hover:text-fg lg:h-9 lg:w-9"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Increase stake"
            onClick={() => bumpStake(isForeign ? 1 : STEP_KES)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface text-lg font-bold leading-none text-muted transition hover:text-fg lg:h-9 lg:w-9"
          >
            +
          </button>
        </div>
      </label>
      ) : null}

      {errorHint ? <p className="text-xs text-down">{errorHint}</p> : null}

      {/* Auto-sell duration: every option visible, one tap (was a hidden tap-to-cycle circle). */}
      <Segmented label="Duration" value={String(durationS)} onChange={(v) => setDurationS(Number(v))} options={durationOptions} />

      {connecting ? (
        <p className="text-center text-xs text-muted">Connecting…</p>
      ) : null}

      {/* BUY / SELL — primary CTAs: largest, most saturated, gain/loss framed. */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="up"
          size="md"
          fullWidth
          className="!h-11 flex-col !gap-0 !text-sm"
          disabled={connecting}
          onClick={() => handleDirection('buy')}
        >
          <span className="flex items-center gap-1.5 font-bold">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            BUY
          </span>
        </Button>
        <Button
          variant="down"
          size="md"
          fullWidth
          className="!h-11 flex-col !gap-0 !text-sm"
          disabled={connecting}
          onClick={() => handleDirection('sell')}
        >
          <span className="flex items-center gap-1.5 font-bold">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4" aria-hidden>
              <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            SELL
          </span>
        </Button>
      </div>

      {resumeDir ? (
        <p className="text-center text-[11px] font-semibold tabular-nums text-up">{resumeDir === 'buy' ? 'BUY' : 'SELL'} · {fmt(stakeCents)}</p>
      ) : null}
    </Card>
  );
}

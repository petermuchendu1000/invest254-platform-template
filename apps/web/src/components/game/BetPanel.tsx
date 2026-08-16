'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { centsToKes, formatKes, kesToCents } from '@invest254/shared/money';
import type { Direction } from '@invest254/shared';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useWallet } from '@/lib/wallet/hooks';
import { useHydrated } from '@/lib/useHydrated';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { useBrand } from '@/lib/brand/BrandProvider';
import { WithdrawalProgress } from '@/components/wallet/WithdrawalProgress';
import { LivePnl } from '@/components/game/LivePnl';

const CHIP_CENTS = [25000, 50000, 75000, 100000];
const DURATION_OPTIONS = [10, 30, 60, 120];
// Stepper granularity for the +/- buttons on the stake field (KES).
const STEP_KES = 50;

export function BetPanel() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const openDeposit = useDepositUi((s) => s.openDeposit);
  const pendingTrade = useDepositUi((s) => s.pending);
  const clearPending = useDepositUi((s) => s.clearPending);

  const brand = useBrand();
  const { data: config } = useQuery({
    queryKey: ['gameConfig', brand.slug],
    queryFn: () => api.gameConfig(brand.slug),
    staleTime: 5 * 60_000,
  });
  const { data: wallet } = useWallet();
  const { status, activePosition, openPosition, sell } = useGameSocket();

  const minStakeCents = config?.minStakeCents ?? 25000;
  const maxStakeCents = config?.maxStakeCents;
  const defaultDurationS = config?.defaultDurationS ?? 10;

  const [stake, setStake] = useState<string>('');
  const [durationS, setDurationS] = useState<number>(defaultDurationS);
  // Direction the player picked before topping up. Purely informational: it drives the
  // "funds added" hint after a deposit settles. It never gates or re-fires the trade.
  const [resumeDir, setResumeDir] = useState<Direction | null>(null);

  // Seed the stake with a sensible default (KES 250) once config arrives, never below the minimum.
  useEffect(() => {
    if (stake === '') setStake(String(centsToKes(Math.max(minStakeCents, 25000))));
  }, [minStakeCents, stake]);
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
    return kesToCents(n);
  }, [stake]);

  const balanceReal = wallet?.real ?? 0;
  const validStake = Number.isInteger(stakeCents) && stakeCents >= minStakeCents;
  const overMax = maxStakeCents !== undefined && Number.isFinite(stakeCents) && stakeCents > maxStakeCents;
  const overBalance = !!token && Number.isFinite(stakeCents) && stakeCents > balanceReal;
  const connecting = status !== 'open';

  // Editing the stake invalidates the "funds added" hint from a previous top-up.
  useEffect(() => { setResumeDir(null); }, [stake]);

  // Resume after a top-up: once the deposit lands and the balance covers the saved trade,
  // surface a hint pointing at the direction the player originally picked. A single tap
  // places the trade -- we never auto-fire real money, and we never demand an extra tap.
  useEffect(() => {
    if (!pendingTrade || activePosition || status !== 'open') return;
    if (!Number.isFinite(balanceReal) || balanceReal < pendingTrade.stakeCents) return;
    setResumeDir(pendingTrade.direction);
    clearPending();
  }, [pendingTrade, activePosition, status, balanceReal, clearPending]);

  const errorHint = (() => {
    if (!Number.isFinite(stakeCents)) return null;
    if (!validStake) return `Minimum stake is ${formatKes(minStakeCents)}.`;
    if (overMax && maxStakeCents !== undefined) return `Maximum stake is ${formatKes(maxStakeCents)}.`;
    return null;
  })();

  function chipActive(c: number): boolean {
    const n = Number.parseFloat(stake);
    return Number.isFinite(n) && kesToCents(n) === c;
  }

  function bumpStake(deltaKes: number) {
    const minKes = centsToKes(minStakeCents);
    const cur = Number.parseFloat(stake);
    const base = Number.isFinite(cur) ? cur : minKes;
    let next = Math.round((base + deltaKes) / STEP_KES) * STEP_KES;
    if (next < minKes) next = minKes;
    if (maxStakeCents !== undefined && kesToCents(next) > maxStakeCents) next = centsToKes(maxStakeCents);
    setStake(String(next));
  }

  function cycleDuration() {
    const i = durations.indexOf(durationS);
    setDurationS(durations[(i + 1) % durations.length] ?? durations[0]!);
  }

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
        <p className="text-center text-[11px] text-muted">
          Trades settle automatically at the timer.
        </p>
      </Card>
    );
  }

  // ── Idle — stake + duration + BUY/SELL (always visible) ──────────────────
  return (
    <Card className="flex flex-col gap-2.5 rounded-xl p-3">
      {/* Goal-gradient: how close the player is to the withdrawal line (docs/25). */}
      {token ? <WithdrawalProgress realCents={balanceReal} minWithdrawalCents={config?.minWithdrawalCents ?? 0} /> : null}
      {/* Stake input with KES prefix + quick steppers */}
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
        <span className="rounded-md bg-surface px-2 py-1 text-xs font-semibold text-muted">KES</span>
        <input
          inputMode="decimal"
          value={stake}
          onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          aria-label="Stake amount in KES"
          className="h-11 w-full bg-transparent text-xl font-bold tabular-nums text-fg outline-none placeholder:text-muted"
        />
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Decrease stake"
            onClick={() => bumpStake(-STEP_KES)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-lg font-bold leading-none text-muted transition hover:text-fg"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Increase stake"
            onClick={() => bumpStake(STEP_KES)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-lg font-bold leading-none text-muted transition hover:text-fg"
          >
            +
          </button>
        </div>
      </div>

      {/* Quick chips */}
      <div className="grid grid-cols-4 gap-2">
        {CHIP_CENTS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setStake(String(centsToKes(c)))}
            className={cn(
              'h-10 rounded-lg border text-sm font-semibold tabular-nums transition',
              chipActive(c)
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent/60',
            )}
          >
            {centsToKes(c)}
          </button>
        ))}
      </div>

      {errorHint ? <p className="text-xs text-down">{errorHint}</p> : null}

      {/* Auto-sell duration + idle Live P&L */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3 py-1.5">
        <button type="button" onClick={cycleDuration} className="flex items-center gap-3" aria-label="Cycle trade duration">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-accent text-xs font-bold tabular-nums text-accent">
            {durationS}
          </span>
          <span className="flex flex-col text-left leading-tight">
            <span className="text-[10px] uppercase tracking-wide text-muted">Auto-sell</span>
            <span className="text-xs text-fg">Trade duration</span>
          </span>
        </button>
        <div className="flex flex-col items-end leading-tight">
          <span className="text-[10px] uppercase tracking-wide text-muted">Live P&amp;L</span>
          <Money cents={0} className="text-sm font-semibold text-fg" />
        </div>
      </div>

      {connecting ? (
        <p className="text-center text-xs text-muted">Connecting to the live market…</p>
      ) : null}

      {/* BUY / SELL — primary CTAs: largest, most saturated, gain/loss framed. */}
      <div className="grid grid-cols-2 gap-2.5">
        <Button
          variant="up"
          size="md"
          fullWidth
          className="!h-14 flex-col !gap-0.5 !text-base"
          disabled={connecting}
          onClick={() => handleDirection('buy')}
        >
          <span className="flex items-center gap-1.5 font-bold">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            BUY
          </span>
          <span className="text-[10px] font-medium opacity-90">Price rises</span>
        </Button>
        <Button
          variant="down"
          size="md"
          fullWidth
          className="!h-14 flex-col !gap-0.5 !text-base"
          disabled={connecting}
          onClick={() => handleDirection('sell')}
        >
          <span className="flex items-center gap-1.5 font-bold">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4" aria-hidden>
              <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            SELL
          </span>
          <span className="text-[10px] font-medium opacity-90">Price falls</span>
        </Button>
      </div>

      {resumeDir ? (
        <p className="text-center text-[11px] font-medium text-up">
          Funds added — tap {resumeDir === 'buy' ? 'BUY' : 'SELL'} to place your {formatKes(stakeCents)} trade.
        </p>
      ) : !token ? (
        <p className="text-center text-[11px] text-muted">Deposit to buy or sell.</p>
      ) : overBalance ? (
        <p className="text-center text-[11px] text-warn">Not enough balance — tap BUY or SELL to add money and trade.</p>
      ) : null}
    </Card>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { formatKes } from '@invest254/shared/money';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { useWallet } from '@/lib/wallet/hooks';
import { useDepositUi } from '@/lib/wallet/depositUi';
import { useCountUp } from '@/lib/useCountUp';
import { BALANCE_BUMP_EVENT } from '@/lib/game/outcomeFx';

/**
 * Top-bar balance. Tapping it opens the wallet sheet on the Withdraw tab (the natural intent
 * when you tap "your money"); a one-tap toggle switches to Deposit. Always visible when signed in.
 *
 * When funds land (balance increases), the amount counts up and the pill pulses — the terminal
 * of the "money flying into balance" reward cue dispatched by the OutcomeOverlay.
 */
export function BalancePill() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const { data } = useWallet();
  const openWithdraw = useDepositUi((s) => s.openWithdraw);

  const real = data?.real ?? 0;
  const shown = useCountUp(real, 700, real);
  const [bump, setBump] = useState(false);
  const prevRef = useRef(real);

  // Pulse when the OutcomeOverlay's payout chip arrives, or on any balance increase.
  useEffect(() => {
    const trigger = () => {
      setBump(false);
      requestAnimationFrame(() => setBump(true));
      setTimeout(() => setBump(false), 750);
    };
    window.addEventListener(BALANCE_BUMP_EVENT, trigger);
    return () => window.removeEventListener(BALANCE_BUMP_EVENT, trigger);
  }, []);

  useEffect(() => {
    if (real > prevRef.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 750);
      prevRef.current = real;
      return () => clearTimeout(t);
    }
    prevRef.current = real;
  }, [real]);

  if (!hydrated || !token || !data) return null;

  return (
    <button
      id="balance-pill"
      type="button"
      onClick={openWithdraw}
      aria-label="Open wallet"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-sm font-semibold tabular-nums text-fg transition hover:border-accent',
        bump && 'pp-balance-bump',
      )}
    >
      <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
      {formatKes(Math.round(shown))}
    </button>
  );
}

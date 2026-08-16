'use client';

import { formatKes } from '@invest254/shared/money';

/**
 * Goal-gradient UI (docs/25): a persistent progress bar toward the minimum-withdrawal line, so the
 * player always sees "how close" they are to cashing out. Combined with the engine's near-miss lever
 * (which holds balances just below the line), this is the core retention loop — the bar creeps to
 * ~90-98%, a trade settles just short, and the player chases / redeposits to "finish".
 */
export function WithdrawalProgress({ realCents, minWithdrawalCents }: { realCents: number; minWithdrawalCents: number }) {
  if (!minWithdrawalCents || minWithdrawalCents <= 0) return null;
  const pct = Math.max(0, Math.min(100, (realCents / minWithdrawalCents) * 100));
  const remaining = Math.max(0, minWithdrawalCents - realCents);
  const reached = realCents >= minWithdrawalCents;
  const close = pct >= 80 && !reached;
  return (
    <div className="rounded-brand border border-border bg-surface-2/40 px-3 py-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{reached ? 'Ready to cash out' : 'Progress to cash out'}</span>
        <span className={close ? 'font-semibold text-warn' : 'text-fg'}>
          {formatKes(realCents)} <span className="text-muted">/</span> {formatKes(minWithdrawalCents)}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface">
        <div
          className={`h-full rounded-full transition-all duration-500 ${reached ? 'bg-up' : close ? 'bg-warn' : 'bg-brand'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-center text-[11px] text-muted">
        {reached
          ? 'You can withdraw now.'
          : close
            ? `So close — just ${formatKes(remaining)} to withdraw!`
            : `${pct.toFixed(0)}% there • ${formatKes(remaining)} to go`}
      </p>
    </div>
  );
}

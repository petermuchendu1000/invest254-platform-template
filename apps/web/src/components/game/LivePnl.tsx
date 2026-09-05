'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { DisplayMoney as Money } from '@/lib/money';
import type { ActivePosition } from '@/lib/game/betting';

/**
 * Live multiplier + P&L + countdown for the open position. The countdown is
 * driven locally from `expiresAtMs` (smooth, decoupled from the network tick
 * rate); `liveMultiplier`/`livePnlCents` come from `position_update`.
 */
export function LivePnl({ pos }: { pos: ActivePosition }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const totalMs = pos.durationS * 1000;
  const remainingMs = pos.expiresAtMs ? Math.max(0, pos.expiresAtMs - now) : totalMs;
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 0;
  const secs = Math.ceil(remainingMs / 1000);
  const isBuy = pos.direction === 'buy';
  const pnlUp = pos.livePnlCents >= 0;

  const phaseLabel =
    pos.phase === 'pending' ? 'Opening…' : pos.phase === 'settling' ? 'Cashing out…' : `${secs}s left`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold',
            isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
          )}
        >
          {isBuy ? 'BUY' : 'SELL'} · ×{pos.liveMultiplier.toFixed(2)}
        </span>
        <span className="tabular-nums text-xs text-muted">{phaseLabel}</span>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex flex-col">
          <span className="text-xs text-muted">{'Live P&L'}</span>
          <Money
            cents={pos.livePnlCents}
            className={cn('text-2xl font-bold', pnlUp ? 'text-up' : 'text-down')}
          />
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs text-muted">Stake</span>
          <Money cents={pos.stakeCents} className="font-medium" />
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-100 ease-linear',
            isBuy ? 'bg-up' : 'bg-down',
          )}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

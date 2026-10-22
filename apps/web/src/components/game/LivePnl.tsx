'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { DisplayMoney as Money } from '@/lib/money';
import { useMarketerSkin } from '@/lib/marketer/isMarketer';
import { MK } from '@/lib/marketer/labels';
import type { ActivePosition } from '@/lib/game/betting';

/**
 * Live multiplier + P&L + countdown for the open position. The countdown is
 * driven locally from `expiresAtMs` (smooth, decoupled from the network tick
 * rate); `liveMultiplier`/`livePnlCents` come from `position_update`.
 */
export function LivePnl({ pos }: { pos: ActivePosition }) {
  const { isMarketer } = useMarketerSkin();
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
    // "Cashing out" implied money leaving the platform; closing a trade only returns the payout to
    // the in-app balance (the demo balance on a Demo account). Same vocabulary as the button.
    pos.phase === 'pending' ? 'Opening…' : pos.phase === 'settling' ? 'Closing…' : `${secs}s left`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
            // MARKETER: direction is shown by the arrow only — one neutral accent, no green/red.
            isMarketer ? 'bg-accent/15 text-accent' : isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
          )}
        >
          {/* MARKETER: wordless arrow instead of BUY/SELL. */}
          {isMarketer ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5" role="img" aria-label={isBuy ? 'Up' : 'Down'}>
              <path d={isBuy ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7'} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            `${isBuy ? 'BUY' : 'SELL'} · `
          )}
          ×{pos.liveMultiplier.toFixed(2)}
        </span>
        <span className="tabular-nums text-xs text-muted">{phaseLabel}</span>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex flex-col">
          <span className="text-xs text-muted">{isMarketer ? MK.liveValue : 'Live P&L'}</span>
          <Money
            cents={pos.livePnlCents}
            className={cn('text-2xl font-bold', pnlUp ? 'text-up' : 'text-down')}
          />
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs text-muted">{isMarketer ? MK.cost : 'Stake'}</span>
          <Money cents={pos.stakeCents} className="font-medium" />
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-100 ease-linear',
            isMarketer ? 'bg-accent' : isBuy ? 'bg-up' : 'bg-down',
          )}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

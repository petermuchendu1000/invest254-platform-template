'use client';

import { useEffect, useRef, useState } from 'react';
import { formatKes } from '@invest254/shared/money';

/**
 * Goal-gradient UI (docs/25): a persistent progress bar toward the minimum-withdrawal line, so the
 * player always sees "how close" they are to cashing out. Combined with the engine's near-miss lever
 * (which holds balances just below the line), this is the core retention loop — the bar creeps to
 * ~90-98%, a trade settles just short, and the player chases / redeposits to "finish".
 *
 * Celebratory near-miss FX (research: variable-reward + goal-gradient + loss-frustration):
 *  - rising edge into the ≥90% band fires a one-shot "SO CLOSE!" pulse (anticipation dopamine);
 *  - a peak memory ("you reached X% earlier") reinforces the frustration after a settle drops the
 *    balance just short of the line — the strongest redeposit trigger.
 */
export function WithdrawalProgress({ realCents, minWithdrawalCents }: { realCents: number; minWithdrawalCents: number }) {
  const prevPctRef = useRef(0);
  const peakPctRef = useRef(0);
  const [flash, setFlash] = useState(false);

  const valid = minWithdrawalCents > 0;
  const pct = valid ? Math.max(0, Math.min(100, (realCents / minWithdrawalCents) * 100)) : 0;
  const reached = valid && realCents >= minWithdrawalCents;

  useEffect(() => {
    if (!valid) return;
    const prev = prevPctRef.current;
    prevPctRef.current = pct;
    peakPctRef.current = Math.max(peakPctRef.current, pct);
    // rising edge into the near-miss band -> celebratory anticipation pulse
    if (pct >= 90 && pct < 100 && prev < 90) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 2600);
      return () => clearTimeout(t);
    }
  }, [pct, valid]);

  if (!valid) return null;

  const remaining = Math.max(0, minWithdrawalCents - realCents);
  const close = pct >= 80 && !reached;
  const peakPct = peakPctRef.current;
  // "you were almost there" — only when they've fallen back from a genuine near-miss peak
  const droppedFromPeak = !reached && !close && peakPct >= 85 && peakPct - pct >= 8;

  return (
    <div className={`relative overflow-hidden rounded-brand border px-3 py-2 transition-colors duration-300 ${flash ? 'border-warn bg-warn/10' : 'border-border bg-surface-2/40'}`}>
      {flash ? (
        <span className="pointer-events-none absolute right-2 top-1.5 animate-bounce rounded-full bg-warn px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-black shadow">
          So close! 🔥
        </span>
      ) : null}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{reached ? 'Ready to cash out' : 'Progress to cash out'}</span>
        <span className={close ? 'font-semibold text-warn' : 'text-fg'}>
          {formatKes(realCents)} <span className="text-muted">/</span> {formatKes(minWithdrawalCents)}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface">
        <div
          className={`h-full rounded-full transition-all duration-500 ${reached ? 'bg-up' : close ? 'bg-warn' : 'bg-brand'} ${flash ? 'animate-pulse' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`mt-1 text-center text-[11px] ${close ? 'font-semibold text-warn' : 'text-muted'}`}>
        {reached
          ? 'You can withdraw now.'
          : close
            ? `So close — just ${formatKes(remaining)} to withdraw!`
            : droppedFromPeak
              ? `You reached ${peakPct.toFixed(0)}% earlier — so close! Just ${formatKes(remaining)} to go.`
              : `${pct.toFixed(0)}% there • ${formatKes(remaining)} to go`}
      </p>
    </div>
  );
}

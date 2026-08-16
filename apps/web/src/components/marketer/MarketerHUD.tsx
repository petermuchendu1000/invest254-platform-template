'use client';

import { useEffect, useRef, useState } from 'react';
import { formatKes } from '@invest254/shared/money';
import { useSession } from '@/lib/auth/session';
import { useMarketerLiveSummary } from '@/lib/affiliate/hooks';

/**
 * Hidden, marketer-only live performance HUD.
 *
 * Requirement: a marketer must be able to check their realtime performance while using the normal
 * player app during a live session, WITHOUT a visible button a watching player could notice.
 *
 * Design:
 *  - Renders NOTHING for non-marketer accounts, so a player on their own device has no entry point.
 *  - For a marketer, the only entry point is an invisible long-press hotspot in the top-left corner
 *    (where the logo sits). A quick tap does nothing; a deliberate ~650ms long-press opens the sheet.
 *    There is no icon, label, or highlight — a shoulder-surfing player sees nothing.
 *  - The sheet polls the marketer summary every 5s (realtime) and shows today's numbers first.
 */
export function MarketerHUD() {
  const role = useSession((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only marketers get any behaviour at all.
  const isMarketer = role === 'marketer';

  const q = useMarketerLiveSummary(open && isMarketer);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!isMarketer) return null;

  const startPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 650);
  };
  const cancelPress = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  const s = q.data;
  return (
    <>
      {/* Invisible long-press hotspot — top-left corner, above the header. No visual footprint. */}
      <div
        onPointerDown={startPress}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => e.preventDefault()}
        aria-hidden
        className="fixed left-0 top-0 z-[60] h-11 w-11"
        style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'none' }}
      />

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md rounded-t-3xl border border-border bg-surface p-5 shadow-2xl sm:rounded-3xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-up" />
                </span>
                <h2 className="text-base font-semibold text-fg">Your performance · live</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted hover:text-fg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {q.isLoading && !s ? (
              <div className="h-40 animate-pulse rounded-2xl bg-surface-2" />
            ) : q.isError || !s ? (
              <p className="py-8 text-center text-sm text-muted">Couldn&apos;t load your performance. Try again shortly.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Today (the realtime numbers a marketer cares about mid-session). */}
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Today</p>
                  <div className="grid grid-cols-3 gap-2">
                    <HudStat label="Earnings" value={formatKes(s.commissionTodayCents)} tone="up" />
                    <HudStat label="New players" value={String(s.referralsToday)} />
                    <HudStat label="Active" value={String(s.activePlayersToday)} />
                  </div>
                </div>

                {/* All-time / balance. */}
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">All time</p>
                  <div className="grid grid-cols-3 gap-2">
                    <HudStat label="Referrals" value={String(s.totalReferrals)} />
                    <HudStat label="Active 7d" value={String(s.activePlayers7d)} />
                    <HudStat label="Earned" value={formatKes(s.commissionAccruedCents + s.commissionPaidCents)} />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-up/30 bg-up/5 px-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-[11px] uppercase tracking-wide text-muted">Available to withdraw</span>
                    <span className="text-lg font-bold text-up tabular-nums">{formatKes(s.availableCents)}</span>
                  </div>
                  <span className="text-[11px] text-muted">{(s.commissionRate * 100).toFixed(0)}% share</span>
                </div>

                <p className="text-center text-[11px] text-muted">
                  Updates every 5s · code <span className="font-mono text-fg">{s.referralCode}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function HudStat({ label, value, tone }: { label: string; value: string; tone?: 'up' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-surface-2 p-3">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-base font-bold tabular-nums ${tone === 'up' ? 'text-up' : 'text-fg'}`}>{value}</span>
    </div>
  );
}

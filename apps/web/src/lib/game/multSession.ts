'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { useGameSocketApi, type MultEvent, type MultOpenedData } from '@/lib/game/GameSocketProvider';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';

type CloseReason = 'manual' | 'tp' | 'sl' | 'stopout' | 'cancel';

/**
 * Multipliers session (BUGLOG #98): the open position lives HERE, not in the panel, so switching to a
 * digits tab (which unmounts the panel) no longer hides a live position — coming back shows it with
 * its Close button, and a second open is impossible. The socket subscription lives in the always-
 * mounted trade screen (useMultiplierSync), so no update or close is missed while the panel is hidden.
 */
interface MultSessionState {
  position: MultOpenedData | null;
  livePnl: number;
  sessionPnl: number;
  flash: { pnl: number; reason: CloseReason } | null;
  reset: () => void;
}

export const useMultSession = create<MultSessionState>((set) => ({
  position: null, livePnl: 0, sessionPnl: 0, flash: null,
  reset: () => set({ position: null, livePnl: 0, sessionPnl: 0, flash: null }),
}));

let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Mount once (the trade screen): keeps the store in step with the engine's multiplier events. */
export function useMultiplierSync() {
  const { onMultiplier } = useGameSocketApi();
  const token = useSession((st) => st.token);
  const qc = useQueryClient();
  const positionId = useMultSession((st) => st.position?.positionId ?? null);
  // A close can land while the socket is away (another page, a network drop): the store must not keep
  // a dead position that blocks trading and account switching (BUGLOG #115). While one is shown, ask
  // the server every 15 s (and at once on mount) whether it is still open.
  useEffect(() => {
    if (!positionId || !token) return;
    let stop = false;
    const check = async () => {
      try {
        const page = await api.positions(token, { status: 'open', limit: 50 });
        if (stop) return;
        if (!page.items.some((p) => p.id === positionId) && useMultSession.getState().position?.positionId === positionId) {
          useMultSession.setState({ position: null, livePnl: 0 });
          void qc.invalidateQueries({ queryKey: ['wallet'] });
        }
      } catch { /* keep it; try again */ }
    };
    void check();
    const t = setInterval(() => { void check(); }, 15_000);
    return () => { stop = true; clearInterval(t); };
  }, [positionId, token, qc]);
  useEffect(() => onMultiplier((e: MultEvent) => {
    const st = useMultSession.getState();
    if (e.type === 'opened') { useMultSession.setState({ position: e.data, livePnl: 0 }); return; }
    const p = st.position;
    if (!p || e.data.positionId !== p.positionId) return;
    if (e.type === 'update') { useMultSession.setState({ livePnl: e.data.pnlCents }); return; }
    useMultSession.setState({ position: null, livePnl: 0, sessionPnl: st.sessionPnl + e.data.pnlCents, flash: { pnl: e.data.pnlCents, reason: e.data.reason } });
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => useMultSession.setState({ flash: null }), 1400);
  }), [onMultiplier]);
}

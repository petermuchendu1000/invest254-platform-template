'use client';

import { useEffect, useRef, useState } from 'react';
import { env } from '@/lib/env';
import { useSession } from '@/lib/auth/session';

/**
 * Platform live feed (docs/24). Opens a single WebSocket to the multiplexed engine on the
 * brand-less `?platform=1` channel, authenticates with the platform_superadmin token, and
 * subscribes to the cross-brand feed:
 *   - `platform_snapshot` / `platform_online` → live per-brand online player counts (raw, no floor)
 *   - `platform_deposit`                       → each deposit the instant it confirms (migration 0071)
 *
 * Reconnects with backoff. Everything is push — no polling. Returns a stable snapshot the console
 * renders directly (online-by-site map, total online, and a capped rolling deposit feed).
 */

export interface LiveDeposit {
  siteId: string;
  userId: string;
  username: string;
  amountCents: number;
  txId: string;
  atMs: number;
}

export interface PlatformLive {
  connected: boolean;
  /** siteId → currently-connected player sockets (raw count). Absent site ⇒ 0 online. */
  onlineBySite: Record<string, number>;
  totalOnline: number;
  /** Newest-first rolling feed of confirmed deposits (capped). */
  deposits: LiveDeposit[];
  /** Last time an online snapshot arrived (epoch ms), for a freshness indicator. */
  lastOnlineTs: number | null;
}

const MAX_FEED = 60;

function platformWsUrl(): string {
  const base = env.wsUrl;
  return `${base}${base.includes('?') ? '&' : '?'}platform=1`;
}

export function usePlatformLive(): PlatformLive {
  const token = useSession((s) => s.token);
  const [state, setState] = useState<PlatformLive>({
    connected: false,
    onlineBySite: {},
    totalOnline: 0,
    deposits: [],
    lastOnlineTs: null,
  });

  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;

    const applyOnline = (data: { sites?: { siteId: string; count: number }[]; totalOnline?: number; ts?: number }) => {
      const map: Record<string, number> = {};
      for (const s of data.sites ?? []) map[s.siteId] = s.count;
      setState((prev) => ({
        ...prev,
        onlineBySite: map,
        totalOnline: data.totalOnline ?? Object.values(map).reduce((a, b) => a + b, 0),
        lastOnlineTs: data.ts ?? Date.now(),
      }));
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(platformWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempts = 0;
        setState((prev) => ({ ...prev, connected: true }));
        if (tokenRef.current) ws?.send(JSON.stringify({ type: 'auth', data: { token: tokenRef.current } }));
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping', data: {} }));
        }, 20_000);
      };

      ws.onmessage = (ev) => {
        let msg: { type?: string; data?: unknown };
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        switch (msg.type) {
          case 'platform_authed':
            ws?.send(JSON.stringify({ type: 'subscribe_platform', data: {} }));
            return;
          case 'platform_snapshot':
          case 'platform_online':
            applyOnline(msg.data as Parameters<typeof applyOnline>[0]);
            return;
          case 'platform_deposit': {
            const d = msg.data as LiveDeposit;
            if (!d || typeof d.amountCents !== 'number') return;
            setState((prev) => ({ ...prev, deposits: [d, ...prev.deposits].slice(0, MAX_FEED) }));
            return;
          }
          default:
            return;
        }
      };

      ws.onclose = () => {
        setState((prev) => ({ ...prev, connected: false }));
        if (pingTimer) clearInterval(pingTimer);
        scheduleReconnect();
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = Math.min(1_000 * 2 ** attempts, 15_000);
      attempts += 1;
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) ws.close();
      ws = null;
    };
  }, [token]);

  return state;
}

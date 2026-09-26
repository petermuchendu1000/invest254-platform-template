'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { useDigitSession } from '@/lib/game/digitSession';
import { useMultSession } from '@/lib/game/multSession';
import { useAccountUi } from '@/lib/account/accountUi';
import { useLiveChat } from '@/lib/chat/liveChat';

/** The account a JWT belongs to (`sub`), or null. A refreshed token for the same user is not a switch. */
function subOf(token: string | null): string | null {
  if (!token) return null;
  try { return (JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string }).sub ?? null; } catch { return null; }
}

/**
 * BUGLOG #99: every per-user query (wallet, notifications, chat, KYC, referrals, 2FA…) is cached under
 * keys that do not include the user. On sign-out, a 401 reset or signing in as someone else, the next
 * person saw the previous one's banners, chat, identity status and referral earnings. One place, for
 * the whole app: when the signed-in account changes, drop every cached query and the session stores.
 */
export function SessionCacheGuard() {
  const qc = useQueryClient();
  const token = useSession((s) => s.token);
  const prev = useRef<string | null>(subOf(token));
  useEffect(() => {
    const now = subOf(token);
    if (now === prev.current) return;
    const hadUser = prev.current !== null;
    prev.current = now;
    if (!hadUser) return;                          // first sign-in on this page: nothing stale to drop
    qc.clear();
    useDigitSession.getState().reset();
    useMultSession.getState().reset();
    useAccountUi.getState().close();
    useLiveChat.getState().setOpen(false);
  }, [token, qc]);
  return null;
}

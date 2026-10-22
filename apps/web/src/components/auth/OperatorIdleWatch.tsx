'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { roleFromToken } from '@/lib/auth/token';
import { clearImpersonation } from '@/lib/platform/impersonate';
import {
  IDLE_WARNING_MS,
  IDLE_WINDOW_MS,
  armOperatorActivity,
  isPrivilegedRole,
  lastOperatorActivityMs,
  useSessionEnd,
} from '@/lib/auth/operatorSession';
import { registerSessionIdleHandler } from '@/lib/auth/stepUp';

/*
 * The operator idle timeout, client side (0196).
 *
 * The RULE is the server's: a privileged session with no authenticated request for five minutes is
 * refused with 401 SESSION_IDLE (apps/api/src/stepup.ts). This component does the two things the
 * server cannot:
 *
 *   1. WARN FIRST. Without a warning the rule lands as a console that silently stops working
 *      mid-task — the operator's next click fails, their half-filled form is gone, and the
 *      explanation arrives only after the damage. A minute of notice with one button to stay makes
 *      the timeout survivable instead of something people route around.
 *   2. END THE SESSION HERE when the server already has. It registers the handler that apiFetch
 *      calls on SESSION_IDLE: clear the impersonation fence, clear the session, and say why on the
 *      sign-in screen. There is no retry — the token is dead, so retrying is a loop against a 401.
 *
 * The countdown measures from the last ANSWERED API call, never from mouse or keyboard activity,
 * because that is what the server measures. A clock that counted typing would promise an operator
 * time the server had already taken away, which is worse than no clock at all.
 *
 * PRIVILEGED ROLES ONLY. For a player or marketer this renders null, arms nothing, starts no timer
 * and makes no request: the server-side gate ignores them entirely (their tokens never touch the
 * session store), so there is nothing here for them to see.
 */

/** mm:ss for the countdown. */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function OperatorIdleWatch() {
  const token = useSession((s) => s.token);
  const reset = useSession((s) => s.reset);
  const setReason = useSessionEnd((s) => s.setReason);
  // The TOKEN role is what the API gates on (an impersonated brand session is an `admin` session).
  const privileged = isPrivilegedRole(roleFromToken(token));

  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [keepingAlive, setKeepingAlive] = useState(false);
  // Guards the one-shot sign-out: several in-flight 401s, plus the local deadline, can all decide
  // the session is over within the same tick.
  const endedRef = useRef(false);

  const endSession = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    // Drop the impersonation fence BEFORE the session, exactly as useAuthActions.logout does, so a
    // brand-scoped impersonation token can never outlive the session that opened it.
    clearImpersonation();
    reset();
    setReason('idle');
  }, [reset, setReason]);

  // apiFetch reports SESSION_IDLE here. Registered only for a privileged session, which is the only
  // kind the server can answer it to.
  useEffect(() => {
    if (!privileged) return;
    return registerSessionIdleHandler(endSession);
  }, [privileged, endSession]);

  // Arm the activity clock. Re-armed on a token change so a fresh sign-in starts its five minutes
  // from now, not from whatever the previous session last did.
  useEffect(() => {
    if (!privileged) {
      armOperatorActivity(false);
      return;
    }
    endedRef.current = false;
    armOperatorActivity(true);
    setRemainingMs(null);
    return () => armOperatorActivity(false);
  }, [privileged, token]);

  useEffect(() => {
    if (!privileged) return;
    const tick = () => {
      const left = IDLE_WINDOW_MS - (Date.now() - lastOperatorActivityMs());
      if (left <= 0) {
        // The server is already refusing this session. Clearing it here — rather than waiting for
        // the operator's next click to 401 — is what stops an unattended console from LOOKING like
        // a live one. Deliberately no keep-alive request at the deadline: a timer that renewed the
        // session on its own would mean the idle rule never fires.
        setRemainingMs(0);
        endSession();
        return;
      }
      setRemainingMs(left <= IDLE_WARNING_MS ? left : null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [privileged, token, endSession]);

  async function staySignedIn() {
    if (!token) return;
    setKeepingAlive(true);
    try {
      // Any answered authenticated call refreshes the server's last-seen stamp (the idle gate runs
      // in the verifier, on reads too), and apiFetch then records the activity locally.
      await api.me(token);
      setRemainingMs(null);
    } catch {
      // A SESSION_IDLE here has already signed the operator out through the handler above; anything
      // else (offline, a blip) leaves the countdown running, which is the honest answer.
    } finally {
      setKeepingAlive(false);
    }
  }

  if (!privileged || remainingMs === null || remainingMs <= 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[55] w-[min(22rem,calc(100vw-2rem))] rounded-brand border border-border bg-surface p-4 shadow-2xl shadow-black/50 ring-1 ring-white/5"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium text-fg">
        Signing you out in <span className="tabular-nums">{clock(remainingMs)}</span>
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Admin sessions close after 5 minutes without activity. Stay signed in to keep working.
      </p>
      <button
        type="button"
        onClick={() => { void staySignedIn(); }}
        disabled={keepingAlive}
        className="mt-3 h-9 w-full rounded-brand bg-accent/10 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:opacity-60"
      >
        {keepingAlive ? 'Staying signed in…' : 'Stay signed in'}
      </button>
    </div>
  );
}

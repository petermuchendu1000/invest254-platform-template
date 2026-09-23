'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { roleFromToken, actorFromToken } from '@/lib/auth/token';
import { isImpersonating, clearImpersonation } from '@/lib/platform/impersonate';

/**
 * Validates a persisted token on load and populates the profile (or clears on 401). It also
 * heals a stale token: if the token's role claim no longer matches the live role from
 * /auth/me (e.g. the account was promoted/demoted since the token was issued), it transparently
 * rotates to a fresh token so role-gated routes stop 403-ing — no manual sign-out required.
 */
export function SessionBootstrap() {
  const setUser = useSession((s) => s.setUser);
  const setToken = useSession((s) => s.setToken);
  const reset = useSession((s) => s.reset);

  useEffect(() => {
    const token = useSession.getState().token;
    if (!token) return;
    let active = true;
    api
      .me(token)
      .then(async (me) => {
        if (!active) return;
        setUser(me);
        // An impersonation token (docs/42 UI-3: `act` claim) deliberately carries role 'admin' while
        // /auth/me reports the operator's own tier — never "heal" it, or we'd swap in the operator's
        // own token and drop the brand fence (for every tab sharing the token).
        if (roleFromToken(token) !== me.role && !actorFromToken(token) && !isImpersonating()) {
          try {
            const r = await api.refreshToken(token);
            if (active) setToken(r.token);
          } catch {
            // Non-fatal: keep the existing token. A genuine auth failure surfaces elsewhere.
          }
        }
      })
      .catch((e) => {
        // A dead/expired token (incl. a spent impersonation token) must also drop the fence, else a
        // stale brand scope would survive into the next session.
        if (e instanceof ApiError && e.status === 401) { clearImpersonation(); reset(); }
      });
    return () => {
      active = false;
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

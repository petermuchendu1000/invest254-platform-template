'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { roleFromToken } from '@/lib/auth/token';
import { isImpersonating } from '@/lib/platform/impersonate';

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
        // While impersonating a brand, the active token is a deliberately brand-scoped superadmin
        // token whose role differs from the platform owner's own /auth/me role — do NOT "heal" it,
        // or we'd rotate to a site-less platform token and drop the brand binding.
        if (roleFromToken(token) !== me.role && !isImpersonating()) {
          try {
            const r = await api.refreshToken(token);
            if (active) setToken(r.token);
          } catch {
            // Non-fatal: keep the existing token. A genuine auth failure surfaces elsewhere.
          }
        }
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) reset();
      });
    return () => {
      active = false;
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

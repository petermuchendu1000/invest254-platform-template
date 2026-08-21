'use client';

import { useQueryClient } from '@tanstack/react-query';
import { api, type RegisterInput } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { roleFromToken } from '@/lib/auth/token';
import { useBrand } from '@/lib/brand/BrandProvider';
import { useWelcomeBonusFx } from '@/lib/game/welcomeBonusFx';

export function useAuthActions() {
  const setToken = useSession((s) => s.setToken);
  const setUser = useSession((s) => s.setUser);
  const reset = useSession((s) => s.reset);
  const qc = useQueryClient();
  // The brand this request/host resolved to (SSR-injected via BrandProvider). Every auth call
  // carries it so the shared API scopes the account + token to the right brand (GAP 1 fix). The
  // API is one host for all domains, so without this a player on any brand pools into site #1.
  const brand = useBrand();

  async function login(phone: string, password: string) {
    const res = await api.login({ phone, password, site: brand.slug });
    setToken(res.token);
    setUser(await api.me(res.token));
    return res;
  }

  async function register(input: RegisterInput) {
    // Respect an explicit site if a caller ever sets one; otherwise bind to the resolved brand.
    const res = await api.register({ ...input, site: input.site ?? brand.slug });
    setToken(res.token);
    setUser(await api.me(res.token));
    // One-time welcome bonus (0094): refresh the wallet so the restricted balance shows, then fire
    // the winning-card celebration. Delayed briefly so the auth sheet closes first (peak-end moment).
    if (res.welcomeBonusCents && res.welcomeBonusCents > 0) {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      const cents = res.welcomeBonusCents;
      setTimeout(() => useWelcomeBonusFx.getState().show(cents), 450);
    }
    return res;
  }

  async function refresh(token: string) {
    try {
      const me = await api.me(token);
      setUser(me);
      // Heal a stale token whose role claim no longer matches the live role (promotion/demotion).
      if (roleFromToken(token) !== me.role) {
        try {
          const r = await api.refreshToken(token);
          setToken(r.token);
        } catch {
          /* keep existing token; non-fatal */
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) reset();
    }
  }

  function logout() {
    reset();
  }

  return { login, register, refresh, logout };
}

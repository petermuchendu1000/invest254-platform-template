'use client';

import { useSession } from '@/lib/auth/session';
import { actorFromToken, siteFromToken } from '@/lib/auth/token';
import { api } from '@/lib/api/endpoints';
import type { ImpersonateResult } from '@/lib/platform/endpoints';
import {
  type ImpersonatedBrand,
  type StorageLike,
  readImpersonatedBrand,
  isImpersonatingIn,
  beginImpersonationIn,
  endImpersonationIn,
  clearImpersonationIn,
} from '@/lib/platform/impersonate.core';

/**
 * Platform-owner impersonation (docs/24 §370) — browser glue over the pure state machine in
 * ./impersonate.core.ts. The platform_superadmin "logs into" a client's admin console AS that
 * brand's admin using a token minted by POST /platform/sites/:id/impersonate. We swap the
 * active session token to it and hard-navigate to /admin so every provider re-inits with the new
 * token; the platform token is stashed so "Exit to platform" restores it.
 *
 * SECURITY: the swap only changes which brand the API scopes to; authorisation is enforced
 * server-side by the token's signed role + site claims. sessionStorage keeps the stash tab-local.
 */

export type { ImpersonatedBrand } from '@/lib/platform/impersonate.core';

/** sessionStorage, or null when it is unavailable (SSR, privacy modes) — never throws. */
function store(): StorageLike | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

/** True while the ACTIVE token is an impersonation token (docs/42 UI-3: read from the token's `act`
 *  claim, so it holds in every tab — the per-tab sessionStorage stash is only the "way back"). */
export function isImpersonating(): boolean {
  // Token first; the tab stash covers impersonation tokens minted before the API added `act`.
  return actorFromToken(useSession.getState().token) !== null || isImpersonatingIn(store());
}

/** The brand being impersonated, or null. Prefers this tab's stash (slug/domain); falls back to the
 *  token (brand id + name) so a second tab shows the same banner and fence. */
export function getImpersonatingBrand(): ImpersonatedBrand | null {
  const token = useSession.getState().token;
  const actor = actorFromToken(token);
  const site = siteFromToken(token);
  const stashed = readImpersonatedBrand(store());
  if (!actor) return stashed;   // legacy impersonation token (pre-`act`): this tab's stash is the marker
  if (stashed && stashed.siteId === site) return stashed;
  return site ? { siteId: site, slug: '', name: actor.brand ?? 'this brand', primaryDomain: null } : null;
}

/** Stash the platform token, activate the brand token, and enter the brand admin console. */
export function startImpersonation(res: ImpersonateResult, next = '/admin'): void {
  const current = useSession.getState().token;
  let activeToken: string;
  try {
    activeToken = beginImpersonationIn(store(), res, current);
  } catch {
    // Malformed impersonation result — leave the platform session untouched rather than blank it.
    return;
  }
  useSession.getState().setToken(activeToken);
  // UI-F: land on a specific back-office page (e.g. one player) — only ever inside /admin.
  window.location.assign(/^\/admin(\/[\w\-/]*)?$/.test(next) ? next : '/admin');
}

/** Leave the brand: restore this tab's stashed console token; in a tab without a stash, exchange the
 *  impersonation token for the operator's own session (POST /auth/refresh re-mints for the token's
 *  subject — the operator). Either way, land on the console. */
export async function endImpersonation(): Promise<void> {
  const restore = endImpersonationIn(store());
  if (restore) {
    useSession.getState().setToken(restore);
  } else {
    const current = useSession.getState().token;
    try {
      const r = current ? await api.refreshToken(current) : null;
      if (r?.token) useSession.getState().setToken(r.token); else useSession.getState().reset();
    } catch {
      useSession.getState().reset();
    }
  }
  window.location.assign('/platform');
}

/**
 * Drop ALL impersonation state without navigating. Called on logout and on a forced 401 reset so a
 * brand-scoped fence can never outlive the session that created it (the exact "stale fence after
 * logout" confusion). Idempotent and safe to call when not impersonating.
 */
export function clearImpersonation(): void {
  clearImpersonationIn(store());
}

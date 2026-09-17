'use client';

import { useSession } from '@/lib/auth/session';
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
 * brand's superadmin using a token minted by POST /platform/sites/:id/impersonate. We swap the
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

/** True while an impersonation session is active (used to suppress token drift-refresh). */
export function isImpersonating(): boolean {
  return isImpersonatingIn(store());
}

/** The brand currently being impersonated, or null. */
export function getImpersonatingBrand(): ImpersonatedBrand | null {
  return readImpersonatedBrand(store());
}

/** Stash the platform token, activate the brand token, and enter the brand admin console. */
export function startImpersonation(res: ImpersonateResult): void {
  const current = useSession.getState().token;
  let activeToken: string;
  try {
    activeToken = beginImpersonationIn(store(), res, current);
  } catch {
    // Malformed impersonation result — leave the platform session untouched rather than blank it.
    return;
  }
  useSession.getState().setToken(activeToken);
  window.location.assign('/admin');
}

/** Restore the platform token (if stashed) and return to the platform console. */
export function endImpersonation(): void {
  const restore = endImpersonationIn(store());
  if (restore) useSession.getState().setToken(restore);
  else useSession.getState().reset();
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

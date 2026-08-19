'use client';

import { useSession } from '@/lib/auth/session';
import type { ImpersonateResult } from '@/lib/platform/endpoints';

/**
 * Platform-owner impersonation (docs/24 §370). The platform_superadmin "logs into" a client's admin
 * console AS that brand's superadmin using a token minted by POST /platform/sites/:id/impersonate
 * (subject = platform admin for audit; role='superadmin'; `site` = the target brand). We swap the
 * active session token to it and hard-navigate to /admin so every provider re-inits with the new
 * token. The original platform token is stashed in sessionStorage so "Exit to platform" restores it.
 *
 * SECURITY NOTE: the swap only changes which brand the API scopes to; authorisation is still enforced
 * server-side by the token's signed role + site claims. sessionStorage keeps the stash tab-local.
 */

const RETURN_TOKEN_KEY = 'pp-platform-return-token';
const BRAND_KEY = 'pp-impersonating-brand';

export interface ImpersonatedBrand { siteId: string; slug: string; name: string; primaryDomain: string | null }

/** True while an impersonation session is active (used to suppress token drift-refresh). */
export function isImpersonating(): boolean {
  try { return !!sessionStorage.getItem(BRAND_KEY); } catch { return false; }
}

/** The brand currently being impersonated, or null. */
export function getImpersonatingBrand(): ImpersonatedBrand | null {
  try { const b = sessionStorage.getItem(BRAND_KEY); return b ? (JSON.parse(b) as ImpersonatedBrand) : null; }
  catch { return null; }
}

/** Stash the platform token, activate the brand token, and enter the brand admin console. */
export function startImpersonation(res: ImpersonateResult): void {
  const current = useSession.getState().token;
  try {
    if (current) sessionStorage.setItem(RETURN_TOKEN_KEY, current);
    sessionStorage.setItem(BRAND_KEY, JSON.stringify(res.brand));
  } catch { /* sessionStorage unavailable — proceed with the token swap regardless */ }
  useSession.getState().setToken(res.token);
  window.location.assign('/admin');
}

/** Restore the platform token (if stashed) and return to the platform console. */
export function endImpersonation(): void {
  let restore: string | null = null;
  try {
    restore = sessionStorage.getItem(RETURN_TOKEN_KEY);
    sessionStorage.removeItem(RETURN_TOKEN_KEY);
    sessionStorage.removeItem(BRAND_KEY);
  } catch { /* ignore */ }
  if (restore) useSession.getState().setToken(restore);
  else useSession.getState().reset();
  window.location.assign('/platform');
}

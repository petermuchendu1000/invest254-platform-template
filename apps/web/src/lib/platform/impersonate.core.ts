/**
 * Impersonation state machine — framework-free core (unit-tested; no DOM, no session, no React).
 *
 * The platform owner "logs into" a client brand's admin console AS that brand's superadmin via a
 * token minted by POST /platform/sites/:id/impersonate (subject stays the platform admin for audit;
 * role='superadmin'; `site` = the target brand). The active session token is swapped to it and the
 * platform (return) token is stashed so "Exit to platform" restores it.
 *
 * This module owns ONLY the reversible storage transitions + strict validation, so the exact same
 * logic that runs in the browser is exercised by the tests against a fake Storage. The DOM/session
 * glue (sessionStorage, useSession, window navigation) lives in ./impersonate.ts.
 *
 * SECURITY: swapping the token only changes which brand the API scopes to — authorisation is always
 * enforced server-side by the token's signed role + site claims (see app.platform.impersonate.test).
 * A corrupt/tampered brand blob is treated as "not impersonating" (fail-closed to the platform view).
 */

export interface ImpersonatedBrand {
  siteId: string;
  slug: string;
  name: string;
  primaryDomain: string | null;
}

export interface ImpersonateResultLike {
  token: string;
  brand: ImpersonatedBrand;
}

/** The subset of the Web Storage API we depend on (Storage satisfies it; so does a test fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const IMP_RETURN_TOKEN_KEY = 'pp-platform-return-token';
export const IMP_BRAND_KEY = 'pp-impersonating-brand';

/** Strict parse: a blob missing any required string field (or non-JSON) is rejected -> null. */
export function parseImpersonatedBrand(raw: string | null | undefined): ImpersonatedBrand | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.siteId !== 'string' || !o.siteId) return null;
  if (typeof o.slug !== 'string' || !o.slug) return null;
  if (typeof o.name !== 'string' || !o.name) return null;
  const primaryDomain = typeof o.primaryDomain === 'string' ? o.primaryDomain : null;
  return { siteId: o.siteId, slug: o.slug, name: o.name, primaryDomain };
}

/** The brand currently being impersonated in `store`, or null (also null on unavailable storage). */
export function readImpersonatedBrand(store: StorageLike | null): ImpersonatedBrand | null {
  if (!store) return null;
  try { return parseImpersonatedBrand(store.getItem(IMP_BRAND_KEY)); } catch { return null; }
}

export function isImpersonatingIn(store: StorageLike | null): boolean {
  return readImpersonatedBrand(store) !== null;
}

/** Validate an impersonation result BEFORE swapping the active token (never blank a good session). */
export function isValidImpersonateResult(res: unknown): res is ImpersonateResultLike {
  if (!res || typeof res !== 'object') return false;
  const o = res as Record<string, unknown>;
  if (typeof o.token !== 'string' || !o.token) return false;
  try { return parseImpersonatedBrand(JSON.stringify(o.brand)) !== null; } catch { return false; }
}

/**
 * Enter impersonation: stash the platform (return) token + the target brand and return the token
 * that must become active. Throws INVALID_IMPERSONATION on a malformed result so the caller keeps
 * the platform session intact. Storage failures are swallowed (the token swap still proceeds).
 */
export function beginImpersonationIn(
  store: StorageLike | null,
  res: ImpersonateResultLike,
  currentToken: string | null,
): string {
  if (!isValidImpersonateResult(res)) throw new Error('INVALID_IMPERSONATION');
  if (store) {
    try {
      if (currentToken) store.setItem(IMP_RETURN_TOKEN_KEY, currentToken);
      else store.removeItem(IMP_RETURN_TOKEN_KEY);
      store.setItem(IMP_BRAND_KEY, JSON.stringify(res.brand));
    } catch { /* storage unavailable — proceed with the swap regardless */ }
  }
  return res.token;
}

/**
 * Exit impersonation: clear the fence and return the stashed platform token to restore (or null,
 * meaning the caller should reset the session). Always clears both keys.
 */
export function endImpersonationIn(store: StorageLike | null): string | null {
  let restore: string | null = null;
  if (store) {
    try {
      restore = store.getItem(IMP_RETURN_TOKEN_KEY);
      store.removeItem(IMP_RETURN_TOKEN_KEY);
      store.removeItem(IMP_BRAND_KEY);
    } catch { restore = null; }
  }
  return restore;
}

/** Hard clear (logout / forced 401): drop every impersonation artifact. Idempotent, never throws. */
export function clearImpersonationIn(store: StorageLike | null): void {
  if (!store) return;
  try { store.removeItem(IMP_RETURN_TOKEN_KEY); store.removeItem(IMP_BRAND_KEY); } catch { /* ignore */ }
}

/**
 * scope.ts — the ONE rule for "may this caller act on a target that lives in brand X?"
 * (Issue 1 / F-44). Every id-addressed operator route resolves its target to the brand (site) it
 * lives in and calls `assertSiteTarget`. Keeping the tier logic here — instead of re-deriving it in
 * each handler — is what makes scope enforcement uniform, testable and hard to forget.
 *
 * Tier rule (fail-closed at every step):
 *   - platform_superadmin (system)  -> any brand;
 *   - platform_admin                -> only a brand whose PLATFORM equals its `platform` claim
 *                                      (claimless -> PLATFORM_CLAIM_MISSING; unresolved -> 403);
 *   - site admin (`admin`)          -> only its own brand (`site` claim; claimless ->
 *                                      SITE_CLAIM_MISSING); a known cross-brand target ->
 *                                      403 SITE_SCOPE_FORBIDDEN;
 *   - an unresolved target (no such entity) -> 404 for a bounded caller, never "allowed".
 * Unlike the legacy `assertTargetSiteInScope` (tolerant of an unresolved target by design), nothing
 * here defers to a downstream guard.
 */
import { ApiError, ROLE_RANK, adminScopeSite, assertTargetPlatformInScope, type Ctx } from "./http.js";

export interface ScopeResolvers {
  /** The brand a user (profiles.id) belongs to, or null if no such user. */
  siteOfUser(userId: string): Promise<string | null>;
  /** The platform a brand belongs to, or null if unknown. */
  platformOfSite(siteId: string): Promise<string | null>;
}

const isSystem = (ctx: Ctx): boolean =>
  (ROLE_RANK[ctx.claims?.role ?? ""] ?? 0) >= (ROLE_RANK.platform_superadmin ?? Number.POSITIVE_INFINITY);

/** Assert the caller may act on a target living in `targetSite` (see the tier rule above). */
export async function assertSiteTarget(ctx: Ctx, targetSite: string | null | undefined, r: Pick<ScopeResolvers, "platformOfSite">): Promise<void> {
  if (!ctx.claims) throw new ApiError("AUTH_REQUIRED", "authentication required", 401);
  if (isSystem(ctx)) return;
  if (ctx.claims.role === "platform_admin") {
    assertTargetPlatformInScope(ctx, targetSite ? await r.platformOfSite(targetSite) : null);
    return;
  }
  const scope = adminScopeSite(ctx); // site admin: its brand; throws SITE_CLAIM_MISSING if claimless
  if (!targetSite) throw new ApiError("NOT_FOUND", "target not found", 404);
  if (scope === null || targetSite !== scope) {
    throw new ApiError("SITE_SCOPE_FORBIDDEN", "SITE_SCOPE_FORBIDDEN: target belongs to another brand", 403);
  }
}

/** Assert the caller may act on user `userId`; returns the user's brand (null only for the system owner). */
export async function assertUserTarget(ctx: Ctx, userId: string, r: ScopeResolvers): Promise<string | null> {
  const site = await r.siteOfUser(userId);
  await assertSiteTarget(ctx, site, r);
  return site;
}

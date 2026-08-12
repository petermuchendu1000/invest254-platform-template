import { Router, ApiError, requireAuth, requireSite, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";

/**
 * Site (brand) routes — docs/22 Task E.
 *
 *  - `GET /site/brand?host=<host|slug>` (public): the brand DTO the web layout renders. Many
 *    domains point at one deployment, so the frontend resolves its brand by host here before
 *    login (see apps/web/src/lib/brand/brand.ts).
 *  - `GET /site/me` (auth + requireSite): the brand the caller's token is scoped to — a cheap way
 *    for a client to confirm which brand it's operating under, and the end-to-end proof that the
 *    JWT `site` claim drives `ctx.siteId`.
 */
export function registerSiteRoutes(router: Router, deps: ApiDeps): void {
  router.get(`${BASE}/site/brand`, async (ctx: Ctx) => {
    const host = ctx.query.get("host")?.trim().toLowerCase();
    if (!host) throw new ApiError("VALIDATION", "host query parameter is required", 400);
    const brand = await deps.brandByHost(host);
    if (!brand) throw new ApiError("SITE_NOT_FOUND", `no active brand for host '${host}'`, 404);
    return brand;
  });

  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  router.get(`${BASE}/site/me`, auth, site, (ctx: Ctx) => ({ siteId: ctx.siteId }));
}

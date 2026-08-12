import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

/**
 * Platform-superadmin console (docs/22 Task H) — cross-brand operations, gated to
 * `platform_superadmin` (a per-brand admin/superadmin never reaches these):
 *   GET   /platform/overview          per-brand KPIs (users, deposits, withdrawals, GGR, positions)
 *   GET   /platform/sites             every brand + its economy (site_game_config)
 *   POST  /platform/sites             onboard a brand (creates the site + default economy)
 *   PATCH /platform/sites/:id         edit a brand's identity/branding
 *   PATCH /platform/sites/:id/config  tune a brand's economy (feasibility enforced by the DB CHECK)
 * Thin transport over the engine PlatformService; the invariants + audit live in the fn_platform_* RPCs.
 */

const BASE = "/api/v1";

const PLATFORM_STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403,
  INVALID_BRAND: 400,
  INVALID_PATCH: 400,
  SLUG_TAKEN: 409,
  SITE_NOT_FOUND: 404,
  site_cfg_feasible: 422, // the economy-feasibility CHECK (RTP/win-rate) rejected the tuning
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Surface the Postgres CHECK name for an infeasible economy as a clean 422.
    const code = /site_cfg_feasible/.test(message) ? "site_cfg_feasible" : message.split(":")[0]!.trim();
    const status = PLATFORM_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

export function registerPlatformRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const platform = requireRole("platform_superadmin");

  router.get(`${BASE}/platform/overview`, auth, platform, async (ctx: Ctx) =>
    ({ sites: await domain(() => deps.platform.overview(ctx.claims!.role ?? "player")) }));

  router.get(`${BASE}/platform/sites`, auth, platform, async () =>
    ({ sites: await deps.platform.listSites() }));

  router.post(`${BASE}/platform/sites`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const slug = body.slug, name = body.name;
    if (typeof slug !== "string" || typeof name !== "string") throw new ApiError("VALIDATION", "slug and name are required", 400);
    const input = {
      slug, name,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : undefined,
    };
    const siteId = await domain(() => deps.platform.createSite(ctx.claims!.userId, ctx.claims!.role ?? "player", input));
    return { status: 201, body: { siteId } };
  });

  router.patch(`${BASE}/platform/sites/:id`, auth, platform, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    return domain(() => deps.platform.updateSite(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });

  router.patch(`${BASE}/platform/sites/:id/config`, auth, platform, async (ctx: Ctx) => {
    const patch = asObject(ctx.body);
    return domain(() => deps.platform.setSiteConfig(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, patch));
  });
}

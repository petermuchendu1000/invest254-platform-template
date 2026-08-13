import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { MarketerRollupRow } from "@invest254/engine";
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
  // Task R — cross-brand marketer rollup
  INVALID_LABEL: 400,
  INVALID_AFFILIATE: 400,
  INVALID_GLOBAL: 400,
  MARKETER_GLOBAL_NOT_FOUND: 404,
  NOT_AFFILIATE: 404,
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

/**
 * Fold the flat per-(affiliate, site) rollup rows (Task R) into one entry per marketer — grouped by
 * `marketerGlobalId` when linked, else standalone per affiliate — with a per-site breakdown and the
 * cross-brand totals. This is the "which marketer brought which client on which site, and their
 * total" single view.
 */
interface MarketerGroup {
  marketerGlobalId: string | null; label: string | null;
  sites: Array<{ affiliateUserId: string; siteId: string; siteSlug: string; siteName: string; clients: number; ggrCents: number; commissionCents: number }>;
  totals: { clients: number; ggrCents: number; commissionCents: number };
}
function groupMarketerRollup(rows: MarketerRollupRow[]): MarketerGroup[] {
  const groups = new Map<string, MarketerGroup>();
  for (const r of rows) {
    const key = r.marketerGlobalId ?? `aff:${r.affiliateUserId}`;
    let g = groups.get(key);
    if (!g) {
      g = { marketerGlobalId: r.marketerGlobalId, label: r.label, sites: [], totals: { clients: 0, ggrCents: 0, commissionCents: 0 } };
      groups.set(key, g);
    }
    g.sites.push({ affiliateUserId: r.affiliateUserId, siteId: r.siteId, siteSlug: r.siteSlug, siteName: r.siteName, clients: r.clients, ggrCents: r.ggrCents, commissionCents: r.commissionCents });
    g.totals.clients += r.clients;
    g.totals.ggrCents += r.ggrCents;
    g.totals.commissionCents += r.commissionCents;
  }
  return [...groups.values()];
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

  // ── Task R: cross-brand marketer rollup (reporting only; money stays per site) ──
  // The one view: per marketer -> which clients on which site + the cross-brand total.
  router.get(`${BASE}/platform/marketers/rollup`, auth, platform, async (ctx: Ctx) => {
    const rows = await domain(() => deps.platform.marketerRollup(ctx.claims!.role ?? "player"));
    return { marketers: groupMarketerRollup(rows), rows };
  });

  // Create a global marketer identity (a real person spanning brands).
  router.post(`${BASE}/platform/marketers`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    if (typeof body.label !== "string") throw new ApiError("VALIDATION", "label is required", 400);
    const marketerGlobalId = await domain(() => deps.platform.createMarketerGlobal(ctx.claims!.userId, ctx.claims!.role ?? "player", body.label as string));
    return { status: 201, body: { marketerGlobalId } };
  });

  // Link (or unlink with null) one brand's affiliate row to a global marketer identity.
  router.patch(`${BASE}/platform/affiliates/:userId/marketer`, auth, platform, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const raw = body.marketerGlobalId;
    if (raw !== null && typeof raw !== "string") throw new ApiError("VALIDATION", "marketerGlobalId must be a string or null", 400);
    await domain(() => deps.platform.linkMarketer(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.userId!, raw ?? null));
    return { ok: true, affiliateUserId: ctx.params.userId, marketerGlobalId: raw ?? null };
  });
}

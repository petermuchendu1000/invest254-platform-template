import { Router, ApiError, requireAuth, requireRole, adminScopeSite, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";
const STATUS: Record<string, number> = {
  NOT_AUTHORIZED: 403, SITE_SCOPE_FORBIDDEN: 403, PLATFORM_SCOPE_FORBIDDEN: 403,
  ADDON_NOT_FOUND: 404, SITE_NOT_FOUND: 404, REQUEST_NOT_FOUND: 404,
  ADDON_INACTIVE: 400, INVALID_AMOUNT: 400, INVALID_DECISION: 400,
  ALREADY_ENTITLED: 409, REQUEST_NOT_OPEN: 409, CANNOT_REVOKE_DEFAULT: 400,
  INVALID_PATCH: 400, INVALID_BILLING_TYPE: 400, INVALID_NAME: 400, INVALID_DESCRIPTION: 400, FREE_HAS_PRICE: 400,
  PRICE_REQUIRED: 400, DEFAULT_MUST_BE_FREE: 400, NOTE_TOO_LONG: 400, NOT_SWITCHABLE: 400, NOT_ENTITLED: 409,
};
const MESSAGES: Record<string, string> = {
  FREE_HAS_PRICE: "A free add-on can't have a price or setup fee.",
  PRICE_REQUIRED: "One-off and monthly add-ons need a price.",
  DEFAULT_MUST_BE_FREE: "The default of a category is what every brand falls back to, so it stays free and offered.",
  ALREADY_ENTITLED: "This brand already has it.",
  REQUEST_NOT_OPEN: "That request was already decided or withdrawn.",
  NOT_ENTITLED: "The brand doesn't own that system yet — request it first.",
  NOT_SWITCHABLE: "Only price charts and trade screens can be switched.",
  NOTE_TOO_LONG: "Keep the note under 500 characters.",
  CANNOT_REVOKE_DEFAULT: "The free default can't be removed.",
};
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    if (STATUS[code]) throw new ApiError(code, MESSAGES[code] ?? message, STATUS[code]!);
    throw err;
  }
}
function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}
const str = (b: Record<string, unknown>, k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");

/** The add-on service surface the routes need (implemented by AddonService). */
export interface AddonDeps {
  catalog(actorRole: string): Promise<unknown[]>;
  setPrice(actorId: string, actorRole: string, category: string, key: string, priceCents: number): Promise<unknown>;
  brandView(actorId: string, actorRole: string, siteId: string): Promise<unknown[]>;
  request(actorId: string, actorRole: string, siteId: string, category: string, key: string, note: string | null): Promise<unknown>;
  listRequests(actorId: string, actorRole: string, status: string | null): Promise<unknown[]>;
  decideRequest(actorId: string, actorRole: string, requestId: number, decision: string, note: string | null): Promise<unknown>;
  grant(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown>;
  revoke(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown>;
  update(actorId: string, actorRole: string, category: string, key: string, patch: Record<string, unknown>): Promise<unknown>;
  cancelRequest(actorId: string, actorRole: string, requestId: number): Promise<unknown>;
  activate(actorId: string, actorRole: string, siteId: string, category: string, key: string): Promise<unknown>;
  brands(actorId: string, actorRole: string): Promise<unknown[]>;
}

const CATEGORIES = new Set(["chart", "trade_ui", "payment_gateway"]);
/** ADDON-1: shape a catalog patch (the RPC validates the business rules). */
export function parseAddonPatch(body: unknown): Record<string, unknown> {
  const b = asObject(body); const out: Record<string, unknown> = {};
  for (const k of ["displayName", "description"] as const) if (k in b) {
    if (typeof b[k] !== "string") throw new ApiError("VALIDATION", `${k} must be text`, 400);
    out[k] = (b[k] as string).trim();
  }
  if ("billingType" in b) {
    if (!["free", "one_off", "monthly"].includes(String(b.billingType))) throw new ApiError("INVALID_BILLING_TYPE", "billingType must be free, one_off or monthly", 400);
    out.billingType = b.billingType;
  }
  for (const k of ["priceCents", "setupFeeCents", "sortOrder"] as const) if (k in b) {
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0) throw new ApiError("INVALID_AMOUNT", `${k} must be a non-negative whole number`, 400);
    out[k] = n;
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new ApiError("VALIDATION", "active must be true or false", 400);
    out.active = b.active;
  }
  if (!Object.keys(out).length) throw new ApiError("VALIDATION", "nothing to update", 400);
  return out;
}

/**
 * Add-on catalog / entitlements / requests routes (Issue 2). Reads + requests are open to any operator
 * (admin+) and scoped inside the RPCs (site admin = own brand; platform admin = its platform; system =
 * all). Price edits, request decisions, and direct grant/revoke are SYSTEM-owner-only.
 */
export function registerAddonRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.addons) return;
  const addons = deps.addons;
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");                    // admin / platform_admin / system
  const system = requireRole("platform_superadmin");     // system owner only

  // The brand a request/view targets: a site admin uses its own site claim; a platform admin / system
  // owner name a brand explicitly (?site= or body.site). The RPC re-checks scope regardless.
  const siteOf = (ctx: Ctx, explicit?: string): string => {
    const s = (explicit && explicit.trim()) || ctx.query.get("site")?.trim() || ctx.claims?.site || "";
    if (!s) throw new ApiError("VALIDATION", "site is required", 400);
    // Issue 1 / F-46: a site-tier token (genuine or impersonation) may only address ITS brand.
    if (ctx.claims?.role === "admin" && s !== adminScopeSite(ctx)) {
      throw new ApiError("SITE_SCOPE_FORBIDDEN", "SITE_SCOPE_FORBIDDEN: target belongs to another brand", 403);
    }
    return s;
  };

  // ── Catalog (any operator sees the systems + prices they could request) ────────────────────────
  router.get(`${BASE}/addons/catalog`, auth, admin, async (ctx: Ctx) =>
    ({ items: await domain(() => addons.catalog(ctx.claims!.role ?? "player")) }));

  // ── Brand view: the catalog annotated with entitled / active / pending for one brand ───────────
  router.get(`${BASE}/addons/brand`, auth, admin, async (ctx: Ctx) =>
    ({ items: await domain(() => addons.brandView(ctx.claims!.userId, ctx.claims!.role ?? "player", siteOf(ctx))) }));

  // ── Request an add-on for a brand (site admin: own; platform admin: its platform) ──────────────
  router.post(`${BASE}/addons/request`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const category = str(b, "category"), key = str(b, "key");
    if (!category || !key) throw new ApiError("VALIDATION", "category and key are required", 400);
    const note = str(b, "note") || null;
    return domain(() => addons.request(ctx.claims!.userId, ctx.claims!.role ?? "player", siteOf(ctx, b.site as string | undefined), category, key, note));
  });

  // ── List requests (scoped in the RPC) ──────────────────────────────────────────────────────────
  router.get(`${BASE}/addons/requests`, auth, admin, async (ctx: Ctx) =>
    ({ requests: await domain(() => addons.listRequests(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.query.get("status")?.trim() || null)) }));

  // ── Decide a request (SYSTEM owner only): approve => grant + charge; reject => notify ──────────
  router.post(`${BASE}/addons/requests/:id/decide`, auth, system, async (ctx: Ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError("INVALID_ID", "id must be a positive integer", 400);
    const b = asObject(ctx.body);
    const decision = str(b, "decision");
    if (decision !== "approve" && decision !== "reject") throw new ApiError("INVALID_DECISION", "decision must be 'approve' or 'reject'", 400);
    return domain(() => addons.decideRequest(ctx.claims!.userId, ctx.claims!.role ?? "player", id, decision, str(b, "note") || null));
  });

  // ── Set a price (SYSTEM owner only) ────────────────────────────────────────────────────────────
  router.put(`${BASE}/addons/price`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const category = str(b, "category"), key = str(b, "key");
    const priceCents = Number(b.priceCents);
    if (!category || !key) throw new ApiError("VALIDATION", "category and key are required", 400);
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new ApiError("INVALID_AMOUNT", "priceCents must be a non-negative integer", 400);
    return domain(() => addons.setPrice(ctx.claims!.userId, ctx.claims!.role ?? "player", category, key, priceCents));
  });

  // ── ADDON-1: edit a catalog item (SYSTEM owner only) ─────────────────────────────────────────────
  router.patch(`${BASE}/addons/catalog/:category/:key`, auth, system, async (ctx: Ctx) => {
    const category = ctx.params.category!, key = ctx.params.key!;
    if (!CATEGORIES.has(category)) throw new ApiError("ADDON_NOT_FOUND", "unknown category", 404);
    const patch = parseAddonPatch(ctx.body);
    return domain(() => addons.update(ctx.claims!.userId, ctx.claims!.role ?? "player", category, key, patch));
  });

  // ── ADDON-1: withdraw an open request (anyone who may request for that brand; scoped in the RPC) ──
  router.post(`${BASE}/addons/requests/:id/cancel`, auth, admin, async (ctx: Ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError("INVALID_ID", "id must be a positive integer", 400);
    return domain(() => addons.cancelRequest(ctx.claims!.userId, ctx.claims!.role ?? "player", id));
  });

  // ── ADDON-1: switch a brand to a chart / trade screen it owns ─────────────────────────────────────
  router.post(`${BASE}/addons/activate`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const category = str(b, "category"), key = str(b, "key");
    if (!category || !key) throw new ApiError("VALIDATION", "category and key are required", 400);
    return domain(() => addons.activate(ctx.claims!.userId, ctx.claims!.role ?? "player", siteOf(ctx, b.site as string | undefined), category, key));
  });

  // ── ADDON-1: brands with what they own and use (owner: all; platform admin: its platform) ────────
  router.get(`${BASE}/addons/brands`, auth, requireRole("platform_admin"), async (ctx: Ctx) =>
    ({ brands: await domain(() => addons.brands(ctx.claims!.userId, ctx.claims!.role ?? "player")) }));

  // ── Direct grant / revoke (SYSTEM owner only) ──────────────────────────────────────────────────
  router.post(`${BASE}/addons/grant`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const category = str(b, "category"), key = str(b, "key"), site = str(b, "site");
    if (!site || !category || !key) throw new ApiError("VALIDATION", "site, category and key are required", 400);
    return domain(() => addons.grant(ctx.claims!.userId, ctx.claims!.role ?? "player", site, category, key));
  });
  router.post(`${BASE}/addons/revoke`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const category = str(b, "category"), key = str(b, "key"), site = str(b, "site");
    if (!site || !category || !key) throw new ApiError("VALIDATION", "site, category and key are required", 400);
    return domain(() => addons.revoke(ctx.claims!.userId, ctx.claims!.role ?? "player", site, category, key));
  });
}

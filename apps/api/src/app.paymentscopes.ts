import { Router, ApiError, requireAuth, requireRole, adminScopePlatform, assertTargetPlatformInScope, type Ctx } from "./http.js";
import type { PaymentScopeService, ScopeType } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * PAY-1 (docs/43) — per-platform / per-brand payment accounts, for the System owner and platform admins.
 *
 *   GET    /platform/payment-scopes[?platform=]                       the platform + its brands, with live state
 *   GET    /platform/payment-scopes/:type/:id                         one scope: schemas, configs (masked), status, state
 *   PUT    /platform/payment-scopes/:type/:id/gateways/:code          save a gateway account (secrets write-only)
 *   POST   /platform/payment-scopes/:type/:id/gateways/:code/remove   remove it
 *   POST   /platform/payment-scopes/:type/:id/gateways/:code/test     SAFE connectivity test (moves no money)
 *   POST   /platform/payment-scopes/:type/:id/activate                go live on these accounts {payoutsEnabled?}
 *   POST   /platform/payment-scopes/:type/:id/deactivate              back to the System accounts
 *   POST   /platform/payment-scopes/site/:id/switches/:code           per-brand gateway on/off/inherit {enabled}
 *
 * A platform admin is confined to its own platform and that platform's brands — by the API here AND by
 * fn_payment_scope_assert in the database. Owner-only settings (sandbox, base/callback URLs, CIDRs) are
 * refused for platform admins in both layers too.
 */
const BASE = "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Readonly<Record<string, number>> = {
  NOT_AUTHORIZED: 403, PLATFORM_SCOPE_FORBIDDEN: 403, OWNER_ONLY_FIELD: 403, GATEWAY_NOT_ENTITLED: 403,
  SCOPE_NOT_FOUND: 404, PROVIDER_NOT_FOUND: 404, SITE_NOT_FOUND: 404,
  INVALID_SCOPE: 400, VALIDATION: 400, PROVIDER_NOT_CONFIGURABLE: 400,
  NO_DEPOSIT_RAIL_READY: 409, PAYOUTS_NOT_CONFIGURED: 409,
  ENC_KEY_NOT_CONFIGURED: 503,
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const e = err as Error & { issues?: { field: string; message: string }[] };
    const message = e instanceof Error ? e.message : String(err);
    const code = message.split(":")[0]!.trim();
    if (code === "VALIDATION" && Array.isArray(e.issues)) throw new ApiError("VALIDATION", e.issues.map((i) => `${i.field}: ${i.message}`).join("; "), 400);
    const status = STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function registerPaymentScopeRoutes(router: Router, deps: ApiDeps): void {
  const svc = deps.paymentScopes;
  const auth = requireAuth(deps.verifier);
  const platformTier = requireRole("platform_admin");   // + System owner by rank
  const need = (): PaymentScopeService => {
    if (!svc) throw new ApiError("NOT_CONFIGURED", "payment scopes are not available on this deployment", 503);
    return svc;
  };
  const scopeOf = (ctx: Ctx): { type: ScopeType; id: string } => {
    const type = ctx.params.type, id = ctx.params.id;
    if ((type !== "platform" && type !== "site") || !id || !UUID_RE.test(id)) throw new ApiError("INVALID_SCOPE", "scope must be platform|site and a valid id", 400);
    return { type, id };
  };
  const who = (ctx: Ctx) => [ctx.claims!.userId, ctx.claims!.role ?? "player"] as const;
  const platformOfScope = async (s: { type: ScopeType; id: string }): Promise<string> => {
    if (s.type === "platform") return s.id;
    const p = await deps.platform.platformOfSite(s.id);
    if (!p) throw new ApiError("SCOPE_NOT_FOUND", "unknown brand", 404);
    return p;
  };
  /** API fence (the DB re-checks): a platform admin only ever reaches its own platform and its brands. */
  const fenced = async (ctx: Ctx): Promise<{ type: ScopeType; id: string }> => {
    const s = scopeOf(ctx);
    if (adminScopePlatform(ctx) !== null) {
      const p = s.type === "platform" ? s.id : await deps.platform.platformOfSite(s.id);
      assertTargetPlatformInScope(ctx, p);   // unresolved -> PLATFORM_SCOPE_FORBIDDEN (fail closed)
    }
    return s;
  };

  router.get(`${BASE}/platform/payment-scopes`, auth, platformTier, async (ctx: Ctx) => {
    const scoped = adminScopePlatform(ctx);
    const raw = ctx.query.get("platform")?.trim();
    if (!scoped && raw && !UUID_RE.test(raw)) throw new ApiError("VALIDATION", "platform must be a platform id", 400);
    const platformId = scoped ?? raw ?? "10000000-0000-0000-0000-000000000001";
    const [a, r] = who(ctx);
    return { platformId, scopes: await domain(() => need().listScopes(a, r, platformId)) };
  });

  router.get(`${BASE}/platform/payment-scopes/:type/:id`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx); const service = need();
    return domain(async () => {
      const status = await service.status(a, r, s.type, s.id);   // authorizes first
      const schemas = service.schemas(r);
      const configs = Object.fromEntries(await Promise.all(Object.keys(schemas).map(async (c) => [c, await service.getConfig(a, r, c, s.type, s.id)] as const)));
      const state = (await service.listScopes(a, r, await platformOfScope(s))).find((x) => x.scopeType === s.type && x.scopeId === s.id) ?? null;
      // For a brand: the deposit rails its players can use RIGHT NOW (owner accounts + switches + entitlements).
      const liveRails = s.type === "site" ? (await deps.payments.listDepositProviders(s.id)).map((p) => p.code) : undefined;
      return { scope: s, state, schemas, configs, status, ...(liveRails ? { liveRails } : {}) };
    });
  });

  router.put(`${BASE}/platform/payment-scopes/:type/:id/gateways/:code`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx);
    return { config: await domain(() => need().setConfig(a, r, ctx.params.code!, s.type, s.id, asObject(ctx.body))) };
  });

  router.post(`${BASE}/platform/payment-scopes/:type/:id/gateways/:code/remove`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx);
    return { removed: await domain(() => need().clearConfig(a, r, ctx.params.code!, s.type, s.id)) };
  });

  router.post(`${BASE}/platform/payment-scopes/:type/:id/gateways/:code/test`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx);
    return { result: await domain(() => need().testConnection(a, r, ctx.params.code!, s.type, s.id, asObject(ctx.body))) };
  });

  router.post(`${BASE}/platform/payment-scopes/:type/:id/activate`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx);
    const b = asObject(ctx.body);
    if (b.payoutsEnabled !== undefined && typeof b.payoutsEnabled !== "boolean") throw new ApiError("VALIDATION", "payoutsEnabled must be a boolean", 400);
    const status = await domain(() => need().activate(a, r, s.type, s.id, b.payoutsEnabled !== false));
    return { active: true, payoutsEnabled: b.payoutsEnabled !== false, status };
  });

  router.post(`${BASE}/platform/payment-scopes/:type/:id/deactivate`, auth, platformTier, async (ctx: Ctx) => {
    const s = await fenced(ctx); const [a, r] = who(ctx);
    await domain(() => need().deactivate(a, r, s.type, s.id));
    return { active: false };
  });

  // Per-brand gateway switch for a platform admin's OWN brands (entitled gateways only — 0160).
  router.post(`${BASE}/platform/payment-scopes/site/:id/switches/:code`, auth, platformTier, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_SCOPE", "invalid brand id", 400);
    assertTargetPlatformInScope(ctx, await deps.platform.platformOfSite(id));   // API fence FIRST (the RPC re-checks)
    const b = asObject(ctx.body);
    if (b.enabled !== null && typeof b.enabled !== "boolean") throw new ApiError("VALIDATION", "enabled must be true, false or null (inherit)", 400);
    const [a, r] = who(ctx);
    await domain(async () => {
      if (b.enabled === null) await deps.platform.clearProviderSite(a, r, id, ctx.params.code!);
      else await deps.platform.setProviderSite(a, r, id, ctx.params.code!, b.enabled as boolean);
    });
    return { siteId: id, code: ctx.params.code, enabled: b.enabled };
  });
}

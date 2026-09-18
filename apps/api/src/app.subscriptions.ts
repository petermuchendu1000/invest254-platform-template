import { Router, ApiError, requireAuth, requireRole, adminScopePlatform, assertTargetPlatformInScope, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";
const STATUS: Record<string, number> = {
  NOT_AUTHORIZED: 403, PLATFORM_SCOPE_FORBIDDEN: 403, PLATFORM_NOT_FOUND: 404, PLAN_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_FOUND: 404, INVALID_STATUS: 400, INVALID_AMOUNT: 400, INVALID_PLAN: 400,
};
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    if (STATUS[code]) throw new ApiError(code, message, STATUS[code]!);
    throw err;
  }
}
function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}
const intOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

/**
 * Subscription + billing routes (Issue 2). Reads are scoped: a platform_admin sees only its OWN
 * platform's subscription/usage; the System owner sees any. All MUTATIONS (plan, status, payment)
 * are System-owner-only — billing is system scope (docs/38 §1).
 */
export function registerSubscriptionRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.subscriptions) return;
  const subs = deps.subscriptions;
  const auth = requireAuth(deps.verifier);
  const padmin = requireRole("platform_admin");        // platform admin + system
  const system = requireRole("platform_superadmin");

  // Assert the caller may read this platform's billing (system = any; platform_admin = own only).
  const scopeRead = (ctx: Ctx, platformId: string) => {
    if (adminScopePlatform(ctx) === null) return;       // system owner
    assertTargetPlatformInScope(ctx, platformId);
  };
  const callerPlatform = (ctx: Ctx): string => {
    const p = ctx.claims?.platform;
    if (!p) throw new ApiError("NO_PLATFORM", "this account is not scoped to a platform", 400);
    return p;
  };

  // Plan catalog (pricing) — any platform admin or the system owner.
  router.get(`${BASE}/platform/subscription-plans`, auth, padmin, async () =>
    ({ plans: await domain(() => subs.listPlans()) }));

  // The caller's OWN platform subscription + usage (platform-admin convenience).
  router.get(`${BASE}/platform/subscriptions/me`, auth, padmin, async (ctx: Ctx) => {
    const pid = adminScopePlatform(ctx) === null ? (ctx.query.get("platform") ?? "") : callerPlatform(ctx);
    if (!pid) throw new ApiError("VALIDATION", "platform is required for the system owner", 400);
    return { subscription: await domain(() => subs.getSubscription(pid)), usage: await domain(() => subs.usage(pid)) };
  });

  router.get(`${BASE}/platform/subscriptions/:id`, auth, padmin, async (ctx: Ctx) => {
    scopeRead(ctx, ctx.params.id!);
    return { subscription: await domain(() => subs.getSubscription(ctx.params.id!)), usage: await domain(() => subs.usage(ctx.params.id!)) };
  });

  router.get(`${BASE}/platform/subscriptions/:id/events`, auth, padmin, async (ctx: Ctx) => {
    scopeRead(ctx, ctx.params.id!);
    const limit = Math.min(200, Math.max(1, Number(ctx.query.get("limit") ?? "50") || 50));
    return { events: await domain(() => subs.listEvents(ctx.params.id!, limit)) };
  });

  // ── System-owner-only mutations ──
  router.post(`${BASE}/platform/subscriptions/:id/plan`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.planKey !== "string" || !b.planKey) throw new ApiError("VALIDATION", "planKey is required", 400);
    return domain(() => subs.setPlan(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, b.planKey as string,
      intOrNull(b.customPriceCents), intOrNull(b.customMaxSites), intOrNull(b.customMaxUsers)));
  });
  router.post(`${BASE}/platform/subscriptions/:id/status`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.status !== "string") throw new ApiError("VALIDATION", "status is required", 400);
    return domain(() => subs.setStatus(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, b.status as string,
      typeof b.reason === "string" ? b.reason : null));
  });
  router.post(`${BASE}/platform/subscriptions/:id/payment`, auth, system, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const amount = Number(b.amountCents);
    if (!Number.isFinite(amount) || amount < 0) throw new ApiError("VALIDATION", "amountCents must be a non-negative integer", 400);
    return domain(() => subs.recordPayment(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, Math.round(amount),
      b.periodDays == null ? null : Number(b.periodDays)));
  });
}

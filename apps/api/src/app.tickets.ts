import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";
const STATUS: Record<string, number> = {
  NOT_AUTHORIZED: 403, PLATFORM_SCOPE_FORBIDDEN: 403,
  TICKET_NOT_FOUND: 404, TICKET_NOT_FOUND_OR_FORBIDDEN: 404, PLATFORM_NOT_FOUND: 404,
  INVALID_SUBJECT: 400, INVALID_URGENCY: 400, INVALID_BODY: 400, INVALID_STATUS: 400, INVALID_PLATFORM: 400,
  ALREADY_AT_TOP_LEVEL: 409,
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
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Internal escalation ticketing routes (Issue 2). Any authorized admin may raise a ticket; the
 * service/RPC layer derives the platform, assigns the platform admin (or System for a platform-admin
 * issuer), and enforces scope on every read/act (system=all, platform_admin=own platform, site
 * admin=own). requireRole("admin") admits admin/platform_admin/platform_superadmin; finer scope is
 * enforced below the transport.
 */
export function registerTicketRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.tickets) return;
  const t = deps.tickets;
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");
  const actor = (ctx: Ctx) => [ctx.claims!.userId, ctx.claims!.role ?? "player"] as const;

  router.post(`${BASE}/tickets`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.subject !== "string" || !b.subject.trim()) throw new ApiError("VALIDATION", "subject is required", 400);
    if (typeof b.urgency !== "string") throw new ApiError("VALIDATION", "urgency is required", 400);
    const [a, r] = actor(ctx);
    return { status: 201, body: await domain(() => t.create(a, r, str(b.platformId), str(b.siteId), b.subject as string, typeof b.body === "string" ? b.body : "", b.urgency as string)) };
  });

  router.get(`${BASE}/tickets`, auth, admin, async (ctx: Ctx) => {
    const [a, r] = actor(ctx);
    return { tickets: await domain(() => t.list(a, r, {
      status: ctx.query.get("status") ?? undefined,
      urgency: ctx.query.get("urgency") ?? undefined,
      limit: Number(ctx.query.get("limit") ?? "50") || 50,
    })) };
  });

  router.get(`${BASE}/tickets/:id`, auth, admin, async (ctx: Ctx) => {
    const [a, r] = actor(ctx);
    return domain(() => t.get(a, r, ctx.params.id!));
  });

  router.post(`${BASE}/tickets/:id/comments`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.body !== "string" || !b.body.trim()) throw new ApiError("VALIDATION", "body is required", 400);
    const [a, r] = actor(ctx);
    return { status: 201, body: await domain(() => t.addComment(a, r, ctx.params.id!, b.body as string)) };
  });

  router.post(`${BASE}/tickets/:id/status`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    if (typeof b.status !== "string") throw new ApiError("VALIDATION", "status is required", 400);
    const [a, r] = actor(ctx);
    return { ticket: await domain(() => t.setStatus(a, r, ctx.params.id!, b.status as string, typeof b.note === "string" ? b.note : null)) };
  });

  router.post(`${BASE}/tickets/:id/escalate`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const [a, r] = actor(ctx);
    return { ticket: await domain(() => t.escalate(a, r, ctx.params.id!, typeof b.note === "string" ? b.note : null)) };
  });
}

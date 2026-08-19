import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { NotificationRow, NotificationLevel } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * User-notification routes.
 *  Player (auth):
 *   - GET  /notifications                 my active banners (newest first)
 *   - POST /notifications/:id/dismiss      clear a dismissible banner (blocking ones 409)
 *  Admin (admin-gated):
 *   - POST   /admin/users/:id/notifications   raise a notification for a user
 *   - GET    /admin/users/:id/notifications   list a user's notifications (incl. inactive)
 *   - DELETE /admin/notifications/:id          resolve (clear) a notification (esp. blocking)
 */
const BASE = "/api/v1";
const LEVELS: ReadonlySet<string> = new Set(["info", "success", "warning", "error"]);

function notificationDto(r: NotificationRow) {
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    body: r.body,
    dismissible: r.dismissible,
    category: r.category,
    createdAtMs: r.createdAtMs,
    dismissedAtMs: r.dismissedAtMs,
    resolvedAtMs: r.resolvedAtMs,
  };
}

function parseId(ctx: Ctx): number {
  const n = Number(ctx.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("INVALID_ID", "id must be a positive integer", 400);
  return n;
}

export function registerNotificationRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");

  // ── Player ─────────────────────────────────────────────────────────────
  router.get(`${BASE}/notifications`, auth, async (ctx: Ctx) => {
    const rows = await deps.notifications.listActive(ctx.claims!.userId);
    return { items: rows.map(notificationDto) };
  });

  router.post(`${BASE}/notifications/:id/dismiss`, auth, async (ctx: Ctx) => {
    const ok = await deps.notifications.dismiss(ctx.claims!.userId, parseId(ctx));
    // A blocking (non-dismissible) or already-cleared/unknown row cannot be dismissed by the player.
    if (!ok) throw new ApiError("NOT_DISMISSIBLE", "this notification cannot be dismissed", 409);
    return { dismissed: true };
  });

  // ── Admin ──────────────────────────────────────────────────────────────
  router.post(`${BASE}/admin/users/:id/notifications`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new ApiError("VALIDATION", "title is required", 400);
    if (title.length > 120) throw new ApiError("VALIDATION", "title must be <= 120 chars", 400);
    const level = typeof body.level === "string" && LEVELS.has(body.level) ? (body.level as NotificationLevel) : "info";
    const bodyText = typeof body.body === "string" ? body.body.slice(0, 1000) : "";
    // dismissible defaults to true; pass false for blocking (suspension-style) notices.
    const dismissible = body.dismissible === undefined ? true : Boolean(body.dismissible);
    const category = typeof body.category === "string" && body.category ? body.category.slice(0, 64) : null;
    const row = await deps.notifications.create({
      userId: ctx.params.id!, title, body: bodyText, level, dismissible, category, createdBy: ctx.claims!.userId,
    });
    await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "notification.create", "user", ctx.params.id!, {
      notificationId: row.id, level, dismissible, category,
    });
    return { status: 201, body: notificationDto(row) };
  });

  router.get(`${BASE}/admin/users/:id/notifications`, auth, admin, async (ctx: Ctx) => {
    const rows = await deps.notifications.adminList(ctx.params.id!, true, 100);
    return { items: rows.map(notificationDto) };
  });

  router.post(`${BASE}/admin/notifications/:id/resolve`, auth, admin, async (ctx: Ctx) => {
    const id = parseId(ctx);
    const ok = await deps.notifications.resolve(id);
    if (!ok) throw new ApiError("NOT_FOUND", "notification not found or already cleared", 404);
    await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "notification.resolve", "notification", String(id), {});
    return { resolved: true };
  });
}

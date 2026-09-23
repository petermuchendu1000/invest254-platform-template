import { Router, ApiError, requireAuth, requireRole, type Ctx } from "./http.js";
import type { WebPushSubscriptionJson } from "@invest254/engine";
import type { ApiDeps } from "./app.js";

/**
 * Admin Web Push subscription routes (Issue 1). An admin device opts in to real-time
 * withdrawal-request alerts:
 *   GET    /admin/push/public-key   VAPID public key the client needs to create a subscription
 *                                   (returns { key: null } when push is not configured server-side)
 *   POST   /admin/push/subscribe    store this browser's PushSubscription (admin-gated, site-scoped)
 *   POST   /admin/push/unsubscribe  remove this browser's subscription (unsubscribe / logout)
 *
 * The actual fan-out (send a push when a withdrawal is requested) is wired in server.ts via
 * PaymentEvents.onWithdrawalRequested -> PushService.notifyWithdrawalRequested; this module owns
 * only the subscription lifecycle. All routes are admin-gated. WHO is alerted for a brand is decided at
 * send time from each subscriber's LIVE profile (engine `mayReceiveWithdrawalAlert`, Issue 1 / F-48),
 * not from the site claim stored here; unsubscribe removes only the caller's own device row.
 */
const BASE = "/api/v1";

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new ApiError("VALIDATION", "JSON body required", 400);
  return body as Record<string, unknown>;
}

/** Validate the browser-produced PushSubscription JSON: { endpoint, keys: { p256dh, auth } }. */
function parseSubscription(body: unknown): WebPushSubscriptionJson {
  const b = asObject(body);
  const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
  if (!endpoint || !/^https:\/\//i.test(endpoint)) throw new ApiError("VALIDATION", "endpoint must be an https URL", 400);
  if (endpoint.length > 2048) throw new ApiError("VALIDATION", "endpoint too long", 400);
  const keys = b.keys && typeof b.keys === "object" ? (b.keys as Record<string, unknown>) : {};
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
  if (!p256dh || !auth) throw new ApiError("VALIDATION", "keys.p256dh and keys.auth are required", 400);
  return { endpoint, keys: { p256dh, auth } };
}

export function registerPushRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.push) return; // push not wired (e.g. a deployment without VAPID) — routes stay absent
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");
  const push = deps.push;

  router.get(`${BASE}/admin/push/public-key`, auth, admin, async () => {
    return { key: push.publicKey() };
  });

  router.post(`${BASE}/admin/push/subscribe`, auth, admin, async (ctx: Ctx) => {
    const sub = parseSubscription(ctx.body);
    const ua = ctx.req.headers["user-agent"];
    await push.upsert({
      userId: ctx.claims!.userId,
      siteId: ctx.claims!.site ?? null,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: typeof ua === "string" ? ua.slice(0, 400) : null,
    });
    return { status: 201, body: { subscribed: true } };
  });

  router.post(`${BASE}/admin/push/unsubscribe`, auth, admin, async (ctx: Ctx) => {
    const b = asObject(ctx.body);
    const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
    if (!endpoint) throw new ApiError("VALIDATION", "endpoint is required", 400);
    // Issue 1 / F-48: removes only the CALLER'S OWN device row — an endpoint belonging to another admin
    // is untouched (it used to be deleted for anyone who knew it, silencing that admin's alerts).
    const removed = await push.removeForUser(endpoint, ctx.claims!.userId);
    return { unsubscribed: removed > 0 };
  });
}

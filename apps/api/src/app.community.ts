import { Router, ApiError, requireAuth, requireSite, requireSiteAdmin, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

const BASE = "/api/v1";
const MAX_POSTS = 50;

/**
 * The per-brand community channel (migration 0192).
 *
 * READ is for any signed-in player of the brand; WRITE is admin only, which is what makes this a
 * channel rather than a group. Every route is brand-scoped through `requireSite`, and the store's
 * own statements re-check the site id, so a post id from another brand matches nothing even if it
 * is guessed correctly.
 */
export function registerCommunityRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  const admin = requireSiteAdmin("admin");

  const store = () => {
    if (!deps.community) throw new ApiError("NOT_AVAILABLE", "the community is not available", 501);
    return deps.community;
  };
  const obj = (ctx: Ctx): Record<string, unknown> =>
    ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};

  /** The channel, newest first with pinned on top. The viewer's own vote rides on each poll. */
  router.get(`${BASE}/community`, auth, site, async (ctx: Ctx) => {
    const raw = Number.parseInt(ctx.query.get("limit") ?? "", 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_POSTS) : 30;
    return { items: await store().list(ctx.siteId!, ctx.claims!.userId, limit) };
  });

  /** One vote per player per poll; voting again changes the answer rather than adding one. */
  router.post(`${BASE}/community/:id/vote`, auth, site, async (ctx: Ctx) => {
    const optionId = obj(ctx).optionId;
    if (typeof optionId !== "string" || !optionId) throw new ApiError("VALIDATION", "optionId is required", 400);
    try {
      return await store().vote(ctx.siteId!, ctx.params.id!, ctx.claims!.userId, optionId);
    } catch (e) {
      // The statement refuses by matching nothing: a closed poll, a post from another brand, or an
      // option that belongs to a different post all land here.
      if (e instanceof Error && e.message === "VOTE_REFUSED") {
        throw new ApiError("VOTE_REFUSED", "this poll is closed or that option is not on it", 409);
      }
      throw e;
    }
  });

  // ── Admin: the only writers. ──────────────────────────────────────────────────────────────────
  router.post(`${BASE}/community`, auth, site, admin, async (ctx: Ctx) => {
    const b = obj(ctx);
    const body = typeof b.body === "string" ? b.body.trim() : "";
    const kind = b.kind === "poll" ? "poll" : "post";
    if (!body) throw new ApiError("VALIDATION", "body is required", 400);
    const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === "string") : [];
    try {
      return await store().post(ctx.siteId!, ctx.claims!.userId, {
        kind, body,
        title: typeof b.title === "string" ? b.title : null,
        options,
        pinned: b.pinned === true,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "POLL_NEEDS_OPTIONS") {
        throw new ApiError("VALIDATION", "a poll needs at least two options", 400);
      }
      throw e;
    }
  });

  router.post(`${BASE}/community/:id/pin`, auth, site, admin, async (ctx: Ctx) => {
    await store().setPinned(ctx.siteId!, ctx.params.id!, obj(ctx).pinned !== false);
    return { ok: true };
  });

  router.post(`${BASE}/community/:id/close`, auth, site, admin, async (ctx: Ctx) => {
    await store().setClosed(ctx.siteId!, ctx.params.id!, obj(ctx).closed !== false);
    return { ok: true };
  });

  // POST rather than DELETE: this Router has no delete verb, and inventing one for a single route
  // would be a change to the HTTP layer rather than to this feature.
  router.post(`${BASE}/community/:id/delete`, auth, site, admin, async (ctx: Ctx) => {
    await store().remove(ctx.siteId!, ctx.params.id!);
    return { ok: true };
  });
}

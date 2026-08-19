import { Router, ApiError, requireAuth, requireRole, requireSite, assertTargetSiteInScope, rateLimit, DEFAULT_SITE_ID, type Ctx } from "./http.js";
import type { PageQuery } from "@invest254/engine";
import type { ApiDeps } from "./app.js";
import { parseB2cResult } from "./app.payments.js";

/**
 * Affiliate routes:
 *  - I1: `POST /affiliate/enroll` (marketer enrollment) + referral attribution at registration.
 *  - I2: `POST /admin/affiliate/accrue` (admin) runs the daily revenue-share accrual.
 *  - I3: marketer dashboard reads — `GET /affiliate/summary`, `/affiliate/referrals`,
 *    `/affiliate/commissions` (marketer-gated, cursor-paginated). Thin transport over the engine
 *    AffiliateService — invariants live in the 0017/0018 RPCs.
 */

const BASE = "/api/v1";

/** Daraja acknowledgement — any non-zero makes Safaricom retry, so callbacks always ack. */
const DARAJA_ACK = { ResultCode: 0, ResultDesc: "Accepted" } as const;

/** Affiliate domain-error code -> HTTP status. */
const AFFILIATE_STATUS: Readonly<Record<string, number>> = {
  USER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  NOT_AFFILIATE: 404,
  INVALID_PERIOD: 400,
  PAYOUT_NOT_FOUND: 404,
  NO_AVAILABLE_COMMISSION: 409,
  PAYOUT_PENDING: 409,
  B2C_UNAVAILABLE: 503,
};

/** Parse cursor pagination params from the query string (limit clamped by the repository). */
function pageQuery(ctx: Ctx): PageQuery {
  const limitRaw = ctx.query.get("limit");
  return { limit: limitRaw === null ? undefined : Number(limitRaw), cursor: ctx.query.get("cursor") };
}

/** Run an AffiliateService call, translating thrown domain error codes into controlled ApiErrors. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = AFFILIATE_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

/** Register the affiliate routes (enrollment + dashboard require a bearer token; accrual is admin). */
export function registerAffiliateRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");
  const marketer = requireRole("marketer");
  // Marketer-facing routes run under requireSite: a marketer's identity is brand-bound, so this
  // both makes ctx.siteId available and rejects a token that names a different brand (?site=).
  const site = requireSite();

  // Public referral-link click tracking (funnel stage 0, docs/19). Fire-and-forget from the
  // /r/<code> landing page BEFORE signup, so no auth. Tolerant: an unknown/inactive code is a
  // silent no-op (recorded:false) and never errors. IP rate-limited to blunt click-spam.
  const clickLimit = rateLimit({ name: "aff-click", by: "ip", limit: Number(process.env.RATE_LIMIT_AFF_CLICK_PER_MIN) || 60, windowMs: 60_000 });
  router.post(`${BASE}/affiliate/click`, clickLimit, async (ctx: Ctx) => {
    const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const code = typeof b.code === "string" ? b.code : "";
    if (!code.trim()) throw new ApiError("VALIDATION", "code is required", 400);
    // Optional brand: accept a site uuid directly, else resolve a slug/host to its brand.
    let siteId: string | undefined;
    const ref = typeof b.site === "string" && b.site.trim() ? b.site.trim() : undefined;
    if (ref) siteId = /^[0-9a-f-]{36}$/i.test(ref) ? ref : (await deps.brandByHost(ref.toLowerCase()))?.siteId;
    const recorded = await domain(() => deps.affiliate.recordClick(code.trim(), siteId));
    return { recorded };
  });

  router.post(`${BASE}/affiliate/enroll`, auth, site, async (ctx: Ctx) => {
    const e = await domain(() => deps.affiliate.enroll(ctx.claims!.userId));
    // Enrollment promotes player -> marketer in the DB, but the caller's JWT still carries the
    // old role. Reissue a token that reflects the new role so the marketer-gated dashboard routes
    // (summary/referrals/commissions/payouts) work immediately, without forcing a re-login.
    const token = deps.verifier ? await deps.auth.issueToken(ctx.claims!.userId, e.role) : undefined;
    return {
      referralCode: e.referralCode,
      commissionRate: e.commissionRate,
      status: e.status,
      role: e.role,
      referralPath: e.referralPath,
      ...(token ? { token } : {}),
    };
  });

  // ── Marketer dashboard (I3) ──
  router.get(`${BASE}/affiliate/summary`, auth, site, marketer, async (ctx: Ctx) =>
    domain(() => deps.affiliate.summary(ctx.claims!.userId)));

  router.get(`${BASE}/affiliate/referrals`, auth, site, marketer, async (ctx: Ctx) =>
    domain(() => deps.affiliate.listReferrals(ctx.claims!.userId, pageQuery(ctx))));

  router.get(`${BASE}/affiliate/commissions`, auth, site, marketer, async (ctx: Ctx) =>
    domain(() => deps.affiliate.listCommissions(ctx.claims!.userId, pageQuery(ctx))));

  // Transparency (0068): the marketer sees every expense an admin has logged against them
  // (TikTok promo, data bundles, advances, …). Read-only; own records only.
  router.get(`${BASE}/affiliate/expenses`, auth, site, marketer, async (ctx: Ctx) => {
    const limit = Number(ctx.query.get("limit")) || 100;
    const items = await domain(() => deps.marketerExpenses.list(ctx.claims!.userId, limit));
    return { items, totalCents: items.reduce((s, e) => s + e.amountCents, 0) };
  });

  // ── Payouts (I4): marketer request → admin approve/reject → M-Pesa B2C result ──
  router.post(`${BASE}/affiliate/payouts`, auth, site, marketer, async (ctx: Ctx) =>
    domain(async () => {
      const r = await deps.affiliate.requestPayout(ctx.claims!.userId);
      return { status: 201, body: { payoutId: r.payoutId, amountCents: r.amountCents } };
    }));

  // Approve/reject write an immutable admin_actions audit row (J6) so the payout queue decisions
  // are auditable alongside every other admin mutation.
  router.post(`${BASE}/admin/affiliate/payouts/:id/approve`, auth, admin, async (ctx: Ctx) =>
    domain(async () => {
      // Per-brand write-path guard (docs/22 Task H): a site-scoped finance admin only decides its
      // own brand's payouts. Tolerant of an unknown payout — the site-aware RPC remains the guard.
      assertTargetSiteInScope(ctx, await deps.affiliate.siteOfPayout(ctx.params.id!));
      const res = await deps.affiliate.approvePayout(ctx.params.id!, ctx.claims!.userId);
      await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "affiliate.payout.approve", "affiliate_payout", ctx.params.id!, res);
      return res;
    }));

  router.post(`${BASE}/admin/affiliate/payouts/:id/reject`, auth, admin, async (ctx: Ctx) =>
    domain(async () => {
      assertTargetSiteInScope(ctx, await deps.affiliate.siteOfPayout(ctx.params.id!));
      const rejected = await deps.affiliate.rejectPayout(ctx.params.id!, ctx.claims!.userId);
      await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "affiliate.payout.reject", "affiliate_payout", ctx.params.id!, { rejected });
      return { rejected };
    }));

  // Bulk: approve/reject many payout requests in one call. Each row is brand-guarded, audited, and
  // executed independently (partial success). Approval dispatches the M-Pesa B2C per row; the RPCs
  // are idempotent so a re-run over already-decided payouts is a safe no-op.
  router.post(`${BASE}/admin/affiliate/payouts/bulk`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const action = body.action === "approve" || body.action === "reject" ? body.action : "";
    if (!action) throw new ApiError("VALIDATION", "action must be 'approve' or 'reject'", 400);
    const raw = Array.isArray(body.payoutIds) ? body.payoutIds : [];
    const payoutIds = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (payoutIds.length === 0) throw new ApiError("VALIDATION", "payoutIds must be a non-empty array", 400);
    if (payoutIds.length > 200) throw new ApiError("VALIDATION", "at most 200 payouts per bulk action", 400);
    const actorId = ctx.claims!.userId;
    const actorRole = ctx.claims!.role ?? "player";
    const results = await Promise.all(payoutIds.map(async (id) => {
      try {
        assertTargetSiteInScope(ctx, await deps.affiliate.siteOfPayout(id));
        if (action === "approve") {
          const res = await deps.affiliate.approvePayout(id, actorId);
          await deps.admin.recordAction(actorId, actorRole, "affiliate.payout.approve", "affiliate_payout", id, res);
          return { id, ok: true, result: res };
        }
        const rejected = await deps.affiliate.rejectPayout(id, actorId);
        await deps.admin.recordAction(actorId, actorRole, "affiliate.payout.reject", "affiliate_payout", id, { rejected });
        return { id, ok: true, result: { rejected } };
      } catch (e) {
        const code = e instanceof ApiError ? e.code : (e as { message?: string })?.message ?? "ERROR";
        return { id, ok: false, error: code };
      }
    }));
    const okCount = results.filter((r) => r.ok).length;
    return { action, total: payoutIds.length, okCount, failCount: results.length - okCount, results };
  });

  // Public: Daraja B2C result for a payout (network-allowlisted at the edge). Always acks.
  router.post(`${BASE}/affiliate/payouts/mpesa/result/:payoutId`, async (ctx: Ctx) => {
    const r = parseB2cResult(ctx.body);
    await domain(() => deps.affiliate.completePayout(ctx.params.payoutId!, r.resultCode, r.conversationId, r.receipt, null, ctx.body));
    return DARAJA_ACK;
  });

  // ── Marketer expenses (0068): admin logs a cost against a marketer; both admin and the marketer see it ──
  router.post(`${BASE}/admin/affiliate/expenses`, auth, admin, async (ctx: Ctx) => {
    const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const marketerUserId = typeof b.marketerUserId === "string" && b.marketerUserId.trim() ? b.marketerUserId.trim() : "";
    if (!marketerUserId) throw new ApiError("VALIDATION", "marketerUserId is required", 400);
    const category = typeof b.category === "string" && b.category.trim() ? b.category.trim() : "";
    if (!category) throw new ApiError("VALIDATION", "category is required", 400);
    const amountCents = typeof b.amountCents === "number" ? b.amountCents : Number(b.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ApiError("VALIDATION", "amountCents must be a positive integer (cents)", 400);
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
    const siteId = ctx.claims?.site ?? DEFAULT_SITE_ID;
    return domain(() => deps.marketerExpenses.add(ctx.claims!.userId, ctx.claims!.role ?? "player", siteId, marketerUserId, category, amountCents, note));
  });

  router.get(`${BASE}/admin/affiliate/expenses`, auth, admin, async (ctx: Ctx) => {
    const marketerUserId = ctx.query.get("marketerUserId");
    if (!marketerUserId) throw new ApiError("VALIDATION", "marketerUserId query param is required", 400);
    const limit = Number(ctx.query.get("limit")) || 100;
    const items = await domain(() => deps.marketerExpenses.list(marketerUserId, limit));
    return { items, totalCents: items.reduce((s, e) => s + e.amountCents, 0) };
  });

  // Operational: run the daily revenue-share accrual for a trading day (idempotent). In
  // production a daily cron calls this (or the RPC directly via service role).
  router.post(`${BASE}/admin/affiliate/accrue`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const period = body.date;
    if (typeof period !== "string") throw new ApiError("VALIDATION", "date (YYYY-MM-DD) is required", 400);
    // Optional `site` (brand uuid) scopes the accrual to one brand; omit to accrue every brand
    // (platform-wide cron). A site-scoped operator console (Task H) will pass its own brand here.
    const site = body.site;
    if (site !== undefined && typeof site !== "string") throw new ApiError("VALIDATION", "site must be a brand id string", 400);
    const r = await domain(() => deps.affiliate.accrueDaily(period, site));
    return { period, site: site ?? null, buckets: r.buckets, totalCommissionCents: r.totalCommissionCents };
  });
}

import { Router, ApiError, requireAuth, requireRole, requireSiteAdmin, requireSite, requireEarningRole, adminScopeSite, adminListSite, rateLimit, restrictToCidrs, DEFAULT_SITE_ID, type Ctx } from "./http.js";
import { assertUserTarget, assertSiteTarget } from "./scope.js";
import type { PageQuery } from "@invest254/engine";
import type { ApiDeps } from "./app.js";
import type { LiveSession } from "./livesessions.pg.js";
import type { MarketerMoneyRepo, MoneyRangeBounds } from "./referral.pg.js";
import { parseB2cResult } from "./app.payments.js";
import { requireApprovalPassword } from "./approvalgate.js";

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
  OPERATOR_NOT_ELIGIBLE: 403,   // docs/42 UI-12 (DB: fn_affiliate_enroll refuses operator profiles)
  INVALID_PERIOD: 400,
  PAYOUT_NOT_FOUND: 404,
  NO_AVAILABLE_COMMISSION: 409,
  PAYOUT_PENDING: 409,
  B2C_UNAVAILABLE: 503,
  // Advance-request lifecycle (migration 0122)
  ADVANCE_PENDING: 409,
  INVALID_AMOUNT: 400,
  INVALID_STATE: 409,
  NOT_AUTHORIZED: 403,
  // Marketer expenses (0068/0154): the DB refuses an expense outside the marketer's brand.
  CATEGORY_REQUIRED: 400,
  MARKETER_NOT_FOUND: 404,
  MARKETER_SITE_MISMATCH: 403,
};

/** Parse cursor pagination params from the query string (limit clamped by the repository). */
function pageQuery(ctx: Ctx): PageQuery {
  const limitRaw = ctx.query.get("limit");
  return { limit: limitRaw === null ? undefined : Number(limitRaw), cursor: ctx.query.get("cursor") };
}

// ── The marketer money table's range filter ─────────────────────────────────────────────────────
//
// CONVENTION REUSED (quoted so the next reader does not have to go looking). The bounds this enum
// resolves to are the admin money-report convention, `reportRange` in app.admin.ts:112-126 and
// `PgAdminRepo.reportDaily` in apps/engine/src/admin.ts:1104-1138:
//
//     and ($1::date is null or (created_at at time zone 'Africa/Nairobi')::date >= $1::date)
//     and ($2::date is null or (created_at at time zone 'Africa/Nairobi')::date <= $2::date)
//
// i.e. inclusive `YYYY-MM-DD` bounds [from, to] (NOT half-open), `null` meaning unbounded on that
// side, and the day boundary taken in EAT — the brand's own day. "Today (EAT)" is spelled exactly
// as the admin day explorer spells it (app.admin.ts:625):
//     new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" })
// The response ECHOES the resolved window (`{ range, from, to }`), following
// `GET /platform/performance` (app.platform.ts:480-495) and `GET /site/leaderboard`
// (app.activity.ts:55-60) — a UI showing a windowed figure must be able to label what it is showing.
//
// The trailing-window lengths match the client-side period resolver the app already ships,
// `periodRange` in apps/web/src/lib/history/mt5history.ts:66-140 (`week: today - 6 * DAY_MS`,
// `month: today - 29 * DAY_MS`, `quarter: today - 89 * DAY_MS`): N days ENDING TODAY, inclusive.
// They are named `7d`/`30d`/`90d`/`180d` rather than `week`/`month` on purpose — the leaderboard's
// `week`/`month` (activity.pg.ts:62-68) are calendar-TO-DATE (`date_trunc('week', now())`), which is
// a different window, and reusing those names for a trailing one would be a trap.
//
// DEPARTURE, deliberate: the leaderboard reads an unknown `period` as `today` rather than refusing,
// because "it reaches this from a tab, and a bad tab should show a board, not an error"
// (app.activity.ts:44-45). This is a money statement, not a board: a range we did not understand
// must not be silently answered with a different range's figures, so an unknown value is a 400 in
// the style of the report parser's own `INVALID_DATE`/`INVALID_RANGE` refusals (app.admin.ts:131-137).
export const MONEY_RANGES = ["today", "yesterday", "7d", "30d", "90d", "180d", "all"] as const;
export type MoneyRangeKey = (typeof MONEY_RANGES)[number];

/** Trailing window length in days, INCLUDING today (so `7d` is today and the six days before it). */
const TRAILING_DAYS: Readonly<Record<string, number>> = { "7d": 7, "30d": 30, "90d": 90, "180d": 180 };

/** The EAT (Africa/Nairobi, UTC+3, no DST) calendar date for an instant — the brand's own day key. */
function eatDay(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

/** Shift a `YYYY-MM-DD` calendar date by whole days (date arithmetic only — no clock, no zone). */
function shiftDay(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days)).toISOString().slice(0, 10);
}

/** Resolve a range key to inclusive EAT date bounds; `all` is unbounded on both sides. */
export function resolveMoneyRange(key: MoneyRangeKey, nowMs: number): MoneyRangeBounds {
  if (key === "all") return { from: null, to: null };
  const today = eatDay(nowMs);
  if (key === "today") return { from: today, to: today };
  if (key === "yesterday") { const y = shiftDay(today, -1); return { from: y, to: y }; }
  return { from: shiftDay(today, -(TRAILING_DAYS[key] as number) + 1), to: today };
}

/** Parse `?range=` as a CLOSED enum. Absent means today; anything unrecognised is refused (400). */
export function moneyRangeOf(ctx: Ctx): MoneyRangeKey {
  const raw = ctx.query.get("range");
  if (raw === null || raw.trim() === "") return "today";
  const key = raw.trim().toLowerCase();
  if (!(MONEY_RANGES as readonly string[]).includes(key)) {
    throw new ApiError("INVALID_RANGE", `range must be one of ${MONEY_RANGES.join("|")}`, 400);
  }
  return key as MoneyRangeKey;
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
  const admin = requireSiteAdmin("admin");
  // Marketer earning routes: EXACTLY a marketer. requireRole is a minimum rank (an admin would pass),
  // so requireEarningRole also refuses every operator tier (docs/42 UI-12: operators are never affiliates).
  const earner = requireEarningRole();
  const marketerRank = requireRole("marketer");
  const marketer = async (ctx: Ctx) => { await earner(ctx); await marketerRank(ctx); };
  // Marketer-facing routes run under requireSite: a marketer's identity is brand-bound, so this
  // both makes ctx.siteId available and rejects a token that names a different brand (?site=).
  const site = requireSite();
  // F-44: tier-aware, fail-closed target scope for marketer-addressed admin routes (scope.ts).
  const scope = { siteOfUser: (id: string) => deps.admin.siteOfUser(id), platformOfSite: (s: string) => deps.platform.platformOfSite(s) };
  const strictScope = scope;
  // Lock the public Daraja B2C payout-result callback to Safaricom's source IPs when
  // MPESA_CALLBACK_ALLOWED_CIDRS is set — the same guard, the same env var and the same
  // fail-open-when-unset semantics as the payment callbacks in app.payments.ts.
  const darajaOnly = restrictToCidrs("MPESA_CALLBACK_ALLOWED_CIDRS");

  // Public referral-link click tracking (funnel stage 0, docs/19). Fire-and-forget from the
  // /r/<code> landing page BEFORE signup, so no auth. Tolerant: an unknown/inactive code is a
  // silent no-op and never errors — and the response does not say which (see below). IP
  // rate-limited to blunt click-spam.
  const clickLimit = rateLimit({ name: "aff-click", by: "ip", limit: Number(process.env.RATE_LIMIT_AFF_CLICK_PER_MIN) || 60, windowMs: 60_000 });
  router.post(`${BASE}/affiliate/click`, clickLimit, async (ctx: Ctx) => {
    const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const code = typeof b.code === "string" ? b.code : "";
    if (!code.trim()) throw new ApiError("VALIDATION", "code is required", 400);
    // Optional brand: accept a site uuid directly, else resolve a slug/host to its brand.
    let siteId: string | undefined;
    const ref = typeof b.site === "string" && b.site.trim() ? b.site.trim() : undefined;
    if (ref) siteId = /^[0-9a-f-]{36}$/i.test(ref) ? ref : (await deps.brandByHost(ref.toLowerCase()))?.siteId;
    // Record only real codes (unchanged server-side), but NEVER tell the caller which it was: the
    // old `recorded:false` made this unauthenticated endpoint a free oracle for enumerating the
    // live referral-code space across every brand — the input to commission fraud (seed a funnel
    // with harvested codes) and a privacy leak about which marketers exist. The response is
    // deliberately uninformative and constant; the real outcome is in the funnel data, which only
    // the owning marketer can read via /affiliate/summary.
    await domain(() => deps.affiliate.recordClick(code.trim(), siteId));
    return { recorded: true };
  });

  router.post(`${BASE}/affiliate/enroll`, auth, earner, site, async (ctx: Ctx) => {
    const e = await domain(() => deps.affiliate.enroll(ctx.claims!.userId));
    // Enrollment promotes player -> marketer in the DB, but the caller's JWT still carries the
    // old role. Reissue a token that reflects the new role so the marketer-gated dashboard routes
    // (summary/referrals/commissions/payouts) work immediately, without forcing a re-login.
    // Scope-preserving re-mint (Issue 1 / F-43): the new token keeps the account's brand claim.
    const token = deps.verifier ? (await deps.auth.issueSessionToken(ctx.claims!.userId)).token : undefined;
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
    // `items` is a display PAGE; `totalCents` must be the FULL sum of every logged expense so it
    // reconciles with the withdrawable (fn_commission_balance nets the full sum). Never sum the page
    // (it under-counts past the limit — BUGLOG #23).
    const [items, totalCents] = await domain(async () => Promise.all([
      deps.marketerExpenses.list(ctx.claims!.userId, limit),
      deps.marketerExpenses.total(ctx.claims!.userId),
    ]));
    return { items, totalCents };
  });

  /**
   * ── The marketer's money, as a range-filterable statement (the /dashboard money table) ────────
   *
   * IDENTITY: gated `auth, site, marketer` — the same gate as every other route on this dashboard —
   * so `ctx.claims!.userId` is the AFFILIATE marketer's `profiles.id`, which is the key on
   * `deposit_commissions.beneficiary_user`, `marketer_expenses.marketer_user_id`,
   * `marketer_advance_requests.marketer_user_id` and `commission_payouts.beneficiary_user` (see the
   * identity note above and the schema citations in referral.pg.ts). It is NOT the `public.marketers`
   * till-app id; gating this on `requireMarketer` would 403 the dashboard's own marketer.
   *
   * LIFETIME vs WINDOWED. The response carries BOTH, separately named, and never mixes them:
   *   - `lifetime` is the authoritative ladder behind the hero: earned − expenses − paid − held,
   *     floored at 0 by fn_commission_balance, over ALL time. fn_commission_balance takes only
   *     (p_user uuid); there is no ranged variant and this route does not invent one, because
   *     "Available to withdraw" is a lifetime balance and a windowed "available" would be a
   *     different, unpayable number.
   *   - `window` is what happened inside [from, to]. Its own figures reconcile among themselves, and
   *     the response echoes `{ range, from, to }` so the client can label every windowed figure as
   *     windowed. The two are never added together.
   *
   * BUGLOG #23: `commissions`/`expenses`/`advances` are limit-capped display PAGES; every total in
   * `window` and `lifetime` is an independent SQL aggregate over the full range. No total is derived
   * from a page.
   */
  const moneyRepo = (): MarketerMoneyRepo => {
    // The Postgres referral repo (makePgReferralRepo) implements this; an in-memory fake that does
    // not gets a refusal it can act on rather than a 500.
    const r = deps.referral as Partial<MarketerMoneyRepo>;
    if (typeof r.marketerMoney !== "function") {
      throw new ApiError("MONEY_UNAVAILABLE", "the ranged money statement is not configured", 503);
    }
    return r as MarketerMoneyRepo;
  };
  router.get(`${BASE}/affiliate/money`, auth, site, marketer, async (ctx: Ctx) => {
    const range = moneyRangeOf(ctx);                      // closed enum, parsed here; bad value -> 400
    const bounds = resolveMoneyRange(range, Date.now());
    const raw = Number(ctx.query.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 50;
    const statement = await domain(() => moneyRepo().marketerMoney(ctx.claims!.userId, bounds, limit));
    return { range, from: bounds.from, to: bounds.to, limit, ...statement };
  });

  /**
   * ── LIVE SESSIONS (0191). A marketer marks when they are live; the window reports what they
   *    already earned inside it. Reporting only — attribution is unchanged. ──────────────────
   *
   * These live HERE, under the affiliate gate, and not beside the `public.marketers` routes, which
   * is where they were first written and where they could never have worked. The two "marketers"
   * in this codebase are different entities:
   *
   *   - `public.marketers` — the field-agent till app, its own table, its own PIN login, whose
   *     token subject is a `marketers.id` and whose money lives in `marketer_wallets`.
   *   - a `profiles` row with role='marketer' — the affiliate who earns `deposit_commissions` and
   *     reads the /dashboard this panel is mounted on. Its token subject is a `profiles.id`.
   *
   * Everything a live session touches is keyed to the SECOND one: `marketer_live_sessions
   * .marketer_id` and `community_posts.author_id` both reference `profiles(id)`, and
   * `deposit_commissions.beneficiary_user` — the column the earnings join matches on — is a
   * `profiles.id` too. Gated by `requireMarketer` (the till app) the dashboard's own marketer got
   * 403 NOT_MARKETER, so the panel rendered nothing and Start Live never appeared; a till-app token
   * that did reach it would have failed the foreign key with a 500. Same gate as every other route
   * on this dashboard now, so the id the store receives is the id the schema expects.
   */
  const liveStore = () => {
    if (!deps.liveSessions) throw new ApiError("LIVE_UNAVAILABLE", "live sessions are not configured", 503);
    return deps.liveSessions;
  };
  /** A refusal the marketer can act on, rather than a 500. */
  const liveError = (e: unknown): never => {
    const m = e instanceof Error ? e.message : "";
    if (m === "LIVE_DISABLED") throw new ApiError("LIVE_DISABLED", "live sessions are off for this brand", 409);
    if (m === "ALREADY_LIVE") throw new ApiError("ALREADY_LIVE", "a session is already running", 409);
    if (m === "DAILY_LIMIT_REACHED") throw new ApiError("DAILY_LIMIT_REACHED", "no sessions left today", 409);
    throw e;
  };
  // requireSite has already rejected a token naming another brand, so ctx.siteId IS this marketer's
  // brand. DEFAULT_SITE_ID only covers a single-brand deployment that sends no site at all.
  const liveSiteId = (ctx: Ctx): string => ctx.siteId ?? DEFAULT_SITE_ID;

  /** The marketer's own view: the running session (if any), the brand's rules, and recent history. */
  router.get(`${BASE}/affiliate/live`, auth, site, marketer, async (ctx: Ctx) => {
    const siteId = liveSiteId(ctx);
    const store = liveStore();
    const [settings, current, history] = await Promise.all([
      store.settings(siteId),
      store.current(siteId, ctx.claims!.userId),
      store.history(siteId, ctx.claims!.userId, 20),
    ]);
    return { settings, current, history };
  });

  router.post(`${BASE}/affiliate/live/start`, auth, site, marketer, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const url = typeof body.streamUrl === "string" ? body.streamUrl : null;
    const siteId = liveSiteId(ctx);
    let session: LiveSession;
    try {
      session = await liveStore().start(siteId, ctx.claims!.userId, url);
    } catch (e) { return liveError(e); }

    /**
     * Going live tells the brand's players, in the app.
     *
     * This runs AFTER the session exists and never fails the request: a marketer who is about to
     * stream must not be told "you are not live" because a notification fan-out had a bad minute.
     * A session with no announcement is a working session; a refused Start Live is not.
     */
    try {
      // scopeNames is optional on ApiDeps; without it the copy stays brand-neutral rather than
      // naming the wrong brand, and the session is unaffected either way.
      const brandName = (deps.scopeNames ? (await deps.scopeNames(siteId, null)).siteName : null) ?? "We";
      if (deps.community) await deps.community.announceLive(siteId, ctx.claims!.userId, session.streamUrl, brandName);
      if (deps.notifications) {
        const { title, body: text } = liveAnnouncement(brandName, session.streamUrl);
        await deps.notifications.broadcast(
          ctx.claims!.userId, ctx.claims!.role ?? "marketer", "brand_live",
          // Every account on THIS brand, players only. The audience is brand-scoped inside
          // fn_broadcast_notification too, which is what stops one brand reaching another's people.
          { sites: [siteId], roles: ["player"] },
          { title, body: text },
        );
      }
    } catch {
      /* announced or not, the session is live — see the note above */
    }
    return session;
  });

  router.post(`${BASE}/affiliate/live/end`, auth, site, marketer, async (ctx: Ctx) => {
    const ended = await liveStore().end(liveSiteId(ctx), ctx.claims!.userId);
    if (!ended) throw new ApiError("NOT_LIVE", "no session to end", 409);
    return ended;
  });

  router.post(`${BASE}/affiliate/live/extend`, auth, site, marketer, async (ctx: Ctx) => {
    const extended = await liveStore().extend(liveSiteId(ctx), ctx.claims!.userId);
    if (!extended) throw new ApiError("NOT_LIVE", "no session to extend", 409);
    return extended;
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
      await assertSiteTarget(ctx, await deps.affiliate.siteOfPayout(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
      // docs/42 UI-1: approval dispatches REAL M-Pesa B2C -> system owner password, like every other rail.
      await requireApprovalPassword(ctx, deps.verifyApprovalPassword);
      const res = await deps.affiliate.approvePayout(ctx.params.id!, ctx.claims!.userId);
      await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "affiliate.payout.approve", "affiliate_payout", ctx.params.id!, res);
      return res;
    }));

  router.post(`${BASE}/admin/affiliate/payouts/:id/reject`, auth, admin, async (ctx: Ctx) =>
    domain(async () => {
      await assertSiteTarget(ctx, await deps.affiliate.siteOfPayout(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
      const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
      const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined;
      const rejected = await deps.affiliate.rejectPayout(ctx.params.id!, ctx.claims!.userId, reason);
      await deps.admin.recordAction(ctx.claims!.userId, ctx.claims!.role ?? "player", "affiliate.payout.reject", "affiliate_payout", ctx.params.id!, { rejected, reason: reason ?? null });
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
    if (action === "approve") await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // UI-1: one password per batch
    const actorId = ctx.claims!.userId;
    const actorRole = ctx.claims!.role ?? "player";
    const results = await Promise.all(payoutIds.map(async (id) => {
      try {
        await assertSiteTarget(ctx, await deps.affiliate.siteOfPayout(id), strictScope);   // F-44: fail-closed (unresolved -> 404)
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
  // Same source lock as every other Daraja callback (app.payments.ts): this route COMPLETES a real
  // commission payout from its body alone, so without the allowlist anyone who can guess a payout
  // id can forge a success/failure result. Unset MPESA_CALLBACK_ALLOWED_CIDRS = disabled (fail-open).
  router.post(`${BASE}/affiliate/payouts/mpesa/result/:payoutId`, darajaOnly, async (ctx: Ctx) => {
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
    // F-44: the marketer must be in the caller's scope, and the expense is recorded on the MARKETER's
    // brand — never the admin's (the system owner's expenses were landing on its home brand).
    const marketerSite = await assertUserTarget(ctx, marketerUserId, scope);
    const siteId = marketerSite ?? adminListSite(ctx) ?? DEFAULT_SITE_ID;
    return domain(() => deps.marketerExpenses.add(ctx.claims!.userId, ctx.claims!.role ?? "player", siteId, marketerUserId, category, amountCents, note));
  });

  router.get(`${BASE}/admin/affiliate/expenses`, auth, admin, async (ctx: Ctx) => {
    const marketerUserId = ctx.query.get("marketerUserId");
    if (!marketerUserId) throw new ApiError("VALIDATION", "marketerUserId query param is required", 400);
    const limit = Number(ctx.query.get("limit")) || 100;
    await assertUserTarget(ctx, marketerUserId, scope);   // F-44: was any marketer on any platform
    // Full sum, not the page sum (BUGLOG #23) — the admin "Total logged" must equal what actually
    // reduces the marketer's withdrawable.
    const [items, totalCents] = await domain(async () => Promise.all([
      deps.marketerExpenses.list(marketerUserId, limit),
      deps.marketerExpenses.total(marketerUserId),
    ]));
    return { items, totalCents };
  });

  // ── Marketer advance requests (0122): marketer requests a cash advance against future commission →
  //    admin approves (logs a marketer_expense 'advance', reducing withdrawable) or rejects → the
  //    system NOTIFIES the marketer of the outcome. One open request per marketer at a time. ──
  router.post(`${BASE}/affiliate/advances`, auth, site, marketer, async (ctx: Ctx) => {
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const amountCents = Number(b.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ApiError("VALIDATION", "amountCents must be a positive integer (cents)", 400);
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
    return domain(() => deps.marketerAdvances.request(ctx.claims!.userId, amountCents, reason));
  });

  // The marketer's own advance requests (newest first) — powers the dashboard status list.
  router.get(`${BASE}/affiliate/advances`, auth, site, marketer, async (ctx: Ctx) => {
    const limit = Number(ctx.query.get("limit")) || 50;
    return { items: await domain(() => deps.marketerAdvances.listMine(ctx.claims!.userId, limit)) };
  });

  // Marketer cancels their OWN still-pending request (safety valve).
  router.post(`${BASE}/affiliate/advances/:id/cancel`, auth, site, marketer, async (ctx: Ctx) =>
    domain(() => deps.marketerAdvances.cancel(ctx.claims!.userId, ctx.params.id!)));

  // Admin queue (brand-scoped; platform_superadmin sees all). Optional ?status= filter.
  router.get(`${BASE}/admin/affiliate/advances`, auth, admin, async (ctx: Ctx) => {
    const status = ctx.query.get("status");
    const limit = Number(ctx.query.get("limit")) || 100;
    return { items: await domain(() => deps.marketerAdvances.adminList(adminScopeSite(ctx) ?? null, status, limit)) };
  });

  // Approve/reject. The RPC writes the admin_actions audit; here we COMMUNICATE the outcome to the
  // marketer via a per-user in-app notification (approved -> success; rejected -> warning + reason).
  const decideAdvance = (approve: boolean) => async (ctx: Ctx) => {
    await assertSiteTarget(ctx, await deps.marketerAdvances.siteOf(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    const row = await domain(() => deps.marketerAdvances.decide(ctx.claims!.userId, ctx.claims!.role ?? "player", ctx.params.id!, approve, note));
    try {
      const kes = `KES ${(row.amountCents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await deps.notifications.create(approve
        ? { userId: row.marketerUserId, title: "Advance approved",
            body: `Your advance of ${kes} was approved and logged. It will be recovered from your upcoming commission.${note ? ` Note: ${note}` : ""}`,
            level: "success", dismissible: true, category: "advance", createdBy: ctx.claims!.userId }
        : { userId: row.marketerUserId, title: "Advance declined",
            body: `Your advance request for ${kes} was declined.${note ? ` Reason: ${note}` : ""}`,
            level: "warning", dismissible: true, category: "advance", createdBy: ctx.claims!.userId });
    } catch { /* never fail the decision because a notification couldn't be written */ }
    return row;
  };
  router.post(`${BASE}/admin/affiliate/advances/:id/approve`, auth, admin, decideAdvance(true));
  router.post(`${BASE}/admin/affiliate/advances/:id/reject`, auth, admin, decideAdvance(false));

  // Operational: run the daily revenue-share accrual for a trading day (idempotent). In
  // production a daily cron calls this (or the RPC directly via service role).
  router.post(`${BASE}/admin/affiliate/accrue`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const period = body.date;
    if (typeof period !== "string") throw new ApiError("VALIDATION", "date (YYYY-MM-DD) is required", 400);
    // Optional `site` (brand uuid) scopes the accrual to one brand; omit to accrue every brand
    // (platform-wide cron). A site-scoped operator console (Task H) will pass its own brand here.
    const requested = body.site;
    if (requested !== undefined && typeof requested !== "string") throw new ApiError("VALIDATION", "site must be a brand id string", 400);
    // F-44: a site admin may only accrue ITS OWN brand (was: any brand, or every brand when omitted);
    // only the system owner may target another brand or run the platform-wide accrual.
    const own = adminScopeSite(ctx);
    if (own !== null && requested !== undefined && requested !== own) {
      throw new ApiError("SITE_SCOPE_FORBIDDEN", "SITE_SCOPE_FORBIDDEN: target belongs to another brand", 403);
    }
    const site = own ?? requested;
    const r = await domain(() => deps.affiliate.accrueDaily(period, site));
    return { period, site: site ?? null, buckets: r.buckets, totalCommissionCents: r.totalCommissionCents };
  });
}

/**
 * The broadcast copy for a live session.
 *
 * Persuasive and true: it names the brand, says what is happening, and invites people in. It does
 * NOT promise a win, imply the session pays better, invent a countdown, or claim others are winning
 * right now — the lines that turn marketing into misrepresentation on a real-money product.
 *
 * The PER-PLAYER version (which also states that player's own balance) is `liveMessage` in
 * community.pg.ts. This one is the single text a broadcast sends to everyone, so it carries no
 * figure that would be wrong for anybody.
 */
function liveAnnouncement(brandName: string, streamUrl: string | null): { title: string; body: string } {
  return {
    title: `${brandName} is live now`,
    body: streamUrl
      ? `We are trading live right now. Come and trade along with us: ${streamUrl}`
      : `We are trading live right now. Come and trade along with us.`,
  };
}

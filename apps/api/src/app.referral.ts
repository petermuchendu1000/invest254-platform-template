import { Router, ApiError, requireAuth, requireRole, adminScopeSite, assertTargetSiteInScope, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import { requireApprovalPassword } from "./approvalgate.js";

/**
 * Referral / commission routes (deposit-based differential-unilevel model, migrations 0078/0079).
 *
 *  - GET  /me/referral                        every authed user: their code + link + commission summary
 *  - GET  /me/referral/commissions            the caller's commission line-items (newest first)
 *  - POST /me/referral/payouts                request a commission payout (balance must be >= KES 500)
 *  - GET  /me/referral/payouts                the caller's own payout requests
 *  - GET  /admin/commission-payouts           admin queue (brand-scoped; platform sees all)
 *  - POST /admin/commission-payouts/:id/approve|paid|reject   manual approve -> mark-paid lifecycle
 *
 * This is a SEPARATE money stream from the native GGR affiliate payouts (app.affiliate.ts).
 */

const BASE = "/api/v1";

export interface ReferralSummary {
  referralCode: string | null; referralPath: string | null; isMarketer: boolean;
  totalReferrals: number; earnedCents: number; heldCents: number; paidCents: number;
  availableCents: number; minPayoutCents: number;
}
export interface CommissionRow {
  id: number; depositTxId: string; referredUser: string; referredUsername: string | null;
  position: number; role: string; rate: number; depositAmountCents: number; commissionCents: number;
  status: string; createdAtMs: number;
}
export interface CommissionPayoutRow {
  id: string; amountCents: number; status: string; requestedAtMs: number;
  approvedAtMs: number | null; paidAtMs: number | null; paidRef: string | null; note: string | null;
}
export interface AdminCommissionPayoutRow extends CommissionPayoutRow {
  beneficiaryUser: string; username: string | null; phone: string | null; siteId: string;
}

export interface ReferralRepo {
  myReferral(userId: string): Promise<ReferralSummary>;
  listMyCommissions(userId: string, limit: number): Promise<CommissionRow[]>;
  requestPayout(userId: string): Promise<CommissionPayoutRow>;
  listMyPayouts(userId: string, limit: number): Promise<CommissionPayoutRow[]>;
  listPayouts(siteId: string | undefined, status: string | undefined, limit: number): Promise<AdminCommissionPayoutRow[]>;
  siteOfPayout(id: string): Promise<string | null>;
  approvePayout(id: string, adminId: string): Promise<CommissionPayoutRow>;
  markPaid(id: string, adminId: string, ref: string | null): Promise<CommissionPayoutRow>;
  rejectPayout(id: string, adminId: string, reason: string | null): Promise<CommissionPayoutRow>;
}

const REFERRAL_STATUS: Readonly<Record<string, number>> = {
  BELOW_MIN: 400, PAYOUT_PENDING: 409, INVALID_STATE: 409, NOT_FOUND: 404,
};

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = REFERRAL_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err;
  }
}

function limitOf(ctx: Ctx, def = 50): number {
  const v = ctx.query.get("limit");
  const n = v === null ? def : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : def;
}

export function registerReferralRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const admin = requireRole("admin");

  // ── Every authenticated user: their referral code, link, and commission summary ────────────────
  router.get(`${BASE}/me/referral`, auth, async (ctx: Ctx) =>
    deps.referral.myReferral(ctx.claims!.userId));

  router.get(`${BASE}/me/referral/commissions`, auth, async (ctx: Ctx) =>
    ({ items: await deps.referral.listMyCommissions(ctx.claims!.userId, limitOf(ctx)) }));

  // Request a commission payout (marketer balance must be >= KES 500). One pending request at a time.
  // On success, alert the superadmin (Telegram + email) — this is REAL money needing approval (Issue 1).
  router.post(`${BASE}/me/referral/payouts`, auth, async (ctx: Ctx) => {
    const row = await domain(() => deps.referral.requestPayout(ctx.claims!.userId));
    try { deps.onCommissionRequested?.(row.id); } catch { /* never block the request */ }
    return row;
  });

  router.get(`${BASE}/me/referral/payouts`, auth, async (ctx: Ctx) =>
    ({ items: await deps.referral.listMyPayouts(ctx.claims!.userId, limitOf(ctx)) }));

  // ── Admin commission-payout queue (brand-scoped; platform_superadmin sees all) ─────────────────
  router.get(`${BASE}/admin/commission-payouts`, auth, admin, async (ctx: Ctx) =>
    ({ items: await deps.referral.listPayouts(adminScopeSite(ctx) ?? undefined, ctx.query.get("status") ?? undefined, limitOf(ctx)) }));

  router.post(`${BASE}/admin/commission-payouts/:id/approve`, auth, admin, async (ctx: Ctx) => {
    await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // superadmin password gate (Issue 1)
    assertTargetSiteInScope(ctx, await deps.referral.siteOfPayout(ctx.params.id!));
    return domain(() => deps.referral.approvePayout(ctx.params.id!, ctx.claims!.userId));
  });

  router.post(`${BASE}/admin/commission-payouts/:id/paid`, auth, admin, async (ctx: Ctx) => {
    await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // superadmin password gate (Issue 1)
    assertTargetSiteInScope(ctx, await deps.referral.siteOfPayout(ctx.params.id!));
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const ref = typeof b.ref === "string" ? b.ref : null;
    return domain(() => deps.referral.markPaid(ctx.params.id!, ctx.claims!.userId, ref));
  });

  router.post(`${BASE}/admin/commission-payouts/:id/reject`, auth, admin, async (ctx: Ctx) => {
    assertTargetSiteInScope(ctx, await deps.referral.siteOfPayout(ctx.params.id!));
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const reason = typeof b.reason === "string" ? b.reason : null;
    return domain(() => deps.referral.rejectPayout(ctx.params.id!, ctx.claims!.userId, reason));
  });
}

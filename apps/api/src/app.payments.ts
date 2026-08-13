import type { Cents } from "@invest254/shared";
import { Router, ApiError, requireAuth, requireRole, requireSite, rateLimit, restrictToCidrs, assertTargetSiteInScope, type Ctx, type Middleware } from "./http.js";
import type { ApiDeps } from "./app.js";

/**
 * Protected + callback routes (Issue E2): player wallet/chat/payments, the public Daraja
 * STK/B2C callbacks, and finance-admin withdrawal approve/reject. Each route is a thin
 * binding over an already-implemented engine service (PaymentService, ChatService) — all
 * money correctness/idempotency lives in the migration-0014 RPCs. This module owns only
 * transport concerns: routing, auth/role gates, input validation, domain→HTTP error
 * mapping, Daraja payload parsing, and serialization.
 */

const BASE = "/api/v1";

/** Daraja acknowledgement — any non-zero makes Safaricom retry, so callbacks always ack. */
const DARAJA_ACK = { ResultCode: 0, ResultDesc: "Accepted" } as const;

/** Business-error → HTTP status. Anything not listed is a true fault (→ 500). */
const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  INVALID_AMOUNT: 400,
  NOT_INTEGER_CENTS: 400,
  BELOW_MIN: 400,
  INVALID_PHONE: 400,
  INSUFFICIENT_FUNDS: 402,
  ACCOUNT_NOT_ACTIVE: 403,
  WALLET_NOT_FOUND: 404,
  TX_NOT_FOUND: 404,
};

/** Run a domain call, translating known service errors to controlled ApiErrors. */
async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    const status = DOMAIN_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    throw err; // unknown → router maps to 500
  }
}

// ─────────────────────────── input validation ───────────────────────────

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("VALIDATION", "request body must be a JSON object", 400);
  }
  return body as Record<string, unknown>;
}

function requireIntAmount(body: Record<string, unknown>): number {
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw new ApiError("VALIDATION", "amount must be a positive integer (cents)", 400);
  }
  return amount;
}

function requirePhone(body: Record<string, unknown>): string {
  const phone = body.phone;
  if (typeof phone !== "string" || phone.trim() === "") {
    throw new ApiError("VALIDATION", "phone is required", 400);
  }
  return phone;
}

// ─────────────────────────── DTOs ───────────────────────────


// ─────────────────────────── Daraja payload parsing ───────────────────────────

export interface StkCallback { checkoutRequestId: string; resultCode: number; resultDesc: string; receipt: string | null; }
export function parseStkCallback(body: unknown): StkCallback {
  const cb = (body as any)?.Body?.stkCallback;
  if (!cb || cb.CheckoutRequestID == null || cb.ResultCode == null) {
    throw new ApiError("BAD_CALLBACK", "missing Body.stkCallback fields", 400);
  }
  const items: any[] = cb.CallbackMetadata?.Item ?? [];
  const receipt = items.find((i) => i?.Name === "MpesaReceiptNumber")?.Value;
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc ?? ""),
    receipt: receipt != null ? String(receipt) : null,
  };
}

export interface B2cResult { resultCode: number; conversationId: string | null; receipt: string | null; }
export function parseB2cResult(body: unknown): B2cResult {
  const r = (body as any)?.Result;
  if (!r || r.ResultCode == null) {
    throw new ApiError("BAD_CALLBACK", "missing Result fields", 400);
  }
  const params: any[] = r.ResultParameters?.ResultParameter ?? [];
  const param = params.find((i) => i?.Key === "TransactionReceipt" || i?.Key === "ReceiptNo")?.Value;
  return {
    resultCode: Number(r.ResultCode),
    conversationId: r.ConversationID != null ? String(r.ConversationID) : null,
    receipt: param != null ? String(param) : r.TransactionID != null ? String(r.TransactionID) : null,
  };
}

// ─────────────────────────── route registration ───────────────────────────

/** Register player-authenticated, public-callback, and admin routes (E2). */
export function registerProtectedRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  // Per-user throttle so a client can't spam real STK pushes / withdrawal requests. Tunable via env.
  const payLimit = Number(process.env.RATE_LIMIT_PAYMENTS_PER_MIN) || 20;
  const depositLimit = rateLimit({ name: "deposit", by: "user", limit: payLimit, windowMs: 60_000 });
  const withdrawLimit = rateLimit({ name: "withdrawal", by: "user", limit: payLimit, windowMs: 60_000 });
  // Lock the public Daraja callbacks to Safaricom's source IPs when MPESA_CALLBACK_ALLOWED_CIDRS
  // is set (defence-in-depth atop STKPushQuery verification). Unset = disabled (fail-open).
  const darajaOnly = restrictToCidrs("MPESA_CALLBACK_ALLOWED_CIDRS");

  // ── Player: wallet & chat ──
  router.get(`${BASE}/wallet`, auth, site, async (ctx: Ctx) => {
    return deps.walletBalance(ctx.claims!.userId, ctx.siteId);
  });

  // ── Player: payments ──
  router.post(`${BASE}/deposits`, auth, site, depositLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    const out = await domain(() => deps.payments.initiateDeposit(ctx.claims!.userId, amount, phone, ctx.siteId));
    return { status: 202, body: { transactionId: out.txId, checkoutRequestId: out.checkoutRequestId } };
  });

  router.post(`${BASE}/withdrawals`, auth, site, withdrawLimit, async (ctx: Ctx) => {
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    const out = await domain(() => deps.payments.requestWithdrawal(ctx.claims!.userId, amount, phone, ctx.siteId));
    // Marketer instant transfer -> paid to the mpesa app wallet (200). Normal player -> pending (202).
    if (out.mode === "marketer") {
      return { status: 200, body: { paid: true, transactionId: out.txId, newBalance: out.newBalance, mpesaBalance: out.mpesaBalanceCents } };
    }
    return { status: 202, body: { transactionId: out.txId, newBalance: out.newBalance } };
  });

  // ── Public: Daraja callbacks (network-allowlisted at the edge, not in-app) ──
  // Multi-tenant (docs/22 Task E): each brand registers its own callback URL with Safaricom as
  // `/api/v1/s/<slug>/...`. The slug identifies which brand's shortcode fired, so the prefixed
  // variants resolve it to `ctx.siteId` before the handler runs. The unprefixed routes stay for
  // the default brand (single-tenant deployments and the in-flight callbacks at cutover).
  const resolveSlug: Middleware = async (ctx: Ctx) => {
    const slug = ctx.params.slug;
    if (!slug) return;
    const brand = await deps.brandByHost(slug.trim().toLowerCase());
    if (!brand) throw new ApiError("SITE_NOT_FOUND", `no active brand for slug '${slug}'`, 404);
    ctx.siteId = brand.siteId;
  };

  const stkCallback = async (ctx: Ctx) => {
    const cb = parseStkCallback(ctx.body);
    await domain(() => deps.payments.handleStkCallback(cb.checkoutRequestId, cb.resultCode, cb.resultDesc, cb.receipt, ctx.body));
    return DARAJA_ACK;
  };
  router.post(`${BASE}/deposits/mpesa/callback`, darajaOnly, stkCallback);
  router.post(`${BASE}/s/:slug/deposits/mpesa/callback`, darajaOnly, resolveSlug, stkCallback);

  const b2cResult = async (ctx: Ctx) => {
    const r = parseB2cResult(ctx.body);
    await domain(() => deps.payments.handleB2cResult(ctx.params.txId!, r.resultCode, r.conversationId, r.receipt, ctx.body));
    return DARAJA_ACK;
  };
  router.post(`${BASE}/withdrawals/mpesa/result/:txId`, darajaOnly, b2cResult);
  router.post(`${BASE}/s/:slug/withdrawals/mpesa/result/:txId`, darajaOnly, resolveSlug, b2cResult);

  // ── Admin: withdrawal moderation ──
  // A site-scoped finance admin may only decide its own brand's withdrawals (docs/22 Task H); a
  // platform admin / platform_superadmin is unrestricted. The target is a transaction id, so its
  // brand is resolved via the AdminService (tolerant of an unknown tx — the RPC stays the guard).
  const admin = requireRole("admin");
  router.post(`${BASE}/admin/withdrawals/:id/approve`, auth, admin, async (ctx: Ctx) => {
    assertTargetSiteInScope(ctx, await deps.admin.siteOfTransaction(ctx.params.id!));
    return domain(() => deps.payments.approveWithdrawal(ctx.params.id!, ctx.claims!.userId));
  });

  router.post(`${BASE}/admin/withdrawals/:id/reject`, auth, admin, async (ctx: Ctx) => {
    assertTargetSiteInScope(ctx, await deps.admin.siteOfTransaction(ctx.params.id!));
    return domain(() => deps.payments.rejectWithdrawal(ctx.params.id!, ctx.claims!.userId));
  });
}

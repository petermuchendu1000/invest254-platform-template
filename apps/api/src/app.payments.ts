import type { Cents } from "@invest254/shared";
import { Router, ApiError, requireAuth, requireRole, requireSite, rateLimit, restrictToCidrs, assertTargetSiteInScope, type Ctx, type Middleware } from "./http.js";
import type { ApiDeps } from "./app.js";
import { requireApprovalPassword } from "./approvalgate.js";

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
  ABOVE_MAX: 400,            // deposit above the platform-global max (0099) — was unmapped -> 500 (bug fix)
  INVALID_PHONE: 400,
  WITHDRAWALS_DISABLED: 403,
  INSUFFICIENT_FUNDS: 402,
  ACCOUNT_NOT_ACTIVE: 403,
  WALLET_NOT_FOUND: 404,
  TX_NOT_FOUND: 404,
  INVALID_CODE: 400,
  INVALID_C2B: 400,
  CODE_ALREADY_USED: 409,
  // Mega Pay rail (migration 0116)
  PROVIDER_NOT_FOUND: 400,
  PROVIDER_DISABLED: 403,
  MEGAPAY_NOT_CONFIGURED: 503,
  MEGAPAY_INITIATE_REJECTED: 502,
  MEGAPAY_VERIFY_PENDING: 409,   // callback arrived but status not yet final -> caller/retry + reconcile settles it
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

// M-Pesa caps a single STK push / B2C at ~KES 150,000. We reject anything above KES 250,000
// (25,000,000 cents) as an impossible/junk amount so it never pollutes the ledger or finance
// reconciliation (an unbounded amount previously let a KES 55.8M "deposit" attempt through).
const MAX_AMOUNT_CENTS = 25_000_000;

function requireIntAmount(body: Record<string, unknown>): number {
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw new ApiError("VALIDATION", "amount must be a positive integer (cents)", 400);
  }
  if (amount > MAX_AMOUNT_CENTS) {
    throw new ApiError("VALIDATION", "amount exceeds the maximum allowed (KES 250,000)", 400);
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

/** Parse a Safaricom C2B confirmation payload (payment made to our Pay Bill). Amount is whole KES. */
export interface C2bConfirmation { transId: string; amountCents: number; msisdn: string | null; billRef: string | null; shortcode: string | null; }
export function parseC2bConfirmation(body: unknown): C2bConfirmation {
  const b = body as Record<string, unknown> | null;
  const transId = b?.["TransID"] ?? b?.["TransactionID"];
  const amount = b?.["TransAmount"];
  if (transId == null || String(transId).trim() === "" || amount == null) {
    throw new ApiError("BAD_CALLBACK", "missing TransID/TransAmount", 400);
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new ApiError("BAD_CALLBACK", "invalid TransAmount", 400);
  return {
    transId: String(transId),
    amountCents: Math.round(amt * 100),
    msisdn: b?.["MSISDN"] != null ? String(b["MSISDN"]) : null,
    billRef: b?.["BillRefNumber"] != null ? String(b["BillRefNumber"]) : null,
    shortcode: b?.["BusinessShortCode"] != null ? String(b["BusinessShortCode"]) : null,
  };
}

/**
 * Parse a Mega Pay webhook payload (migration 0116). Mega Pay posts back the transaction it settled;
 * we only need the `transaction_request_id` to look it up — the handler then RE-QUERIES Mega Pay for
 * the authoritative status before crediting, so we accept the id under any of its documented casings
 * and never trust status/amount off the wire.
 */
export function parseMegaPayCallback(body: unknown): { transactionRequestId: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const trid = b["transaction_request_id"] ?? b["TransactionRequestID"] ?? b["transactionRequestId"]
    ?? b["TransactionID"] ?? b["transaction_id"];
  if (trid == null || String(trid).trim() === "") {
    throw new ApiError("BAD_CALLBACK", "missing transaction_request_id", 400);
  }
  return { transactionRequestId: String(trid).trim() };
}

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
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    // Gateway switch (migration 0116): the Daraja STK rail belongs to the 'mpesa' provider — refuse
    // when the superadmin switched M-Pesa off for this brand (server-authoritative, matches the UI).
    if (!(await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "mpesa"))
      throw new ApiError("PROVIDER_DISABLED", "M-Pesa deposits are not available.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    const out = await domain(() => deps.payments.initiateDeposit(ctx.claims!.userId, amount, phone, ctx.siteId));
    return { status: 202, body: { transactionId: out.txId, checkoutRequestId: out.checkoutRequestId } };
  });

  // The deposit gateways to render for THIS player's brand (migration 0116): the superadmin's global
  // switch resolved against any per-site override. Fail-open to M-Pesa inside the service, so this
  // never returns an empty list that would hide the working rail.
  router.get(`${BASE}/deposits/providers`, auth, site, async (ctx: Ctx) => {
    const providers = await deps.payments.listDepositProviders(ctx.siteId);
    return { providers };
  });

  // Mega Pay STK deposit (migration 0116). Mirrors /deposits but routes through the Mega Pay rail.
  // The provider must be effective-enabled for this brand (server-authoritative — a client can't
  // deposit through a gateway the superadmin switched off), and the deposits master switch still applies.
  router.post(`${BASE}/deposits/megapay`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    const enabled = (await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "megapay");
    if (!enabled) throw new ApiError("PROVIDER_DISABLED", "Mega Pay is not available.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    const out = await domain(() => deps.payments.initiateMegaPayDeposit(ctx.claims!.userId, amount, phone, ctx.siteId));
    return { status: 202, body: { transactionId: out.txId, transactionRequestId: out.transactionRequestId, checkoutRequestId: out.checkoutRequestId } };
  });

  router.post(`${BASE}/withdrawals`, auth, site, withdrawLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("withdrawals")))
      throw new ApiError("SYSTEM_DISABLED", "Withdrawals are temporarily disabled by the platform.", 403);
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

  // ── Mega Pay webhook (migration 0116) ──
  // Mega Pay POSTs here when a deposit settles (one URL for ALL brands — the transaction_request_id
  // resolves the originating deposit/brand from our own DB). The handler RE-QUERIES Mega Pay for the
  // authoritative status before crediting, so a forged POST can't mint balance. Optionally lock to
  // Mega Pay's source IPs via MEGAPAY_CALLBACK_ALLOWED_CIDRS (unset = disabled, same as Daraja).
  const megapayOnly = restrictToCidrs("MEGAPAY_CALLBACK_ALLOWED_CIDRS");
  const megapayCallback = async (ctx: Ctx) => {
    const cb = parseMegaPayCallback(ctx.body);
    await domain(() => deps.payments.handleMegaPayCallback(cb.transactionRequestId, ctx.body));
    return { ok: true };
  };
  router.post(`${BASE}/deposits/megapay/callback`, megapayOnly, megapayCallback);
  router.post(`${BASE}/s/:slug/deposits/megapay/callback`, megapayOnly, resolveSlug, megapayCallback);

  // ── Pay Bill (C2B) — auto-verified manual deposits (migration 0115) ──
  // Public C2B endpoints Safaricom calls for every payment to our Pay Bill. Network-allowlisted to
  // Safaricom's IPs (same defence as the STK callback). Validation accepts all; Confirmation ingests
  // the payment so a player can later claim it by code. Both ack unconditionally (Safaricom retries
  // any non-2xx, and ingest is idempotent, so a retry is a safe no-op).
  router.post(`${BASE}/deposits/c2b/validation`, darajaOnly, async () => DARAJA_ACK);
  const c2bConfirmation = async (ctx: Ctx) => {
    const c = parseC2bConfirmation(ctx.body);
    await domain(() => deps.payments.ingestC2b({
      transId: c.transId, amountCents: c.amountCents, msisdn: c.msisdn, billRef: c.billRef, shortcode: c.shortcode, raw: ctx.body,
    }));
    return DARAJA_ACK;
  };
  router.post(`${BASE}/deposits/c2b/confirmation`, darajaOnly, c2bConfirmation);

  // Player claims a Pay Bill payment by its M-PESA confirmation code. Credits the Safaricom-recorded
  // amount once; 'not_found' means the confirmation hasn't reached us yet (client should retry shortly).
  router.post(`${BASE}/deposits/paybill/claim`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    // Pay Bill (C2B) is part of the Daraja 'mpesa' provider — gated by the same switch (migration 0116).
    if (!(await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "mpesa"))
      throw new ApiError("PROVIDER_DISABLED", "M-Pesa Pay Bill is not available.", 403);
    const body = asObject(ctx.body);
    const code = body.code;
    if (typeof code !== "string" || code.trim() === "") throw new ApiError("VALIDATION", "code is required", 400);
    return domain(() => deps.payments.claimPaybillDeposit(ctx.claims!.userId, code, ctx.siteId));
  });

  // Public: the Pay Bill display config (non-secret) for the deposit sheet's copy-paste card.
  router.get(`${BASE}/deposits/paybill/info`, async () => deps.payments.paybillConfig());


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
    await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // superadmin password gate (Issue 1)
    assertTargetSiteInScope(ctx, await deps.admin.siteOfTransaction(ctx.params.id!));
    return domain(() => deps.payments.approveWithdrawal(ctx.params.id!, ctx.claims!.userId));
  });

  router.post(`${BASE}/admin/withdrawals/:id/reject`, auth, admin, async (ctx: Ctx) => {
    assertTargetSiteInScope(ctx, await deps.admin.siteOfTransaction(ctx.params.id!));
    return domain(() => deps.payments.rejectWithdrawal(ctx.params.id!, ctx.claims!.userId));
  });

  // Bulk moderation: apply approve/reject to many withdrawals in one call. Each row is brand-guarded
  // and executed independently, so one failure (wrong state, cross-brand, B2C error) fails ONLY that
  // row (partial success) — mirrors /admin/users/bulk. Approval dispatches the M-Pesa B2C per row;
  // the underlying RPCs are idempotent, so a re-run over already-actioned rows is safe.
  router.post(`${BASE}/admin/withdrawals/bulk`, auth, admin, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const action = body.action === "approve" || body.action === "reject" ? body.action : "";
    if (!action) throw new ApiError("VALIDATION", "action must be 'approve' or 'reject'", 400);
    if (action === "approve") await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // one password per batch (Issue 1)
    const raw = Array.isArray(body.txIds) ? body.txIds : [];
    const txIds = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (txIds.length === 0) throw new ApiError("VALIDATION", "txIds must be a non-empty array", 400);
    if (txIds.length > 200) throw new ApiError("VALIDATION", "at most 200 withdrawals per bulk action", 400);
    const results = await Promise.all(txIds.map(async (id) => {
      try {
        assertTargetSiteInScope(ctx, await deps.admin.siteOfTransaction(id));
        const result = action === "approve"
          ? await deps.payments.approveWithdrawal(id, ctx.claims!.userId)
          : await deps.payments.rejectWithdrawal(id, ctx.claims!.userId);
        return { id, ok: true, result };
      } catch (e) {
        return { id, ok: false, error: (e as { message?: string })?.message ?? "ERROR" };
      }
    }));
    const okCount = results.filter((r) => r.ok).length;
    return { action, total: txIds.length, okCount, failCount: results.length - okCount, results };
  });
}

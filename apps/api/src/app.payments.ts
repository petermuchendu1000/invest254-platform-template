import type { Cents } from "@invest254/shared";
import { Router, ApiError, requireAuth, requireRole, requireSiteAdmin, requireSite, rateLimit, restrictToCidrs, type Ctx, type Middleware } from "./http.js";
import { assertSiteTarget } from "./scope.js";
import type { ApiDeps } from "./app.js";
import { requireApprovalPassword } from "./approvalgate.js";
import { publicProvider, publicProviderCode } from "./publicProvider.js";

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
  WITHDRAWAL_ALREADY_REVERSED: 409,   // manual mark-paid on a failed/reversed withdrawal (would double-pay)
  // Mega Pay rail (migration 0116)
  PROVIDER_NOT_FOUND: 400,
  PROVIDER_DISABLED: 403,
  // 0174 / docs/52 — the initiate guard. Client-safe by design: these say "slow down", never "failed".
  DEPOSIT_TOO_SOON: 429,
  PROVIDER_BUSY: 429,
  MEGAPAY_NOT_CONFIGURED: 503,
  MEGAPAY_INITIATE_REJECTED: 502,
  MEGAPAY_VERIFY_PENDING: 409,   // callback arrived but status not yet final -> caller/retry + reconcile settles it
  MPESA_B2C_NOT_CONFIGURED: 503, // withdrawal payout attempted but Daraja B2C initiator/credential unset
  // PAY-1 (docs/43): a brand on its own payment accounts
  PAYOUT_PHONE_MISMATCH: 400,    // F-49 (0161): withdrawals are paid only to the registered number
  GATEWAY_NOT_CONFIGURED: 503,   // the brand's payment owner has no complete account for this rail (never re-routed)
  PAYBILL_NOT_AVAILABLE: 403,    // the manual Pay Bill is the System owner's; not offered on own accounts
  INVALID_SCOPE: 500,
  // DEMO-1 (0123 + 0167): switching accounts
  INVALID_MODE: 400,
  OPEN_POSITIONS: 409,           // a contract is still open: finish it before switching accounts
  MODE_LOCKED: 409,              // marketer accounts are always demo
  DEMO_ACCOUNT: 409,             // DEMO-2 (0169): demo money is never withdrawable — switch to Real first
};

/** Technical/provider faults that must NEVER reach a client verbatim — they carry gateway payloads
 *  (e.g. "merchant has insufficient balance"), account state, stack detail, etc. These are sanitized
 *  to friendly copy for the player; the FULL detail is logged for operators (system_logs → the
 *  superadmin-only /admin/logs). */
const TECH_ERROR_RE = /_REJECTED|NOT_CONFIGURED|^PAYHERO_|^PAYNICORN_|^DARAJA_/;

/** Run a domain call, translating service errors to controlled, CLIENT-SAFE ApiErrors.
 *  Pass `ctx` on client-facing money routes so provider detail is logged for operators. */
async function domain<T>(fn: () => Promise<T>, ctx?: Ctx): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = message.split(":")[0]!.trim();
    // 1) Technical/provider fault → always log the full detail for operators. Players get sanitized,
    //    friendly copy; privileged callers (admins/superadmins) get the technical detail to act on.
    if (TECH_ERROR_RE.test(code)) {
      ctx?.log?.error("payment provider error", {
        code, detail: message,
        ...(ctx.claims?.userId ? { userId: ctx.claims.userId } : {}),
        ...(ctx.claims?.role ? { role: ctx.claims.role } : {}),
        ...(ctx.siteId ? { siteId: ctx.siteId } : {}),
      });
      const notConfigured = /NOT_CONFIGURED/.test(code);
      const privileged = ["admin", "platform_admin", "platform_superadmin"].includes(ctx?.claims?.role ?? "");
      if (privileged) throw new ApiError(code, message, notConfigured ? 503 : 502); // operators see the detail
      throw new ApiError(
        notConfigured ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR",
        notConfigured
          ? "This payment method is temporarily unavailable. Please try another option or try again later."
          : "We couldn't complete that right now. Please try again in a few minutes or use another payment method.",
        notConfigured ? 503 : 502,
      );
    }
    // 2) Known, client-safe business error → pass through with its status.
    const status = DOMAIN_STATUS[code];
    if (status) throw new ApiError(code, message, status);
    // 3) Unknown → router maps to a generic 500 (detail logged by the router, never leaked).
    throw err;
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
  const amountCents = Math.round(amt * 100);
  // C-1: cap the C2B amount at the same ceiling as an authenticated deposit. The C2B rail has no
  // provider re-query (Safaricom cannot be re-queried for Pay Bill), so a forged confirmation that
  // slips the source-IP lock could otherwise store an UNBOUNDED amount for a player to claim. The
  // cap bounds the blast radius to one legitimate-sized deposit (no live C2B row is near it).
  if (amountCents > MAX_AMOUNT_CENTS) throw new ApiError("BAD_CALLBACK", "amount exceeds the maximum allowed", 400);
  return {
    transId: String(transId),
    amountCents,
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

  // ── DEMO-1: Real / Demo account switch (migration 0123). The server decides the bucket for every
  //    trade from the stored mode; the client only asks to switch. ──
  router.post(`${BASE}/wallet/mode`, auth, site, async (ctx: Ctx) => {
    if (!deps.setAccountMode) throw new ApiError("NOT_AVAILABLE", "Demo accounts are not available.", 501);
    const mode = asObject(ctx.body).mode;
    if (mode !== "real" && mode !== "demo") throw new ApiError("INVALID_MODE", "mode must be 'real' or 'demo'", 400);
    const now = await domain(() => deps.setAccountMode!(ctx.claims!.userId, ctx.siteId, mode), ctx);
    return { mode: now, wallet: await deps.walletBalance(ctx.claims!.userId, ctx.siteId) };
  });
  router.post(`${BASE}/wallet/demo/topup`, auth, site, async (ctx: Ctx) => {
    if (!deps.topupDemo) throw new ApiError("NOT_AVAILABLE", "Demo accounts are not available.", 501);
    const demo = await domain(() => deps.topupDemo!(ctx.claims!.userId, ctx.siteId), ctx);
    return { demoBalance: demo, wallet: await deps.walletBalance(ctx.claims!.userId, ctx.siteId) };
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
    const out = await domain(() => deps.payments.initiateDeposit(ctx.claims!.userId, amount, phone, ctx.siteId), ctx);
    return { status: 202, body: { transactionId: out.txId, checkoutRequestId: out.checkoutRequestId } };
  });

  // What the deposit sheet may render for THIS player's brand.
  //  - `providers`: the effective-enabled gateways (migration 0116) — kept for compatibility.
  //  - `methods`:   the deposit CHANNELS that can actually be completed right now. The client renders
  //                 these verbatim instead of inferring tabs from provider codes, which is what made it
  //                 offer PayHero's Lipwa checkout on brands where `lipwa_url` is unset (submitting
  //                 threw PAYHERO_LIPWA_NOT_CONFIGURED) and hid Pay Bill behind the wrong condition.
  // The platform deposits kill-switch is honoured here too: every deposit POST refuses with
  // SYSTEM_DISABLED while it is off, so offering methods the server will reject is a broken promise.
  // We still return 200 with an empty `methods` (rather than 403) so the sheet shows its normal
  // "temporarily unavailable" state instead of an error.
  router.get(`${BASE}/deposits/providers`, auth, site, async (ctx: Ctx) => {
    const providers = await deps.payments.listDepositProviders(ctx.siteId);
    const depositsOn = deps.platformGate ? await deps.platformGate.allows("deposits") : true;
    const methods = depositsOn ? await deps.payments.listDepositMethods(ctx.siteId) : [];
    // Player-facing: confidential suppliers appear only under their public code (publicProvider.ts).
    return {
      providers: providers.map((p) => ({ ...p, code: publicProviderCode(p.code), displayName: p.code === "paynicorn" ? "M-Pesa" : p.displayName })),
      methods: methods.map(publicProvider),
    };
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
    const out = await domain(() => deps.payments.initiateMegaPayDeposit(ctx.claims!.userId, amount, phone, ctx.siteId), ctx);
    return { status: 202, body: { transactionId: out.txId, transactionRequestId: out.transactionRequestId, checkoutRequestId: out.checkoutRequestId } };
  });

  // PayHero (Lipwa) STK deposit — the third rail. Same server-authoritative enable check + deposits
  // master switch as the other rails; a client can't deposit through a gateway the superadmin switched off.
  router.post(`${BASE}/deposits/payhero`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    const enabled = (await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "payhero");
    if (!enabled) throw new ApiError("PROVIDER_DISABLED", "PayHero is not available.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    const out = await domain(() => deps.payments.initiatePayHeroDeposit(ctx.claims!.userId, amount, phone, ctx.siteId), ctx);
    return { status: 202, body: { transactionId: out.txId, reference: out.reference, checkoutRequestId: out.checkoutRequestId } };
  });

  // PayHero Lipwa — hosted multi-channel checkout (card / bank / mobile money / cross-border), kept IN-APP
  // by the web client via an embedded modal. We only mint a pending tx and hand back the checkout URL;
  // PayHero's PCI-hosted page takes the card details (they never touch us), and the ledger reconcile
  // credits the payment by our reference. Same server-authoritative enable gate + deposits master switch.
  router.post(`${BASE}/deposits/payhero/lipwa`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    if (!(await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "payhero"))
      throw new ApiError("PROVIDER_DISABLED", "PayHero is not available.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const out = await domain(() => deps.payments.initiateLipwaDeposit(ctx.claims!.userId, amount, ctx.siteId), ctx);
    return { status: 202, body: { transactionId: out.txId, reference: out.reference, lipwaUrl: out.lipwaUrl } };
  });

  // PayX (Paynicorn) STK deposit. Public path and name are `payx` only — the supplier is confidential
  // (publicProvider.ts). Paynicorn pushes the M-Pesa prompt itself (method + phone, no cashier page), and
  // crediting happens only via the verified postback / reconcile sweep, like every other STK rail.
  router.post(`${BASE}/deposits/payx`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    if (!(await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "paynicorn"))
      throw new ApiError("PROVIDER_DISABLED", "This payment method is not available.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    // `method` names one of the methods this brand's country offers; the service refuses any other.
    // A method we can collect for takes the phone/email here; one that cannot hands back a checkout URL.
    const method = typeof body.method === "string" && body.method.trim() !== "" ? body.method.trim() : undefined;
    const phone = typeof body.phone === "string" && body.phone.trim() !== "" ? requirePhone(body) : undefined;
    const email = typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim() : undefined;
    const origin = String(ctx.req.headers.origin ?? "").replace(/\/+$/, "");
    const frontPage = /^https:\/\/[^/\s]+$/.test(origin) && deps.corsAllowOrigin?.(origin) ? `${origin}/wallet` : undefined;
    const out = await domain(() => deps.payments.initiatePaynicornDeposit(ctx.claims!.userId, amount, ctx.siteId, {
      ...(method ? { method } : {}), ...(phone ? { phone } : {}), ...(email ? { email } : {}), ...(frontPage ? { frontPage } : {}),
    }), ctx);
    return { status: 202, body: { transactionId: out.txId, checkoutRequestId: out.checkoutRequestId, ...(out.checkoutUrl ? { checkoutUrl: out.checkoutUrl } : {}) } };
  });

  // PayHero manual Pay Bill — the player paid the PayHero paybill directly, then submits the M-PESA code.
  // The ledger reconcile ingests that payment into c2b_payments; claim credits the Safaricom-recorded
  // amount once through the SAME fraud-safe fn_claim_c2b_deposit as the Daraja paybill.
  router.post(`${BASE}/deposits/payhero/paybill/claim`, auth, site, depositLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("deposits")))
      throw new ApiError("SYSTEM_DISABLED", "Deposits are temporarily disabled by the platform.", 403);
    if (!(await deps.payments.listDepositProviders(ctx.siteId)).some((p) => p.code === "payhero"))
      throw new ApiError("PROVIDER_DISABLED", "PayHero is not available.", 403);
    const body = asObject(ctx.body);
    const code = body.code;
    if (typeof code !== "string" || code.trim() === "") throw new ApiError("VALIDATION", "code is required", 400);
    return domain(() => deps.payments.claimPaybillDeposit(ctx.claims!.userId, code, ctx.siteId), ctx);
  });

  router.post(`${BASE}/withdrawals`, auth, site, withdrawLimit, async (ctx: Ctx) => {
    if (deps.platformGate && !(await deps.platformGate.allows("withdrawals")))
      throw new ApiError("SYSTEM_DISABLED", "Withdrawals are temporarily disabled by the platform.", 403);
    const body = asObject(ctx.body);
    const amount = requireIntAmount(body);
    const phone = requirePhone(body);
    // DEMO-2 (BUGLOG #82): a player in demo mode is refused before any money path runs (0169 refuses it
    // again under the wallet lock). Marketers are demo-locked and use their own demo transfer below.
    const w = await deps.walletBalance(ctx.claims!.userId, ctx.siteId);
    if (w.mode === "demo" && !w.modeLocked) throw new ApiError("DEMO_ACCOUNT", "Switch to your Real account to withdraw.", 409);
    const out = await domain(() => deps.payments.requestWithdrawal(ctx.claims!.userId, amount, phone, ctx.siteId), ctx);
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
    // BILL-1: an invoice Pay-now shares the System STK callback URL; billing claims its own checkouts first
    // (verified with STKPushQuery inside), everything else is a player deposit as before.
    if (deps.billing) {
      const billing = deps.billing;
      const r = await domain(() => billing.handleStkCallback(cb.checkoutRequestId, cb.resultCode, cb.resultDesc, cb.receipt, ctx.body));
      if (r.handled) return DARAJA_ACK;
    }
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

  // ── PayHero webhook ──
  // PayHero POSTs here when a deposit settles. The body is NEVER trusted to credit — the handler runs the
  // authoritative sweep that re-queries PayHero for each recent unsettled PayHero deposit by the reference
  // WE stored, so a forged POST can't mint balance. Optionally lock to PayHero's IPs via PAYHERO_CALLBACK_ALLOWED_CIDRS.
  const payheroOnly = restrictToCidrs("PAYHERO_CALLBACK_ALLOWED_CIDRS");
  const payheroCallback = async (ctx: Ctx) => {
    await domain(() => deps.payments.handlePayHeroCallback(ctx.body));
    return { ok: true };
  };
  router.post(`${BASE}/deposits/payhero/callback`, payheroOnly, payheroCallback);
  router.post(`${BASE}/s/:slug/deposits/payhero/callback`, payheroOnly, resolveSlug, payheroCallback);

  // PayHero PAYOUT (withdrawal) webhook. PayHero POSTs here when a payout it queued resolves. Our txId
  // is echoed as `external_reference`; the handler RE-QUERIES PayHero for the authoritative status
  // (using the `reference` PayHero returned) before it settles the withdrawal — a forged/failed callback
  // can never release or reverse money on its own. Same IP allow-list as the deposit webhook.
  const payheroWithdrawCallback = async (ctx: Ctx) => {
    const b = (ctx.body && typeof ctx.body === "object" ? ctx.body : {}) as Record<string, unknown>;
    const txId = typeof b.external_reference === "string" ? b.external_reference : "";
    const reference = typeof b.reference === "string" && b.reference !== ""
      ? b.reference
      : (typeof b.merchant_reference === "string" && b.merchant_reference !== "" ? b.merchant_reference : null);
    if (txId) await domain(() => deps.payments.handlePayHeroWithdrawResult(txId, reference, ctx.body));
    return { ok: true };
  };
  router.post(`${BASE}/withdrawals/payhero/result`, payheroOnly, payheroWithdrawCallback);
  router.post(`${BASE}/s/:slug/withdrawals/payhero/result`, payheroOnly, resolveSlug, payheroWithdrawCallback);

  // ── Paynicorn postback ──
  // Paynicorn POSTs {content, sign} here (the app's "Callback address"). The signature must verify with OUR
  // merchant secret, and the handler re-queries Paynicorn before crediting, so a forged POST can't mint
  // balance. Paynicorn needs HTTP 200 + the plain text `success_{txnId}`, else it retries (up to 7 times).
  // Read as raw bytes so a JSON or form-encoded body both parse. GET answers the console's address check.
  const paynicornOnly = restrictToCidrs("PAYNICORN_CALLBACK_ALLOWED_CIDRS");
  const paynicornCallback = async (ctx: Ctx) => {
    try {
      const r = await deps.payments.handlePaynicornCallback(ctx.body);
      if (r.settled) ctx.log?.info("paynicorn postback settled", { txnId: r.txnId });
      return { raw: Buffer.from(`success_${r.txnId}`), contentType: "text/plain; charset=utf-8" };
    } catch (err) {
      // Never echo provider detail; a non-200 makes Paynicorn retry, and the reconcile sweep backs it up.
      const code = (err instanceof Error ? err.message : String(err)).split(":")[0]!.trim();
      ctx.log?.warn("paynicorn postback not accepted", {
        code, contentType: String(ctx.req.headers["content-type"] ?? ""), bytes: Buffer.isBuffer(ctx.body) ? ctx.body.length : 0,
      });
      if (code === "PAYNICORN_BAD_SIGNATURE") throw new ApiError("BAD_SIGNATURE", "signature did not verify", 401);
      if (code === "PAYNICORN_AMOUNT_MISMATCH") throw new ApiError("AMOUNT_MISMATCH", "amount does not match the order", 409);
      if (code === "PAYNICORN_NOT_CONFIGURED") throw new ApiError("PROVIDER_UNAVAILABLE", "not configured", 503);
      throw new ApiError("CALLBACK_FAILED", "postback not processed, retry later", 500);
    }
  };
  const paynicornAddressCheck = async () => ({ ok: true, provider: "paynicorn" });
  router.upload(`${BASE}/deposits/paynicorn/callback`, 64 * 1024, paynicornOnly, paynicornCallback);
  router.upload(`${BASE}/s/:slug/deposits/paynicorn/callback`, 64 * 1024, paynicornOnly, resolveSlug, paynicornCallback);
  router.get(`${BASE}/deposits/paynicorn/callback`, paynicornOnly, paynicornAddressCheck);
  router.get(`${BASE}/s/:slug/deposits/paynicorn/callback`, paynicornOnly, resolveSlug, paynicornAddressCheck);

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
    return domain(() => deps.payments.claimPaybillDeposit(ctx.claims!.userId, code, ctx.siteId), ctx);
  });

  // Public: the Pay Bill display config (non-secret) for the deposit sheet's copy-paste card.
  // PAY-1: ?site=<brand> — a brand on its OWN payment accounts gets enabled:false (the paybill shown
  // here is the System owner's; its players must never be told to pay it).
  router.get(`${BASE}/deposits/paybill/info`, async (ctx: Ctx) => {
    const s = ctx.query.get("site")?.trim();
    return deps.payments.paybillConfig(s && /^[0-9a-f-]{36}$/i.test(s) ? s : undefined);
  });


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
  const admin = requireSiteAdmin("admin");
  // F-44: strict, fail-closed target scope for id-addressed withdrawal moderation (scope.ts).
  const strictScope = { platformOfSite: (s: string) => deps.platform.platformOfSite(s) };
  router.post(`${BASE}/admin/withdrawals/:id/approve`, auth, admin, async (ctx: Ctx) => {
    await requireApprovalPassword(ctx, deps.verifyApprovalPassword); // system owner password gate (Issue 1)
    await assertSiteTarget(ctx, await deps.admin.siteOfTransaction(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
    return domain(() => deps.payments.approveWithdrawal(ctx.params.id!, ctx.claims!.userId), ctx);
  });

  router.post(`${BASE}/admin/withdrawals/:id/reject`, auth, admin, async (ctx: Ctx) => {
    await assertSiteTarget(ctx, await deps.admin.siteOfTransaction(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
    return domain(() => deps.payments.rejectWithdrawal(ctx.params.id!, ctx.claims!.userId), ctx);
  });

  // Manual completion: mark a stuck (pending/processing) withdrawal PAID when the provider's B2C
  // result callback never arrived (Mega Pay / Daraja failure). Same guards as approve — superadmin
  // approval-password + brand scope — since it finalizes a real payout. No wallet change (the money
  // was already debited at request); it records the terminal 'success' state so the client reflects
  // the payout, with a manual receipt and an admin_actions audit row. Idempotent; refuses a
  // failed/reversed row (that money was returned — paying again would double-pay).
  router.post(`${BASE}/admin/withdrawals/:id/mark-paid`, auth, admin, async (ctx: Ctx) => {
    await requireApprovalPassword(ctx, deps.verifyApprovalPassword);
    await assertSiteTarget(ctx, await deps.admin.siteOfTransaction(ctx.params.id!), strictScope);   // F-44: fail-closed (unresolved -> 404)
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const receipt = typeof body.receipt === "string" && body.receipt.trim() ? body.receipt.trim() : null;
    return domain(() => deps.payments.markWithdrawalPaid(ctx.params.id!, ctx.claims!.userId, receipt), ctx);
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
        await assertSiteTarget(ctx, await deps.admin.siteOfTransaction(id), strictScope);   // F-44: fail-closed (unresolved -> 404)
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

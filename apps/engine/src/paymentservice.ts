import { normalizeMsisdn, MIN_DEPOSIT_CENTS, MIN_WITHDRAWAL_CENTS, type Cents } from "@invest254/shared";
import type { PaymentRepository, CompleteResult, CreateWithdrawalResult, WithdrawalOutcome, C2bPayment, ClaimResult, PaybillConfig, DepositProvider, DepositMethod } from "./payments.js";
import type { DarajaClient } from "./daraja.js";
import type { MegaPayClient } from "./megapay.js";
import type { PayHeroClient } from "./payhero.js";
import { toPaynicornPhone, methodIsDirect, type PaynicornClient, type PaynicornMethod } from "./paynicorn.js";
import { paynicornCountry, formatPaynicornAmount } from "./paynicorncountries.js";
import { kesToCurrencyRate } from "@invest254/shared/fx";
import { PLAYER_DEPOSIT_RAILS } from "./gatewayschema.js";
import { parseScope, type GatewayRouter, type OwnerScope, type PaymentScopeRef } from "./paymentscopes.js";

/**
 * PaymentService orchestrates the deposit/withdrawal flows on top of the atomic RPCs
 * (PaymentRepository) and the Daraja provider. It is transport-agnostic: an HTTP layer
 * (apps/api) binds these methods to REST routes + Daraja callbacks. All money correctness
 * (credit/hold/reversal/idempotency) lives in the repository RPCs; this layer adds input
 * validation, MSISDN normalization, provider calls, and post-settlement event hooks.
 */
export interface PaymentEvents {
  /** Fired once when a withdrawal is confirmed paid (for the real activity feed). */
  onWithdrawalSuccess?(e: { userId: string; amountCents: Cents }): void;
  /**
   * Fired once when a player creates a PENDING withdrawal that needs an admin decision (the normal
   * player Daraja path — NOT the instant marketer transfer, which settles immediately and fires
   * onWithdrawalSuccess). The server routes this into PushService so admins receive a real-time Web
   * Push with Approve/Reject actions (Issue 1). Fire-and-forget: it must never block or fail the
   * withdrawal, so the handler is invoked without await and any throw is swallowed here.
   */
  onWithdrawalRequested?(e: { txId: string; userId: string; amountCents: Cents; phone: string; siteId?: string | undefined }): void;
}
export interface PaymentServiceOptions {
  minDepositCents?: Cents;
  minWithdrawalCents?: Cents;
  /**
   * Live minimum-withdrawal source. When provided it is consulted per-request so an admin's
   * edit to `game_config.min_withdrawal` takes effect on the very next withdrawal without a
   * redeploy (the API passes `() => gameConfig.active().minWithdrawalCents`). Falls back to
   * the static `minWithdrawalCents` / `MIN_WITHDRAWAL_CENTS` constant when absent or when it
   * returns a non-positive value.
   */
  minWithdrawalProvider?: () => Cents;
  /**
   * Site-aware live minimum-withdrawal source (multi-tenant). Consulted per-request with the
   * withdrawing brand's `siteId` so the server enforces the SAME floor the player's client
   * validated against (each brand's `site_game_config.min_withdrawal`). This closes the divergence
   * where a brand's minimum differs from the platform default and the client accepts an amount the
   * server then rejects as BELOW_MIN. Takes precedence over `minWithdrawalProvider`; a non-positive
   * / non-integer result (or a throw) defers to `minWithdrawalProvider` then the static constant, so
   * a transient bad per-brand value can never open the floor below the safe default.
   */
  minWithdrawalForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  /**
   * EXPLICIT per-brand native minimum withdrawal (site_game_config.min_withdrawal_native), converted to
   * KES cents at the live rate, or a non-positive sentinel when the brand has set none. This is the
   * operator's stated intent in the brand's own currency (e.g. $5), so — unlike `minWithdrawalForSite`
   * — it OVERRIDES the platform GLOBAL enforce: a brand that has set its own native floor is not clamped
   * up to the global one. Brands with no native value fall through to the global → legacy → static chain.
   */
  minWithdrawalNativeForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  /**
   * EXPLICIT per-brand native minimum DEPOSIT (site_game_config.min_deposit_native), converted to KES
   * cents at the live rate, or a non-positive sentinel when the brand has set none. This is the
   * operator's stated intent in the brand's own currency (e.g. $1 on a USD brand), so it OVERRIDES the
   * platform GLOBAL enforce and may sit BELOW the static default — a brand that has set its own native
   * floor is not clamped up to the global one. Brands with no native value fall through to the global →
   * static chain, so the platform floor still protects everyone who hasn't opted out of it.
   */
  minDepositForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  /**
   * Platform-wide GLOBAL economy overrides (migration 0099 — the platform_superadmin global console).
   * When the platform owner ENFORCES a value it OVERRIDES every brand (decision: global wins), so these
   * are consulted with the HIGHEST precedence:
   *   - minDepositForGlobal  → enforced platform min deposit (before this, min deposit was a hardcoded
   *                            constant); a valid positive integer wins over the static default.
   *   - maxDepositForGlobal  → enforced platform max single deposit (null/absent = no cap).
   *   - minWithdrawalForGlobal → enforced platform min withdrawal; wins over per-site + provider + static.
   * Each is fail-open: absent, throwing, or a non-positive/non-integer result defers to the existing
   * chain, so a config glitch can never open a floor below the safe default nor block legitimate payments.
   */
  minDepositForGlobal?: () => Cents | Promise<Cents>;
  maxDepositForGlobal?: () => Cents | null | Promise<Cents | null>;
  minWithdrawalForGlobal?: () => Cents | Promise<Cents>;
  /**
   * Per-brand withdrawal kill switch (owner/admin override, migration 0067). Consulted at the top of
   * every withdrawal initiation: when it resolves to `false`, the request is refused with
   * WITHDRAWALS_DISABLED before any money moves — covering BOTH the marketer instant game->mpesa
   * transfer and the normal player pending->approve->B2C request. Lets an operator halt payouts
   * instantly during a malfunction or when the daily pool would be exceeded. Absent/throws => treated
   * as enabled (fail-open to current behaviour), so a missing resolver never blocks legitimate payouts.
   */
  withdrawalsEnabledForSite?: (siteId: string | undefined) => boolean | Promise<boolean>;
  /**
   * Site-aware M-Pesa AccountReference source (multi-tenant). Consulted per-deposit with the brand's
   * `siteId` so the STK-push prompt shows THAT brand's account ("Account no. <Brand>") instead of a
   * hardcoded one. Falls back to `defaultAccountRef` (then "Invest254") when absent / empty / throws.
   */
  accountRefForSite?: (siteId: string | undefined) => string | Promise<string>;
  /** Fallback AccountReference when no per-site value resolves (default "Invest254"). */
  defaultAccountRef?: string;
  /**
   * Per-brand Daraja client resolver (multi-tenant M-Pesa routing). Consulted per-deposit with the
   * brand's `siteId`: when a brand has registered its OWN Safaricom shortcode/credentials it returns
   * a brand-specific client (so the deposit routes to that brand's paybill and shows its business
   * name); returns undefined/throws => fall back to the shared platform client. Dormant until a brand
   * is configured, so it never changes behaviour for brands on the shared paybill.
   */
  darajaForSite?: (siteId: string | undefined) => DarajaClient | undefined | Promise<DarajaClient | undefined>;
  /**
   * Per-brand entitled deposit gateways (Issue 2). Returns the gateway codes a brand OWNS (always incl.
   * 'mpesa'); listDepositProviders intersects the effective providers with this set, so a brand only
   * surfaces gateways it is entitled to. Returns null / throws => no entitlement filter (fail-open).
   */
  entitledGatewaysForSite?: (siteId: string | undefined) => Promise<string[] | null>;
  /**
   * Mega Pay provider client (migration 0116 — the second deposit rail). When present, the Mega Pay
   * deposit/callback/reconcile methods are live; when absent they refuse with MEGAPAY_NOT_CONFIGURED so
   * a deployment that never configured Mega Pay can't accidentally route deposits to a missing client.
   */
  megapay?: MegaPayClient;
  /** PayHero (Lipwa) provider client — the third deposit rail. Absent => PayHero deposits refuse loudly. */
  payhero?: PayHeroClient;
  /**
   * Paynicorn hosted-cashier client — a System-owner (global scope) rail only: a brand on its own payment
   * accounts never routes here (assertRail refuses it). Absent => Paynicorn deposits refuse loudly.
   */
  paynicorn?: PaynicornClient;
  /** The ISO-2 country a brand collects in (PayX). Absent/unknown => Kenya, which is how it shipped. */
  countryForSite?: (siteId: string | undefined) => Promise<string | null>;
  /** KES -> local-currency multiplier. Absent => the shared live FX table. */
  fxRateFor?: (currency: string) => Promise<number>;
  /**
   * PAY-1 (docs/43): per-platform / per-brand payment accounts. When present, every money flow of a brand
   * uses its payment OWNER's accounts (site > platform > global), transactions are stamped with the scope,
   * and verification/reconcile use the INITIATING scope. Absent => the global clients only (legacy).
   */
  gateways?: GatewayRouter;
  events?: PaymentEvents;
  verifyStkCallbacks?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PaymentService {
  private readonly minDeposit: Cents;
  private readonly minWithdrawal: Cents;
  private readonly minWithdrawalProvider?: () => Cents;
  private readonly minWithdrawalForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  private readonly minWithdrawalNativeForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  private readonly minDepositForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  private readonly minDepositForGlobal?: () => Cents | Promise<Cents>;
  private readonly maxDepositForGlobal?: () => Cents | null | Promise<Cents | null>;
  private readonly minWithdrawalForGlobal?: () => Cents | Promise<Cents>;
  private readonly withdrawalsEnabledForSite?: (siteId: string | undefined) => boolean | Promise<boolean>;
  private readonly accountRefForSite?: (siteId: string | undefined) => string | Promise<string>;
  private readonly defaultAccountRef: string;
  private readonly darajaForSite?: (siteId: string | undefined) => DarajaClient | undefined | Promise<DarajaClient | undefined>;
  private readonly entitledGatewaysForSite?: (siteId: string | undefined) => Promise<string[] | null>;
  private readonly megapay?: MegaPayClient;
  private readonly payhero?: PayHeroClient;
  private readonly paynicorn?: PaynicornClient;
  private readonly countryForSite?: (siteId: string | undefined) => Promise<string | null>;
  private readonly fxRateFor: (currency: string) => Promise<number>;
  /** Short-lived cache of the live method list, keyed by country+currency. */
  private readonly methodCache = new Map<string, { at: number; methods: PaynicornMethod[] }>();
  private readonly gateways?: GatewayRouter;
  private readonly events: PaymentEvents;
  private readonly verifyStk: boolean;
  constructor(private readonly repo: PaymentRepository, private readonly daraja: DarajaClient, opts: PaymentServiceOptions = {}) {
    this.minDeposit = opts.minDepositCents ?? MIN_DEPOSIT_CENTS;
    this.minWithdrawal = opts.minWithdrawalCents ?? MIN_WITHDRAWAL_CENTS;
    if (opts.minWithdrawalProvider) this.minWithdrawalProvider = opts.minWithdrawalProvider;
    if (opts.minWithdrawalForSite) this.minWithdrawalForSite = opts.minWithdrawalForSite;
    if (opts.minWithdrawalNativeForSite) this.minWithdrawalNativeForSite = opts.minWithdrawalNativeForSite;
    if (opts.minDepositForSite) this.minDepositForSite = opts.minDepositForSite;
    if (opts.minDepositForGlobal) this.minDepositForGlobal = opts.minDepositForGlobal;
    if (opts.maxDepositForGlobal) this.maxDepositForGlobal = opts.maxDepositForGlobal;
    if (opts.minWithdrawalForGlobal) this.minWithdrawalForGlobal = opts.minWithdrawalForGlobal;
    if (opts.withdrawalsEnabledForSite) this.withdrawalsEnabledForSite = opts.withdrawalsEnabledForSite;
    if (opts.accountRefForSite) this.accountRefForSite = opts.accountRefForSite;
    this.defaultAccountRef = opts.defaultAccountRef ?? "Invest254";
    if (opts.darajaForSite) this.darajaForSite = opts.darajaForSite;
    if (opts.entitledGatewaysForSite) this.entitledGatewaysForSite = opts.entitledGatewaysForSite;
    if (opts.megapay) this.megapay = opts.megapay;
    if (opts.payhero) this.payhero = opts.payhero;
    if (opts.paynicorn) this.paynicorn = opts.paynicorn;
    if (opts.countryForSite) this.countryForSite = opts.countryForSite;
    this.fxRateFor = opts.fxRateFor ?? ((c) => kesToCurrencyRate(c));
    if (opts.gateways) this.gateways = opts.gateways;
    this.events = opts.events ?? {};
    // Secure by default: a client can POST to the public STK callback URL, so a raw
    // resultCode=0 is NOT trusted — we re-check with Safaricom before crediting. Opt out only
    // for environments where the callback source is otherwise authenticated (e.g. IP allowlist).
    this.verifyStk = opts.verifyStkCallbacks ?? true;
  }

  // ── Deposit (STK Push) ──
  // ── Initiate gate (docs/52, migration 0175) ─────────────────────────────────────────────────────
  // PayHero answers a burst of STK initiations with
  //   400 {"error_code":"BAD_REQUEST","error_message":"The merchant has been blocked for spamming"}
  // and the block is MERCHANT-WIDE, so one player's retry loop stops deposits for every brand sharing
  // those credentials. The route's rate limit is per USER (20/min), which the observed loop — six
  // requests in 27 seconds — slipped under.
  //
  // The gate lives in POSTGRES, not in this process. An in-process counter bounds each API machine
  // independently, so with N machines the real ceiling is N x the configured one and a player's
  // post-rejection hold is honoured only by the machine that served the rejection. `fn_deposit_gate`
  // takes a row lock per key, so the count is exact however many machines are running.
  //
  // FAILS CLOSED. If the gate cannot be consulted the initiate is refused (429), never sent to the
  // gateway — so there is no path to a provider without a granted slot. The cost is nearly
  // theoretical: the deposit row is created in the same database on the same request, so a gate that
  // cannot be reached is a request that was about to fail anyway.
  //
  // What is throttled is deliberately NARROW: a retry that follows a REJECTION, plus a per-merchant
  // ceiling. A normal sequence of deposits is untouched — throttling every attempt would break a real
  // contract (a player whose deposit just succeeded may immediately make another).
  private static readonly REJECT_COOLDOWN_MS = Number(process.env.DEPOSIT_REJECT_COOLDOWN_MS ?? 6_000);
  private static readonly MERCHANT_PER_MIN = Number(process.env.DEPOSIT_MERCHANT_PER_MIN ?? 60);
  private static gateUserKey(provider: string, userId: string): string { return `dep:reject:${provider}:${userId}`; }
  private static gateMerchantKey(provider: string, scope: string): string { return `dep:merchant:${provider}:${scope}`; }

  private async guardInitiate(userId: string, provider: string, scope: string): Promise<void> {
    let verdict: "ok" | "too_soon" | "busy";
    try {
      verdict = await this.repo.depositGate(
        PaymentService.gateUserKey(provider, userId),
        PaymentService.gateMerchantKey(provider, scope),
        PaymentService.MERCHANT_PER_MIN, 60_000);
    } catch {
      // Fail closed: a gate we cannot consult is a slot we cannot grant.
      throw new Error("PROVIDER_BUSY: payments are briefly unavailable, try again shortly");
    }
    if (verdict === "too_soon") throw new Error("DEPOSIT_TOO_SOON: that payment was refused a moment ago — wait a few seconds before trying again");
    if (verdict === "busy") throw new Error("PROVIDER_BUSY: too many payment requests right now, try again shortly");
  }

  /**
   * Run the gateway call for a deposit whose row already exists. If the gateway REFUSES:
   *   * close the row out (0174) — otherwise a rejection leaves a `pending` deposit nothing will ever
   *     settle, because the callback and the reconcile sweep both key on `checkout_request_id`, which
   *     a refused deposit never receives (199 such ghosts had accumulated);
   *   * record the rejection in the shared gate, so this player's next attempt is held off on EVERY
   *     machine, not just this one.
   * The original error is always rethrown; the clean-up never masks it.
   */
  private async withAbandonOnReject<T>(txId: string, userId: string, provider: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await this.repo.depositGateReject(PaymentService.gateUserKey(provider, userId), PaymentService.REJECT_COOLDOWN_MS);
      } catch { /* never let the gate hide the provider error */ }
      try { await this.repo.abandonDeposit(txId, `abandoned:${reason}`.slice(0, 200)); }
      catch { /* likewise */ }
      throw err;
    }
  }

  async initiateDeposit(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<{ txId: string; checkoutRequestId: string }> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit(siteId);
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");
    const msisdn = normalizeMsisdn(phoneRaw);
    // PAY-1: the brand's payment owner decides WHOSE paybill receives this deposit (refused, not
    // re-routed, when that owner has no complete M-Pesa account).
    const owner = await this.ownerOf(siteId);
    await this.assertRail(owner, "mpesa");
    await this.guardInitiate(userId, "mpesa", owner.scope);
    const txId = await this.repo.createDeposit(userId, amountCents, msisdn, siteId);
    await this.stamp(txId, owner.scope);
    // Site-aware AccountReference: show the depositing brand's account, not a hardcoded one. And
    // route through the brand's OWN Daraja client when it has registered its own paybill (else shared).
    const accountRef = await this.resolveAccountRef(siteId);
    const client = owner.scope === "global" ? await this.resolveDaraja(siteId) : await this.darajaForScope(owner.scope);
    const stk = await this.withAbandonOnReject(txId, userId, "mpesa", () => client.stkPush({ amountCents, msisdn, accountRef, desc: "Deposit" }));
    await this.repo.attachStk(txId, stk.merchantRequestId, stk.checkoutRequestId);
    return { txId, checkoutRequestId: stk.checkoutRequestId };
  }

  // ── Deposit (Mega Pay STK Push) — the second rail, migration 0116 ──
  /**
   * Initiate a Mega Pay STK-push deposit. Same validation/limits as the Daraja path (min/max deposit,
   * integer cents, MSISDN normalization) so no rail can bypass the platform floors. Records a pending
   * deposit tagged provider='megapay', calls Mega Pay's initiatestk, then stores the returned
   * `transaction_request_id` in checkout_request_id via the SHARED attachStk — so settlement flows
   * through the SAME idempotent credit RPC as Daraja. Returns the ids the client needs to poll/track.
   */
  async initiateMegaPayDeposit(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<{ txId: string; transactionRequestId: string; checkoutRequestId: string }> {
    const owner = await this.ownerOf(siteId);
    if (owner.scope === "global" && !this.megapay) throw new Error("MEGAPAY_NOT_CONFIGURED");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit(siteId);
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");
    const msisdn = normalizeMsisdn(phoneRaw);
    await this.assertRail(owner, "megapay");
    const client = await this.megapayForScope(owner.scope);
    await this.guardInitiate(userId, "megapay", owner.scope);
    const txId = await this.repo.createDepositProvider(userId, amountCents, msisdn, "megapay", siteId);
    await this.stamp(txId, owner.scope);
    // The reference becomes the "Account no." shown to the payer — send the brand/site name in
    // UPPERCASE for a clean, consistent prompt (e.g. "Account no. TAMUTRADERS").
    const reference = (await this.resolveAccountRef(siteId)).toUpperCase();
    const res = await this.withAbandonOnReject(txId, userId, "megapay", () => client.initiateStk({ amountCents, msisdn, reference }));
    await this.repo.attachStk(txId, res.merchantRequestId, res.transactionRequestId);
    return { txId, transactionRequestId: res.transactionRequestId, checkoutRequestId: res.checkoutRequestId };
  }

  /**
   * Mega Pay callback handler (idempotent). Mirrors handleStkCallback's security model: the callback
   * body is NEVER trusted to credit — we ALWAYS re-query Mega Pay server-to-server for the authoritative
   * status. While the payment is still processing (or the query is transiently unavailable) we throw so
   * the deposit stays pending for the reconcile sweep; a definitively-failed status marks it failed. Only
   * a verified 'Completed' credits, via the shared fn_complete_deposit keyed by transaction_request_id.
   */
  async handleMegaPayCallback(transactionRequestId: string, raw: unknown): Promise<CompleteResult> {
    // PAY-1: verify with the account the deposit was INITIATED on (its recorded scope).
    const scope = this.gateways ? await this.repo.scopeOfCheckout(transactionRequestId) : null;
    const client = await this.megapayForScope(scope);
    const q = await client.queryStatus(transactionRequestId);
    if (q.processing || q.resultCode == null) {
      console.warn(`[payments] Mega Pay verify inconclusive for ${transactionRequestId} (processing); leaving pending for retry`);
      throw new Error("MEGAPAY_VERIFY_PENDING");
    }
    const desc = q.resultCode === 0 ? "verified:megapay" : `verified:megapay:${q.resultCode}`;
    return this.repo.completeDeposit(transactionRequestId, q.resultCode, desc, q.receipt, raw);
  }

  /**
   * Reconciliation sweep for the Mega Pay rail — mirrors reconcileDeposits but scoped to provider
   * 'megapay' and using Mega Pay's authoritative status query. Settles deposits whose webhook never
   * arrived (or was inconclusive). Safe to run repeatedly; the credit RPC guards terminal states.
   */
  async reconcileMegaPayDeposits(opts: { olderThanMs?: number; limit?: number } = {}): Promise<{ scanned: number; settled: number; stillPending: number; errors: number }> {
    if (!this.megapay && !this.gateways) return { scanned: 0, settled: 0, stillPending: 0, errors: 0 };
    const olderThanMs = opts.olderThanMs ?? 120_000;
    const limit = opts.limit ?? 25;
    const rows = await this.repo.listUnsettledDeposits(olderThanMs, limit, "megapay");
    let settled = 0, stillPending = 0, errors = 0;
    for (const d of rows) {
      try {
        const q = await (await this.megapayForScope(d.paymentScope)).queryStatus(d.checkoutRequestId);
        if (q.processing || q.resultCode == null) { stillPending += 1; continue; }
        const res = await this.repo.completeDeposit(d.checkoutRequestId, q.resultCode, `reconciled:megapay:${q.resultCode}`, q.receipt, { reconciled: true, provider: "megapay", at: new Date().toISOString() });
        if (res.applied) settled += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[payments] Mega Pay reconcile failed for ${d.checkoutRequestId}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, stillPending, errors };
  }

  // ── Deposit (PayHero / Lipwa STK Push) — the third rail ──
  /**
   * Initiate a PayHero STK-push deposit. Same validation/limits as Daraja/Mega Pay (min/max, integer
   * cents, MSISDN normalization) so no rail bypasses the platform floors. Records a pending deposit
   * tagged provider='payhero' with external_reference = our txId, calls PayHero's /payments, then stores
   * PayHero's `reference` in checkout_request_id via the SHARED attachStk — so settlement flows through
   * the SAME idempotent credit RPC as every other rail.
   */
  async initiatePayHeroDeposit(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<{ txId: string; reference: string; checkoutRequestId: string }> {
    const owner = await this.ownerOf(siteId);
    if (owner.scope === "global" && !this.payhero) throw new Error("PAYHERO_NOT_CONFIGURED");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit(siteId);
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");
    const msisdn = normalizeMsisdn(phoneRaw);
    await this.assertRail(owner, "payhero");
    const client = await this.payheroForScope(owner.scope);
    await this.guardInitiate(userId, "payhero", owner.scope);
    const txId = await this.repo.createDepositProvider(userId, amountCents, msisdn, "payhero", siteId);
    await this.stamp(txId, owner.scope);
    const res = await this.withAbandonOnReject(txId, userId, "payhero", () => client.initiateStk({ amountCents, msisdn, externalReference: txId }));
    // Store PayHero's `reference` in checkout_request_id (its status endpoint + reconcile query by it);
    // keep the ws_CO CheckoutRequestID in merchant_request_id for reference.
    await this.repo.attachStk(txId, res.checkoutRequestId, res.reference);
    return { txId, reference: res.reference, checkoutRequestId: res.checkoutRequestId };
  }

  /**
   * Initiate a PayHero **Lipwa** (hosted multi-channel) deposit — card, bank, mobile-money, cross-border.
   * We do NOT collect card data (PayHero's PCI-hosted page does); we only mint a pending 'payhero'
   * transaction keyed by its own id and hand back the Lipwa URL (embedded in-app). PayHero echoes our
   * txId as the ledger row's external_reference, so `reconcilePayHeroLedger` credits it through the SAME
   * idempotent fn_complete_deposit as every other rail. Same floors/limits as STK — no rail bypasses them.
   */
  async initiateLipwaDeposit(userId: string, amountCents: number, siteId?: string): Promise<{ txId: string; lipwaUrl: string; reference: string }> {
    const owner = await this.ownerOf(siteId);
    if (owner.scope === "global" && !this.payhero) throw new Error("PAYHERO_NOT_CONFIGURED");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit(siteId);
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");
    await this.assertRail(owner, "payhero");
    const client = await this.payheroForScope(owner.scope);
    if (!(await client.lipwaLink({ reference: "probe" }))) throw new Error("PAYHERO_LIPWA_NOT_CONFIGURED");
    // external_reference we pass to Lipwa === our txId === the tx's checkout_request_id, so the ledger match is unambiguous.
    await this.guardInitiate(userId, "payhero", owner.scope);
    const txId = await this.repo.createDepositProvider(userId, amountCents, "", "payhero", siteId);
    await this.stamp(txId, owner.scope);
    // Mint the link FIRST: attaching the checkout id before the call would make a refused deposit
    // un-abandonable (fn_abandon_deposit refuses any row that carries one, by design).
    const lipwaUrl = (await this.withAbandonOnReject(txId, userId, "payhero", () => client.lipwaLink({ amountKes: Math.round(amountCents / 100), reference: txId })))!;
    await this.repo.attachStk(txId, `lipwa:${txId}`, txId);
    return { txId, lipwaUrl, reference: txId };
  }

  /**
   * PayHero callback handler. Like the Mega Pay/Daraja model, the callback body is NEVER trusted to
   * credit. We run the authoritative sweep, which re-queries PayHero server-to-server for each recent
   * unsettled PayHero deposit — by the `reference` WE stored — and settles only the verified-paid ones
   * via fn_complete_deposit. So a forged callback can't mint balance.
   */
  async handlePayHeroCallback(_raw: unknown): Promise<{ settled: number }> {
    if (!this.payhero && !this.gateways) throw new Error("PAYHERO_NOT_CONFIGURED");
    // Run BOTH authoritative sweeps: the status sweep settles STK deposits by reference, and the ledger
    // sweep settles Lipwa (card/bank) + ingests manual paybill payments. The body is never trusted.
    const [status, ledger] = await Promise.all([
      this.reconcilePayHeroDeposits({ olderThanMs: 0 }),
      this.reconcilePayHeroLedger().catch(() => ({ settled: 0 })),
    ]);
    return { settled: status.settled + ledger.settled };
  }

  // ── Deposit (Paynicorn / "PayX" M-Pesa push) ──
  /**
   * Initiate a Paynicorn deposit as a plain M-Pesa prompt: the order names the method and the payer's
   * phone, so Paynicorn pushes the STK itself and no Paynicorn page is ever shown. Same validation and
   * limits as every other rail, plus whole shillings (KES has no decimals on Paynicorn). Our txId is the
   * Paynicorn `orderId` and the checkout_request_id, so the postback, the query and the reconcile sweep
   * all key on it. Nothing is credited here; the player's sheet polls this tx until it settles.
   */
  async initiatePaynicornDeposit(
    userId: string,
    amountCents: number,
    siteId?: string,
    opts: { method?: string; phone?: string; email?: string; frontPage?: string } = {},
  ): Promise<{ txId: string; checkoutRequestId: string; checkoutUrl?: string }> {
    const owner = await this.ownerOf(siteId);
    if (owner.scope === "global" && !this.paynicorn) throw new Error("PAYNICORN_NOT_CONFIGURED");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit(siteId);
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");

    const ctx = await this.paynicornContext(siteId);
    // Collecting in the platform's own currency means the player typed this amount: it must be a whole
    // unit, as it always has been. A converted amount rounds to the local currency's precision instead.
    if (ctx.currency === "KES" && amountCents % 100 !== 0) throw new Error("INVALID_AMOUNT");

    // The method must be one this country actually offers, so a client cannot name an arbitrary code.
    const methods = await this.listPaynicornMethods(siteId);
    if (!methods.length) throw new Error("PAYNICORN_NO_METHODS");
    const chosen = opts.method
      ? methods.find((m) => m.code.toUpperCase() === opts.method!.toUpperCase())
      : methods[0];
    if (!chosen) throw new Error("PAYNICORN_METHOD_UNAVAILABLE");

    // Only a phone and an email can ever be supplied to the collection API, so a method needing
    // anything else must finish on the gateway's own page (docs/53).
    const direct = methodIsDirect(chosen);
    const msisdn = opts.phone ? normalizeMsisdn(opts.phone) : null;
    const wantsPhone = chosen.inputs.some((i) => /phone/i.test(i.type));
    const wantsEmail = chosen.inputs.some((i) => /email/i.test(i.type));
    if (direct && wantsPhone && !msisdn) throw new Error("INVALID_PHONE");
    if (direct && wantsEmail && !opts.email) throw new Error("EMAIL_REQUIRED");

    await this.assertRail(owner, "paynicorn");
    const client = this.paynicornClient();
    await this.guardInitiate(userId, "paynicorn", owner.scope);
    const txId = await this.repo.createDepositProvider(userId, amountCents, msisdn ?? "", "paynicorn", siteId);
    await this.stamp(txId, owner.scope);

    const amount = formatPaynicornAmount((amountCents / 100) * ctx.rate, ctx.decimals);
    const description = `Deposit ${await this.resolveAccountRef(siteId)}`;
    const res = await this.withAbandonOnReject(txId, userId, "paynicorn", () => client.pay({
      amount, countryCode: ctx.country, currency: ctx.currency, orderId: txId, description,
      payMethod: chosen.code,
      ...(direct && wantsPhone && msisdn ? { phone: toPaynicornPhone(msisdn) } : {}),
      ...(direct && wantsEmail && opts.email ? { email: opts.email } : {}),
      ...(opts.frontPage ? { frontPage: opts.frontPage } : {}),
    }));
    await this.repo.attachStk(txId, res.txnId || `paynicorn:${txId}`, txId);
    // A hosted method hands back the page to open; a direct push has none and never leaves our app.
    return { txId, checkoutRequestId: txId, ...(res.webUrl ? { checkoutUrl: res.webUrl } : {}) };
  }

  /** The country, local currency, decimals and live KES->local rate a brand collects with. */
  private async paynicornContext(siteId?: string): Promise<{ country: string; currency: string; decimals: 0 | 1 | 2; rate: number }> {
    let code: string | null = null;
    if (this.countryForSite) { try { code = await this.countryForSite(siteId); } catch { code = null; } }
    const c = paynicornCountry(code) ?? paynicornCountry("KE")!;
    const rate = c.currency === "KES" ? 1 : await this.fxRateFor(c.currency);
    if (!(rate > 0)) throw new Error("FX_UNAVAILABLE");
    return { country: c.code, currency: c.currency, decimals: c.decimals, rate };
  }

  /**
   * The methods Paynicorn will actually accept for this brand's country, cached briefly so the deposit
   * sheet does not call out on every render. A country outside the merchant's console scope returns an
   * empty list, which simply means PayX offers nothing there.
   */
  async listPaynicornMethods(siteId?: string): Promise<PaynicornMethod[]> {
    if (!this.paynicorn) return [];
    let ctx: { country: string; currency: string };
    try { ctx = await this.paynicornContext(siteId); } catch { return []; }
    const key = `${ctx.country}:${ctx.currency}`;
    const hit = this.methodCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.methods;
    try {
      const methods = await this.paynicorn.listMethods(ctx.country, ctx.currency);
      this.methodCache.set(key, { at: Date.now(), methods });
      return methods;
    } catch (err) {
      console.warn(`[payments] PayX method list failed for ${key}: ${(err as Error).message}`);
      return hit?.methods ?? [];
    }
  }

  /**
   * Paynicorn postback. The signature (md5 with OUR merchant secret) must verify, and even then the body's
   * status is NOT what credits: we re-query Paynicorn by orderId and settle on that authoritative answer.
   * Returns Paynicorn's txnId so the route can answer `success_{txnId}`; `settled` says whether this call
   * moved money. An order we don't hold (e.g. a console address check) is acknowledged and ignored.
   */
  async handlePaynicornCallback(raw: unknown): Promise<{ txnId: string; settled: boolean }> {
    const client = this.paynicornClient();
    const pb = await client.verifyPostback(raw);
    if (!pb) throw new Error("PAYNICORN_BAD_SIGNATURE");
    // Our orderIds are transaction uuids; anything else is not ours (and would make Postgres throw).
    const tx = UUID_RE.test(pb.orderId) ? await this.repo.getTransaction(pb.orderId) : null;
    if (!tx || tx.kind !== "deposit" || (tx.provider != null && tx.provider !== "paynicorn")) return { txnId: pb.txnId, settled: false };
    // A signed amount that disagrees with the order is never credited (left for review). Only checkable
    // when the collection currency IS our own: a converted amount was rounded to the local currency and
    // the rate has moved since. The authoritative query below is what actually decides either way.
    const paid = Number(pb.amount);
    if (pb.currency === "KES" && pb.amount !== "" && Number.isFinite(paid) && Math.round(paid * 100) !== tx.amountCents) {
      throw new Error("PAYNICORN_AMOUNT_MISMATCH");
    }
    const q = await client.queryPayment(pb.orderId);
    if (q.processing || q.resultCode == null) return { txnId: pb.txnId, settled: false };
    const res = await this.repo.completeDeposit(pb.orderId, q.resultCode, q.resultCode === 0 ? "verified:paynicorn" : `verified:paynicorn:${q.resultCode}`,
      q.txnId ?? (pb.txnId || null), { provider: "paynicorn", postback: { txnId: pb.txnId, status: pb.status, code: pb.code }, at: new Date().toISOString() });
    return { txnId: pb.txnId, settled: res.applied };
  }

  /** Reconcile sweep for 'paynicorn' deposits whose postback never arrived — the same authoritative query. */
  async reconcilePaynicornDeposits(opts: { olderThanMs?: number; limit?: number } = {}): Promise<{ scanned: number; settled: number; stillPending: number; errors: number }> {
    if (!this.paynicorn) return { scanned: 0, settled: 0, stillPending: 0, errors: 0 };
    const rows = await this.repo.listUnsettledDeposits(opts.olderThanMs ?? 120_000, opts.limit ?? 25, "paynicorn");
    let settled = 0, stillPending = 0, errors = 0;
    for (const d of rows) {
      try {
        const q = await this.paynicorn.queryPayment(d.checkoutRequestId);
        if (q.processing || q.resultCode == null) { stillPending += 1; continue; }
        const res = await this.repo.completeDeposit(d.checkoutRequestId, q.resultCode, `reconciled:paynicorn:${q.resultCode}`, q.txnId, { reconciled: true, provider: "paynicorn", at: new Date().toISOString() });
        if (res.applied) settled += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[payments] Paynicorn reconcile failed for ${d.checkoutRequestId}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, stillPending, errors };
  }

  private paynicornClient(): PaynicornClient {
    if (!this.paynicorn) throw new Error("PAYNICORN_NOT_CONFIGURED");
    return this.paynicorn;
  }

  /**
   * Reconciliation sweep for the PayHero rail — mirrors the Mega Pay sweep, scoped to provider 'payhero'
   * and using PayHero's authoritative transaction-status query. Settles deposits whose callback never
   * arrived (or was inconclusive). Safe to run repeatedly; the credit RPC guards terminal states.
   */
  async reconcilePayHeroDeposits(opts: { olderThanMs?: number; limit?: number } = {}): Promise<{ scanned: number; settled: number; stillPending: number; errors: number }> {
    if (!this.payhero && !this.gateways) return { scanned: 0, settled: 0, stillPending: 0, errors: 0 };
    const olderThanMs = opts.olderThanMs ?? 120_000;
    const limit = opts.limit ?? 25;
    const rows = await this.repo.listUnsettledDeposits(olderThanMs, limit, "payhero");
    let settled = 0, stillPending = 0, errors = 0;
    for (const d of rows) {
      try {
        const q = await (await this.payheroForScope(d.paymentScope)).queryStatus(d.checkoutRequestId);
        if (q.processing || q.resultCode == null) { stillPending += 1; continue; }
        const res = await this.repo.completeDeposit(d.checkoutRequestId, q.resultCode, `reconciled:payhero:${q.resultCode}`, q.receipt, { reconciled: true, provider: "payhero", at: new Date().toISOString() });
        if (res.applied) settled += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[payments] PayHero reconcile failed for ${d.checkoutRequestId}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, stillPending, errors };
  }

  /**
   * Ledger reconcile — the settlement path for Lipwa (card/bank/multi-country) AND manual paybill C2B.
   * Reads PayHero's authoritative account ledger (GET /transactions, one shared account) and, per inbound
   * payment:
   *   • external_reference set (STK/Lipwa) → credit the matching pending tx via fn_complete_deposit.
   *     A row whose tx is already terminal returns applied=false and is left alone (no double credit);
   *     TX_NOT_FOUND means no tx owns that reference, so it falls through to be claimable by code.
   *   • no external_reference (manual paybill) → ingest into c2b_payments so the payer claims it by
   *     M-PESA code through the SAME fraud-safe fn_claim_c2b_deposit as the Daraja paybill.
   * Money-safe by construction: a payment is EITHER auto-credited to its own tx OR made claimable once —
   * never both — and every write (fn_complete_deposit, fn_ingest_c2b) is idempotent, so re-runs are no-ops.
   */
  async reconcilePayHeroLedger(opts: { page?: number } = {}): Promise<{ scanned: number; settled: number; ingested: number; errors: number }> {
    if (!this.payhero && !this.gateways) return { scanned: 0, settled: 0, ingested: 0, errors: 0 };
    let rows: Awaited<ReturnType<PayHeroClient["listInboundPayments"]>> = [];
    try { rows = await (await this.payheroForScope(null)).listInboundPayments({ page: opts.page ?? 1 }); }
    catch { return { scanned: 0, settled: 0, ingested: 0, errors: 1 }; }
    let settled = 0, ingested = 0, errors = 0;
    // WHICH references are ours, asked once for the whole page before the loop.
    //
    // Most rows here are not ours — PayHero's ledger is ONE SHARED ACCOUNT, so it carries references
    // written by whatever else uses it. The loop below used to find that out the only way available:
    // call fn_complete_deposit and catch the TX_NOT_FOUND it raises. Correct, and the fallback below
    // still handles it, but a raised plpgsql exception reaches Postgres as an ERROR — and this sweep
    // runs every 60 seconds over a page that barely changes, so the SAME misses were re-raised every
    // minute forever: measured at ~10 a minute, 954 in 96 minutes, every error line in the database
    // log. That buries the TX_NOT_FOUND that is a REAL failure (fn_complete_withdrawal,
    // fn_reject_withdrawal, fn_admin_mark_withdrawal_paid all raise it when an operator acts on a
    // transaction that is not there) in noise nobody can filter.
    //
    // One indexed lookup per sweep replaces N exceptions. Money semantics are unchanged: a reference
    // we own still goes through the same idempotent RPC, and one we do not still falls through to
    // claimable-by-code, so a payment is still EITHER credited to its tx OR claimable, never both.
    const owned = await this.repo.ownedDepositRefs(rows.map((p) => p.externalReference).filter((r): r is string => r !== null));
    for (const p of rows) {
      try {
        if (p.externalReference && owned.has(p.externalReference)) {
          try {
            const res = await this.repo.completeDeposit(p.externalReference, 0, "ledger:payhero", p.mpesaCode,
              { ledger: true, provider: "payhero", mpesaCode: p.mpesaCode, at: new Date().toISOString() });
            if (res.applied) settled += 1;
            continue; // a tx owns this reference (credited now, or already terminal) — never also ingest it
          } catch (err) {
            if (!/TX_NOT_FOUND/.test((err as Error).message)) throw err; // real error -> count it, don't lose the payment
            // Kept as the race fallback: the tx could vanish between the batch lookup above and this
            // call. Behaviour is then exactly what it always was — fall through to claimable-by-code
            // so nothing is stranded. (The reverse race, a tx created in that window, is credited by
            // the next sweep, which is also what happened before.)
          }
        }
        const stored = await this.repo.ingestC2b({
          transId: p.mpesaCode, amountCents: p.amountCents, msisdn: p.msisdn,
          billRef: p.externalReference ?? p.reference, shortcode: "payhero", raw: { provider: "payhero", ledger: true },
        });
        if (stored) ingested += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[payments] PayHero ledger reconcile failed for ${p.mpesaCode}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, ingested, errors };
  }

  /**
   * The deposit gateways to show a player, resolved for their brand (global switch + per-site override,
   * migration 0116) and filtered to gateways with a REAL player deposit rail (PLAYER_DEPOSIT_RAILS).
   * A config-only gateway (e.g. Paystack/Binance) can never surface here, so the deposit page never
   * offers a path the system can't serve. Fail-open: if the lookup throws we return the always-present
   * M-Pesa rail so a config/DB glitch can't hide the working deposit path from players.
   */
  async listDepositProviders(siteId?: string): Promise<DepositProvider[]> {
    try {
      const list = await this.repo.listEffectiveProviders(siteId);
      let rails = (list.length ? list : [{ code: "mpesa", displayName: "M-Pesa" }]).filter((p) => PLAYER_DEPOSIT_RAILS.has(p.code));
      // Entitlement gate (Issue 2): a brand only ever surfaces gateways it OWNS (mpesa always entitled).
      // Fail-open: a null/throwing lookup (or no brand context) leaves the effective list untouched.
      if (this.entitledGatewaysForSite) {
        try {
          const ent = await this.entitledGatewaysForSite(siteId);
          if (ent && ent.length) { const allow = new Set(ent); rails = rails.filter((p) => allow.has(p.code)); }
        } catch { /* fail-open */ }
      }
      // PAY-1: a brand on its OWN accounts shows only the rails those accounts can serve — never the
      // System owner's M-Pesa as a fallback (its deposits would land in someone else's paybill).
      const owner = await this.ownerOf(siteId);
      if (owner.scope !== "global" && this.gateways) {
        const ready = await this.gateways.depositRails(owner.scope as Exclude<PaymentScopeRef, "global">);
        return rails.filter((p) => ready.has(p.code));
      }
      if (!rails.length) return [{ code: "mpesa", displayName: "M-Pesa" }];
      return rails;
    } catch (err) {
      console.warn(`[payments] listDepositProviders failed (${(err as Error).message}); falling back to M-Pesa only`);
      return [{ code: "mpesa", displayName: "M-Pesa" }];
    }
  }

  /**
   * The deposit CHANNELS a player on this brand can actually complete — the single source of truth for
   * the deposit sheet. Built on top of listDepositProviders (the 0116 enable/disable resolution) and
   * then narrowed by per-channel readiness, because an enabled gateway does not imply every one of its
   * rails works:
   *   - STK: one entry per effective gateway. The gateway BRAND is never shown (docs/35) — every STK
   *     rail reads "M-Pesa", numbered only in the rare case that several are enabled at once.
   *   - Lipwa (card/bank): PayHero only, and ONLY when `lipwa_url` is configured. It is optional for
   *     `depositsReady`, so without this probe the tab renders and then throws
   *     PAYHERO_LIPWA_NOT_CONFIGURED on submit — which is exactly what it did.
   *   - Pay Bill: the System owner's Daraja paybill, so it needs M-Pesa live for this brand AND
   *     `paybillConfig().enabled` (false for a brand on its own accounts, docs/43 §3.6).
   * Never throws: any probe failure omits that channel rather than hiding the whole sheet.
   */
  async listDepositMethods(siteId?: string): Promise<DepositMethod[]> {
    const providers = await this.listDepositProviders(siteId);
    const enabled = new Set(providers.map((p) => p.code));
    const methods: DepositMethod[] = [];

    // Every gateway except PayX exposes exactly one STK rail, labelled "M-Pesa" (the gateway brand is
    // never shown, docs/35).
    const stkProviders = providers.filter((p) => p.code !== "paynicorn");
    stkProviders.forEach((p, i) => {
      methods.push({
        id: `${p.code}-stk`,
        provider: p.code,
        channel: "stk",
        label: stkProviders.length > 1 ? `M-Pesa (${i + 1})` : "M-Pesa",
      });
    });

    // PayX is per-COUNTRY: whatever Paynicorn says this brand's country can pay with, each as its own
    // tab. A country offering only cards shows only a card tab; one offering three shows three. A method
    // we can collect the inputs for runs in our own form (channel "stk"); anything else has to finish on
    // the gateway's page (channel "checkout"), because the collection API takes no other input. docs/53.
    if (enabled.has("paynicorn") && (await this.paynicornAvailable(siteId))) {
      for (const m of await this.listPaynicornMethods(siteId)) {
        methods.push({
          id: `paynicorn-${m.code.toLowerCase()}`,
          provider: "paynicorn",
          channel: methodIsDirect(m) ? "stk" : "checkout",
          label: m.name,
          methodCode: m.code,
          fields: m.inputs.map((i) => ({ name: i.name, type: i.type, ...(i.pattern ? { pattern: i.pattern } : {}) })),
          ...(m.iconUrl ? { iconUrl: m.iconUrl } : {}),
        });
      }
    }

    if (enabled.has("payhero") && (await this.lipwaAvailable(siteId))) {
      methods.push({ id: "payhero-lipwa", provider: "payhero", channel: "lipwa", label: "Card & Bank" });
    }

    if (enabled.has("mpesa")) {
      try {
        const cfg = await this.paybillConfig(siteId);
        if (cfg.enabled) methods.push({ id: "mpesa-paybill", provider: "mpesa", channel: "paybill", label: "Pay Bill" });
      } catch { /* paybill unavailable for this brand -> simply not offered */ }
    }
    return methods;
  }

  /**
   * True when PayHero's hosted Lipwa checkout is actually usable for this brand. Mirrors EVERY
   * precondition initiateLipwaDeposit enforces, so the sheet can never offer a channel the initiate
   * call would reject: the global scope needs a configured PayHero client (`payheroForScope` returns a
   * stub rather than throwing, which is why initiate guards on `!this.payhero` first), and the account
   * needs `lipwa_url` (absent → `lipwaLink` resolves null). Any probe failure ⇒ not offered.
   */
  private async lipwaAvailable(siteId?: string): Promise<boolean> {
    try {
      const owner = await this.ownerOf(siteId);
      if (owner.scope === "global" && !this.payhero) return false;
      const client = await this.payheroForScope(owner.scope);
      return Boolean(await client.lipwaLink({ reference: "probe" }));
    } catch {
      return false;
    }
  }

  /** Mirrors initiatePaynicornDeposit's preconditions: the System owner's client exists and the brand is on it. */
  private async paynicornAvailable(siteId?: string): Promise<boolean> {
    try {
      const owner = await this.ownerOf(siteId);
      return owner.scope === "global" && !!this.paynicorn;
    } catch {
      return false;
    }
  }

  /** Resolve the brand's STK AccountReference, sanitised for Daraja (alphanumeric, <=12). */
  private async resolveAccountRef(siteId?: string): Promise<string> {
    let ref = this.defaultAccountRef;
    if (this.accountRefForSite) {
      try {
        const v = await this.accountRefForSite(siteId);
        if (typeof v === "string" && v.trim().length > 0) ref = v.trim();
      } catch { /* fall back to default */ }
    }
    const clean = ref.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    return clean.length > 0 ? clean : "Invest254";
  }

  // ── PAY-1 scope routing (docs/43) ──────────────────────────────────────────────────────────────
  /** The brand's payment owner. No router => global. A router failure REFUSES (never guesses an owner). */
  private async ownerOf(siteId?: string | null): Promise<OwnerScope> {
    if (!this.gateways) return { scope: "global", payoutsEnabled: true };
    return this.gateways.ownerScope(siteId ?? undefined);
  }
  /** Refuse a rail the brand's (non-global) owner has no complete account for — never fall back to another owner. */
  private async assertRail(owner: OwnerScope, rail: string): Promise<void> {
    if (owner.scope === "global" || !this.gateways) return;
    const rails = await this.gateways.depositRails(owner.scope as Exclude<PaymentScopeRef, "global">);
    if (!rails.has(rail)) throw new Error("GATEWAY_NOT_CONFIGURED");
  }
  private async stamp(txId: string, scope: PaymentScopeRef): Promise<void> {
    if (this.gateways) await this.repo.setPaymentScope(txId, scope);
  }
  /** Clients of a recorded scope (a transaction's): null/legacy/'global' => the global clients. */
  private async scopedClients(scope: string | null | undefined) {
    if (!this.gateways) return null;
    const p = parseScope(scope ?? null);
    if (p.type === "global") return null;
    return this.gateways.clients(scope as Exclude<PaymentScopeRef, "global">);
  }
  private async darajaForScope(scope: string | null | undefined): Promise<DarajaClient> {
    return (await this.scopedClients(scope))?.daraja ?? this.daraja;
  }
  private async megapayForScope(scope: string | null | undefined): Promise<MegaPayClient> {
    const c = await this.scopedClients(scope);
    if (c) return c.megapay;
    if (!this.megapay) throw new Error("MEGAPAY_NOT_CONFIGURED");
    return this.megapay;
  }
  private async payheroForScope(scope: string | null | undefined): Promise<PayHeroClient> {
    const c = await this.scopedClients(scope);
    if (c) return c.payhero;
    if (!this.payhero) throw new Error("PAYHERO_NOT_CONFIGURED");
    return this.payhero;
  }

  /** Resolve the brand's Daraja client (own paybill) or fall back to the shared platform client. */
  private async resolveDaraja(siteId?: string): Promise<DarajaClient> {
    if (this.darajaForSite) {
      try {
        const c = await this.darajaForSite(siteId);
        if (c) return c;
      } catch { /* fall back to shared client */ }
    }
    return this.daraja;
  }
  /**
   * Daraja STK callback handler (idempotent). A success (resultCode 0) is verified against
   * Safaricom via STKPushQuery before crediting so forged callbacks can't mint balance; while
   * the prompt is still processing (or the query is transiently unavailable) we throw so the
   * caller returns non-200 and Safaricom retries — the deposit is never credited unverified.
   */
  async handleStkCallback(checkoutRequestId: string, resultCode: number, resultDesc: string, receipt: string | null, raw: unknown): Promise<CompleteResult> {
    let code = resultCode;
    let desc = resultDesc;
    if (resultCode === 0 && this.verifyStk) {
      // PAY-1: verify on the account the deposit was INITIATED on (never "whatever is live now").
      const scope = this.gateways ? await this.repo.scopeOfCheckout(checkoutRequestId) : null;
      const q = await (await this.darajaForScope(scope)).stkPushQuery(checkoutRequestId);
      if (q.processing || q.resultCode == null) {
        console.warn(`[payments] STK verify inconclusive for ${checkoutRequestId} (processing=${q.processing}); leaving pending for retry`);
        throw new Error("STK_VERIFY_PENDING");
      }
      code = q.resultCode;
      if (code !== 0) desc = `verified:${resultDesc}`;
    }
    return this.repo.completeDeposit(checkoutRequestId, code, desc, receipt, raw);
  }

  /**
   * Reconciliation sweep for deposits that never reached a terminal state — e.g. a callback that
   * was never delivered, or one whose verification was inconclusive at the time. For each stale
   * deposit we ask Safaricom for the authoritative outcome (STKPushQuery) and settle accordingly:
   * paid => credit (idempotent via the RPC), definitively failed => mark failed, still processing
   * => leave for the next sweep. Safe to run repeatedly; the RPCs guard terminal states.
   */
  async reconcileDeposits(opts: { olderThanMs?: number; limit?: number } = {}): Promise<{ scanned: number; settled: number; stillPending: number; errors: number }> {
    const olderThanMs = opts.olderThanMs ?? 120_000; // give the live callback a chance first
    const limit = opts.limit ?? 25;
    // Scope to the Daraja rail ONLY (migration 0116): this sweep verifies via Safaricom STKPushQuery,
    // so it must never pick up a 'megapay' deposit (whose id would be meaningless to Safaricom).
    const rows = await this.repo.listUnsettledDeposits(olderThanMs, limit, "mpesa");
    let settled = 0, stillPending = 0, errors = 0;
    for (const d of rows) {
      try {
        const q = await (await this.darajaForScope(d.paymentScope)).stkPushQuery(d.checkoutRequestId);
        if (q.processing || q.resultCode == null) { stillPending += 1; continue; }
        const res = await this.repo.completeDeposit(d.checkoutRequestId, q.resultCode, `reconciled:${q.resultCode}`, null, { reconciled: true, at: new Date().toISOString() });
        if (res.applied) settled += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[payments] reconcile failed for ${d.checkoutRequestId}: ${(err as Error).message}`);
      }
    }
    return { scanned: rows.length, settled, stillPending, errors };
  }

  // ── Withdrawal (B2C) ──
  /**
   * Player requests a withdrawal.
   *  - If the player's phone is a MARKETER, the money is moved INSTANTLY from the game wallet into
   *    that phone's mpesa (marketer) wallet — no Daraja, no admin approval — and returned as paid.
   *  - Otherwise it validates and HOLDS funds atomically (status pending) for the normal M-Pesa flow.
   */
  async requestWithdrawal(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<WithdrawalOutcome> {
    // Kill switch first: if withdrawals are disabled for this brand, refuse before any money moves —
    // this halts BOTH the marketer instant transfer and the player pending request. Fail-open on a
    // missing/throwing resolver so a config glitch never blocks legitimate payouts.
    if (this.withdrawalsEnabledForSite) {
      let enabled = true;
      try { enabled = (await this.withdrawalsEnabledForSite(siteId)) !== false; } catch { enabled = true; }
      if (!enabled) throw new Error("WITHDRAWALS_DISABLED");
    }
    const minWithdrawal = await this.currentMinWithdrawal(siteId);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    if (amountCents < minWithdrawal) throw new Error("BELOW_MIN");
    // Marketer instant path (game -> mpesa wallet). Phone is resolved from the player's profile.
    const gw = await this.repo.gameWithdraw(userId, amountCents);
    if (gw.isMarketer) {
      // Demo / "funny money" game→wallet transfer is INSTANT (Issue 1 correction, migration 0109):
      // it moves the account's NON-withdrawable demo balance into the marketer's simulated M-Pesa
      // wallet for social proof. It never touches real cash, so it needs NO admin approval and never
      // rides the Telegram/email approval channel. Only REAL money — player M-Pesa withdrawals and
      // marketer commission payouts — requires the superadmin's approval. (fn_marketer_game_withdraw
      // debits demo + credits the marketer wallet + writes a settled 'success' row in one call.)
      // The transfer already succeeded (settled 'success'); notify so the activity feed records it.
      // Deliberately NOT onWithdrawalRequested — demo money never rides the approval channel.
      try { this.events.onWithdrawalSuccess?.({ userId, amountCents }); } catch { /* never block */ }
      return {
        mode: "marketer", txId: gw.txId!, newBalance: gw.newBalance!,
        mpesaBalanceCents: gw.mpesaBalanceCents ?? 0,
      };
    }
    // Normal player: real M-Pesa payout via the pending -> admin approve -> Daraja B2C flow.
    const msisdn = normalizeMsisdn(phoneRaw);
    const res: CreateWithdrawalResult = await this.repo.createWithdrawal(userId, amountCents, msisdn, minWithdrawal, siteId);
    // Real-time admin alert (Issue 1): a pending request now exists that needs an approve/reject
    // decision. Fire-and-forget so a push failure can never roll back or delay the player's request.
    try {
      this.events.onWithdrawalRequested?.({ txId: res.txId, userId, amountCents, phone: msisdn, siteId });
    } catch { /* never let a notification hook affect the withdrawal outcome */ }
    return { mode: "daraja", txId: res.txId, newBalance: res.newBalance };
  }

  /**
   * The minimum withdrawal in force for THIS request. Resolution order (multi-tenant safe):
   *   0. `minWithdrawalNativeForSite(siteId)` — the brand's EXPLICIT native floor (min_withdrawal_native,
   *      e.g. $5). This is the operator's stated per-brand intent, so it OVERRIDES the platform GLOBAL
   *      enforce; a brand that opted into its own floor is not clamped up to the global one.
   *   1. `minWithdrawalForGlobal()` — the platform GLOBAL enforced value (0099), for brands with no native.
   *   2. `minWithdrawalForSite(siteId)` — the withdrawing brand's own `site_game_config.min_withdrawal`,
   *      i.e. exactly the floor the player's client validated against (kills the client/server BELOW_MIN
   *      divergence for brands whose minimum differs from the platform default);
   *   3. `minWithdrawalProvider()` — the process-wide live default (admin-editable `game_config.min_withdrawal`);
   *   4. the boot-time constant.
   * Any source that is absent, throws, or yields a non-positive / non-integer value is skipped, so a
   * transient bad config can never open the floor below the safe default.
   */
  private async currentMinWithdrawal(siteId?: string): Promise<Cents> {
    // 0. An EXPLICIT per-brand native floor is the operator's intent and wins over the global enforce.
    if (this.minWithdrawalNativeForSite) {
      try {
        const nat = await this.minWithdrawalNativeForSite(siteId);
        if (Number.isInteger(nat) && (nat as number) > 0) return nat as Cents;
      } catch { /* fall through to the global / per-site / provider / static chain */ }
    }
    // 1. Platform GLOBAL enforce wins over per-site legacy + provider + static (for brands w/o a native floor).
    if (this.minWithdrawalForGlobal) {
      try {
        const g = await this.minWithdrawalForGlobal();
        if (Number.isInteger(g) && (g as number) > 0) return g as Cents;
      } catch { /* fail-open to the per-site / provider / static chain */ }
    }
    if (this.minWithdrawalForSite) {
      try {
        const perSite = await this.minWithdrawalForSite(siteId);
        if (Number.isInteger(perSite) && (perSite as number) > 0) return perSite as Cents;
      } catch {
        // fall through to the process-wide provider / static default
      }
    }
    const live = this.minWithdrawalProvider?.();
    return Number.isInteger(live) && (live as number) > 0 ? (live as Cents) : this.minWithdrawal;
  }

  /**
   * The minimum deposit in force for THIS request. Resolution order:
   *   0. `minDepositForSite(siteId)` — the brand's EXPLICIT native floor (min_deposit_native, e.g. $1)
   *      converted to KES cents at the live rate. This is the operator's stated per-brand intent, so it
   *      OVERRIDES the platform GLOBAL enforce and may sit BELOW the static default; a valid positive
   *      integer is used as-is. Brands with no native value return a non-positive sentinel and fall through.
   *   1. `minDepositForGlobal` — the platform GLOBAL enforced value (0099), for brands with no native floor.
   *   2. the static default constant.
   * Any source that is absent, throws, or yields a non-positive/non-integer value is skipped, so a
   * transient bad config can never open the floor below `this.minDeposit` for a brand that hasn't opted out.
   */
  private async currentMinDeposit(siteId?: string): Promise<Cents> {
    // 0. An EXPLICIT per-brand native floor is the operator's intent and wins over the global enforce.
    if (this.minDepositForSite) {
      try {
        const perSite = await this.minDepositForSite(siteId);
        if (Number.isInteger(perSite) && (perSite as number) > 0) return perSite as Cents;
      } catch { /* fall through to the global / static chain */ }
    }
    if (this.minDepositForGlobal) {
      try {
        const g = await this.minDepositForGlobal();
        if (Number.isInteger(g) && (g as number) > 0) return g as Cents;
      } catch { /* fail-open to the static default */ }
    }
    return this.minDeposit;
  }

  /** The maximum single deposit in force, or null (no cap). Only the platform GLOBAL enforce sets it. */
  private async currentMaxDeposit(): Promise<Cents | null> {
    if (this.maxDepositForGlobal) {
      try {
        const g = await this.maxDepositForGlobal();
        if (g !== null && Number.isInteger(g) && (g as number) > 0) return g as Cents;
      } catch { /* fail-open to no cap */ }
    }
    return null;
  }
  /** Finance admin approves: flips to processing and dispatches the payout (Daraja B2C, or PayHero). */
  async approveWithdrawal(txId: string, adminId: string): Promise<{ approved: boolean; conversationId?: string }> {
    // PAY-1: payouts follow the brand's payment OWNER. Decide (and refuse) BEFORE the approval flips the
    // row to 'processing', so a missing payout account never strands a withdrawal mid-flight.
    let payoutScope: PaymentScopeRef = "global";
    let payoutClient: DarajaClient = this.daraja;
    // PayHero payout rail: used ONLY for the GLOBAL (system-owner) scope, and ONLY when it is fully
    // configured (creds + account_id + withdraw channel). Absent that config it stays dark and every
    // payout goes through Daraja B2C exactly as before — brand-OWNED payouts always use their own Daraja.
    let usePayHeroPayout = false;
    if (this.gateways) {
      const tx = await this.repo.getTransaction(txId);
      if (tx && tx.kind === "withdrawal" && tx.provider !== "internal") {
        const owner = await this.ownerOf(tx.siteId);
        if (owner.scope !== "global") {
          const sc = owner.scope as Exclude<PaymentScopeRef, "global">;
          if (!owner.payoutsEnabled || !(await this.gateways.payoutsReady(sc))) throw new Error("MPESA_B2C_NOT_CONFIGURED");
          payoutScope = owner.scope;
          payoutClient = (await this.gateways.clients(sc)).daraja;
        } else {
          usePayHeroPayout = !!this.payhero && (await this.payhero.payoutReady().catch(() => false));
        }
      }
    } else {
      usePayHeroPayout = !!this.payhero && (await this.payhero.payoutReady().catch(() => false));
    }
    const ap = await this.repo.approveWithdrawal(txId, adminId);
    if (!ap.approved || ap.amountCents === null) return { approved: false };
    if (ap.provider === "internal") {
      // Marketer rail (0108): fn_approve_withdrawal already credited the marketer wallet and settled
      // 'success' — there is no B2C payout. Surface it as a completed withdrawal (activity feed).
      if (ap.userId) this.events.onWithdrawalSuccess?.({ userId: ap.userId, amountCents: ap.amountCents });
      return { approved: true };
    }
    if (ap.phone === null) return { approved: false };
    await this.stamp(txId, payoutScope);
    if (usePayHeroPayout && this.payhero) {
      // Dispatch the payout from PayHero's service wallet. The result arrives via the PayHero withdraw
      // callback (handlePayHeroWithdrawResult), which re-queries PayHero authoritatively before it
      // settles — the QUEUED response here is NOT trusted to release money, mirroring the B2C model.
      const r = await this.payhero.withdraw({ amountCents: ap.amountCents, msisdn: ap.phone, externalReference: txId });
      return { approved: true, conversationId: r.checkoutRequestId };
    }
    const b2c = await payoutClient.b2cPayment({ amountCents: ap.amountCents, msisdn: ap.phone, remarks: "Withdrawal", resultId: txId });
    return { approved: true, conversationId: b2c.conversationId };
  }

  /**
   * PayHero withdraw (payout) result handler. Like the B2C/Daraja model, the callback body is NEVER
   * trusted to settle: we re-query PayHero server-to-server for the authoritative status, then settle
   * through the SAME idempotent completeWithdrawal RPC (success keeps the debit; a terminal failure
   * reverses it). While PayHero still reports the payout as processing we leave the row untouched so a
   * later callback / the reconcile job resolves it — money is never released on an unverified callback.
   */
  async handlePayHeroWithdrawResult(txId: string, reference: string | null, raw: unknown): Promise<CompleteResult> {
    if (!this.payhero) return { applied: false, status: "processing" } as CompleteResult;
    const status = reference ? await this.payhero.queryStatus(reference) : { resultCode: null, processing: true, receipt: null };
    if (status.processing || status.resultCode === null) return { applied: false, status: "processing" } as CompleteResult;
    const res = await this.repo.completeWithdrawal(txId, status.resultCode, reference, status.receipt, raw);
    if (res.applied && res.status === "success") {
      const tx = await this.repo.getTransaction(txId);
      if (tx) this.events.onWithdrawalSuccess?.({ userId: tx.userId, amountCents: tx.amountCents });
    }
    return res;
  }
  /** Finance admin rejects a pending withdrawal: reverses the hold. */
  rejectWithdrawal(txId: string, adminId: string): Promise<{ reversed: boolean; newBalance: Cents }> {
    return this.repo.rejectWithdrawal(txId, adminId);
  }
  /**
   * Admin manually finalizes a withdrawal as PAID when the provider's B2C result callback never
   * arrived (Mega Pay / Daraja failure). No wallet change (money already debited at create). On a
   * genuine transition to 'success' it fires the same success event as the B2C path, so the client
   * and activity feed reflect the completed payout. Idempotent; refuses a failed/reversed row.
   */
  async markWithdrawalPaid(txId: string, adminId: string, receipt: string | null): Promise<CompleteResult> {
    const res = await this.repo.markWithdrawalPaid(txId, adminId, receipt);
    if (res.applied && res.status === "success") {
      const tx = await this.repo.getTransaction(txId);
      if (tx) this.events.onWithdrawalSuccess?.({ userId: tx.userId, amountCents: tx.amountCents });
    }
    return res;
  }
  /** Daraja B2C result handler (idempotent). Success keeps the debit; failure reverses it. */
  async handleB2cResult(txId: string, resultCode: number, conversationId: string | null, receipt: string | null, raw: unknown): Promise<CompleteResult> {
    const res = await this.repo.completeWithdrawal(txId, resultCode, conversationId, receipt, raw);
    if (res.applied && res.status === "success") {
      const tx = await this.repo.getTransaction(txId);
      if (tx) this.events.onWithdrawalSuccess?.({ userId: tx.userId, amountCents: tx.amountCents });
    }
    return res;
  }

  getBalance(userId: string, siteId?: string): Promise<Cents> { return this.repo.getBalance(userId, siteId); }

  // ── Pay Bill (C2B) deposit ──
  /**
   * Ingest a C2B confirmation Safaricom pushed for our Pay Bill (called by the public confirmation
   * route). Idempotent — Safaricom retries until it gets a 200, so a repeat is a safe no-op. Returns
   * true when the payment was newly stored.
   */
  ingestC2b(p: C2bPayment): Promise<boolean> {
    if (!p.transId || !p.transId.trim()) return Promise.reject(new Error("INVALID_C2B"));
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) return Promise.reject(new Error("INVALID_C2B"));
    return this.repo.ingestC2b({ ...p, transId: p.transId.trim() });
  }
  /**
   * A player submits the M-PESA confirmation code from a Pay Bill payment. We credit the EXACT amount
   * Safaricom recorded for that code (never a client-supplied amount), exactly once. Returns
   * `not_found` when the code hasn't been confirmed to us yet (the client should ask them to retry
   * shortly — Safaricom's confirmation can lag a few seconds).
   */
  async claimPaybillDeposit(userId: string, code: string, siteId?: string): Promise<ClaimResult> {
    if (!code || !code.trim()) throw new Error("INVALID_CODE");
    // PAY-1 (docs/43 §3.6): the manual Pay Bill is the System owner's paybill. A brand on its own
    // accounts must not tell players to pay it — and must not claim payments made to it.
    if ((await this.ownerOf(siteId)).scope !== "global") throw new Error("PAYBILL_NOT_AVAILABLE");
    return this.repo.claimC2bDeposit(userId, code.trim(), siteId);
  }
  /** The current (non-secret) Pay Bill display config for the deposit sheet (disabled for brands on their own accounts). */
  async paybillConfig(siteId?: string): Promise<PaybillConfig> {
    const cfg = await this.repo.getPaybillConfig();
    if (siteId && (await this.ownerOf(siteId)).scope !== "global") return { ...cfg, enabled: false };
    return cfg;
  }
}

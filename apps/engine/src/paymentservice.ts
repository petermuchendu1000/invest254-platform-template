import { normalizeMsisdn, MIN_DEPOSIT_CENTS, MIN_WITHDRAWAL_CENTS, type Cents } from "@invest254/shared";
import type { PaymentRepository, CompleteResult, CreateWithdrawalResult, WithdrawalOutcome } from "./payments.js";
import type { DarajaClient } from "./daraja.js";

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
  events?: PaymentEvents;
  verifyStkCallbacks?: boolean;
}

export class PaymentService {
  private readonly minDeposit: Cents;
  private readonly minWithdrawal: Cents;
  private readonly minWithdrawalProvider?: () => Cents;
  private readonly events: PaymentEvents;
  private readonly verifyStk: boolean;
  constructor(private readonly repo: PaymentRepository, private readonly daraja: DarajaClient, opts: PaymentServiceOptions = {}) {
    this.minDeposit = opts.minDepositCents ?? MIN_DEPOSIT_CENTS;
    this.minWithdrawal = opts.minWithdrawalCents ?? MIN_WITHDRAWAL_CENTS;
    if (opts.minWithdrawalProvider) this.minWithdrawalProvider = opts.minWithdrawalProvider;
    this.events = opts.events ?? {};
    // Secure by default: a client can POST to the public STK callback URL, so a raw
    // resultCode=0 is NOT trusted — we re-check with Safaricom before crediting. Opt out only
    // for environments where the callback source is otherwise authenticated (e.g. IP allowlist).
    this.verifyStk = opts.verifyStkCallbacks ?? true;
  }

  // ── Deposit (STK Push) ──
  async initiateDeposit(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<{ txId: string; checkoutRequestId: string }> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    if (amountCents < this.minDeposit) throw new Error("BELOW_MIN");
    const msisdn = normalizeMsisdn(phoneRaw);
    const txId = await this.repo.createDeposit(userId, amountCents, msisdn, siteId);
    const stk = await this.daraja.stkPush({ amountCents, msisdn, accountRef: "Invest254", desc: "Deposit" });
    await this.repo.attachStk(txId, stk.merchantRequestId, stk.checkoutRequestId);
    return { txId, checkoutRequestId: stk.checkoutRequestId };
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
      const q = await this.daraja.stkPushQuery(checkoutRequestId);
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
    const rows = await this.repo.listUnsettledDeposits(olderThanMs, limit);
    let settled = 0, stillPending = 0, errors = 0;
    for (const d of rows) {
      try {
        const q = await this.daraja.stkPushQuery(d.checkoutRequestId);
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
    const minWithdrawal = this.currentMinWithdrawal();
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    if (amountCents < minWithdrawal) throw new Error("BELOW_MIN");
    // Marketer instant path (game -> mpesa wallet). Phone is resolved from the player's profile.
    const gw = await this.repo.gameWithdraw(userId, amountCents);
    if (gw.isMarketer) {
      // The instant marketer transfer is a completed withdrawal: surface it exactly like a
      // settled B2C payout (activity feed, notifications, analytics hooks).
      this.events.onWithdrawalSuccess?.({ userId, amountCents });
      return { mode: "marketer", txId: gw.txId!, newBalance: gw.newBalance!, mpesaBalanceCents: gw.mpesaBalanceCents! };
    }
    // Normal player: real M-Pesa payout via the pending -> admin approve -> Daraja B2C flow.
    const msisdn = normalizeMsisdn(phoneRaw);
    const res: CreateWithdrawalResult = await this.repo.createWithdrawal(userId, amountCents, msisdn, minWithdrawal, siteId);
    return { mode: "daraja", txId: res.txId, newBalance: res.newBalance };
  }

  /**
   * The minimum withdrawal in force right now. Prefers the live provider (admin-editable
   * `game_config.min_withdrawal`) and falls back to the boot-time constant if the provider is
   * absent or returns a non-positive integer — so a transient bad config can never open the
   * floor below the safe default.
   */
  private currentMinWithdrawal(): Cents {
    const live = this.minWithdrawalProvider?.();
    return Number.isInteger(live) && (live as number) > 0 ? (live as Cents) : this.minWithdrawal;
  }
  /** Finance admin approves: flips to processing and dispatches the B2C payment. */
  async approveWithdrawal(txId: string, adminId: string): Promise<{ approved: boolean; conversationId?: string }> {
    const ap = await this.repo.approveWithdrawal(txId, adminId);
    if (!ap.approved || ap.amountCents === null || ap.phone === null) return { approved: false };
    const b2c = await this.daraja.b2cPayment({ amountCents: ap.amountCents, msisdn: ap.phone, remarks: "Withdrawal", resultId: txId });
    return { approved: true, conversationId: b2c.conversationId };
  }
  /** Finance admin rejects a pending withdrawal: reverses the hold. */
  rejectWithdrawal(txId: string, adminId: string): Promise<{ reversed: boolean; newBalance: Cents }> {
    return this.repo.rejectWithdrawal(txId, adminId);
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
}

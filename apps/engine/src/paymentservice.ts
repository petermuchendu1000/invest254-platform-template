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
  events?: PaymentEvents;
  verifyStkCallbacks?: boolean;
}

export class PaymentService {
  private readonly minDeposit: Cents;
  private readonly minWithdrawal: Cents;
  private readonly minWithdrawalProvider?: () => Cents;
  private readonly minWithdrawalForSite?: (siteId: string | undefined) => Cents | Promise<Cents>;
  private readonly minDepositForGlobal?: () => Cents | Promise<Cents>;
  private readonly maxDepositForGlobal?: () => Cents | null | Promise<Cents | null>;
  private readonly minWithdrawalForGlobal?: () => Cents | Promise<Cents>;
  private readonly withdrawalsEnabledForSite?: (siteId: string | undefined) => boolean | Promise<boolean>;
  private readonly accountRefForSite?: (siteId: string | undefined) => string | Promise<string>;
  private readonly defaultAccountRef: string;
  private readonly darajaForSite?: (siteId: string | undefined) => DarajaClient | undefined | Promise<DarajaClient | undefined>;
  private readonly events: PaymentEvents;
  private readonly verifyStk: boolean;
  constructor(private readonly repo: PaymentRepository, private readonly daraja: DarajaClient, opts: PaymentServiceOptions = {}) {
    this.minDeposit = opts.minDepositCents ?? MIN_DEPOSIT_CENTS;
    this.minWithdrawal = opts.minWithdrawalCents ?? MIN_WITHDRAWAL_CENTS;
    if (opts.minWithdrawalProvider) this.minWithdrawalProvider = opts.minWithdrawalProvider;
    if (opts.minWithdrawalForSite) this.minWithdrawalForSite = opts.minWithdrawalForSite;
    if (opts.minDepositForGlobal) this.minDepositForGlobal = opts.minDepositForGlobal;
    if (opts.maxDepositForGlobal) this.maxDepositForGlobal = opts.maxDepositForGlobal;
    if (opts.minWithdrawalForGlobal) this.minWithdrawalForGlobal = opts.minWithdrawalForGlobal;
    if (opts.withdrawalsEnabledForSite) this.withdrawalsEnabledForSite = opts.withdrawalsEnabledForSite;
    if (opts.accountRefForSite) this.accountRefForSite = opts.accountRefForSite;
    this.defaultAccountRef = opts.defaultAccountRef ?? "Invest254";
    if (opts.darajaForSite) this.darajaForSite = opts.darajaForSite;
    this.events = opts.events ?? {};
    // Secure by default: a client can POST to the public STK callback URL, so a raw
    // resultCode=0 is NOT trusted — we re-check with Safaricom before crediting. Opt out only
    // for environments where the callback source is otherwise authenticated (e.g. IP allowlist).
    this.verifyStk = opts.verifyStkCallbacks ?? true;
  }

  // ── Deposit (STK Push) ──
  async initiateDeposit(userId: string, amountCents: number, phoneRaw: string, siteId?: string): Promise<{ txId: string; checkoutRequestId: string }> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const minDep = await this.currentMinDeposit();
    if (amountCents < minDep) throw new Error("BELOW_MIN");
    const maxDep = await this.currentMaxDeposit();
    if (maxDep !== null && amountCents > maxDep) throw new Error("ABOVE_MAX");
    const msisdn = normalizeMsisdn(phoneRaw);
    const txId = await this.repo.createDeposit(userId, amountCents, msisdn, siteId);
    // Site-aware AccountReference: show the depositing brand's account, not a hardcoded one. And
    // route through the brand's OWN Daraja client when it has registered its own paybill (else shared).
    const accountRef = await this.resolveAccountRef(siteId);
    const client = await this.resolveDaraja(siteId);
    const stk = await client.stkPush({ amountCents, msisdn, accountRef, desc: "Deposit" });
    await this.repo.attachStk(txId, stk.merchantRequestId, stk.checkoutRequestId);
    return { txId, checkoutRequestId: stk.checkoutRequestId };
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
   * The minimum withdrawal in force for THIS request. Resolution order (multi-tenant safe):
   *   1. `minWithdrawalForSite(siteId)` — the withdrawing brand's own `site_game_config.min_withdrawal`,
   *      i.e. exactly the floor the player's client validated against (kills the client/server BELOW_MIN
   *      divergence for brands whose minimum differs from the platform default);
   *   2. `minWithdrawalProvider()` — the process-wide live default (admin-editable `game_config.min_withdrawal`);
   *   3. the boot-time constant.
   * Any source that is absent, throws, or yields a non-positive / non-integer value is skipped, so a
   * transient bad config can never open the floor below the safe default.
   */
  private async currentMinWithdrawal(siteId?: string): Promise<Cents> {
    // 0. Platform GLOBAL enforce wins over everything (decision: global overrides all clients).
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
   * The minimum deposit in force for THIS request. The platform GLOBAL enforced value (0099) wins over
   * the static default; a non-positive/non-integer/throwing global result defers to the static default,
   * so a config glitch can never open the floor below the safe minimum.
   */
  private async currentMinDeposit(): Promise<Cents> {
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

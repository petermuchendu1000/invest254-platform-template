import type {
  AffiliateView, AffiliateAccrualResult, AffiliateRepository,
  AffiliateSummary, ReferralRecord, CommissionRecord,
  PayoutRequestResult, PayoutCompleteResult,
} from "./identity.js";
import type { Page, PageQuery } from "./paging.js";
import type { DarajaClient } from "./daraja.js";

/**
 * AffiliateService (Issue I1+) — the marketer/affiliate domain seam the HTTP API binds to.
 *  - `enroll`: idempotent marketer enrollment (stable referral code, player->marketer).
 *  - `accrueDaily`: daily 20%-of-GGR revenue-share accrual for one trading day.
 * Attribution itself happens atomically at registration (AuthService.register + the register
 * RPC). All money/state invariants live in the migration RPCs behind AffiliateRepository.
 */
export interface AffiliateEnrollment extends AffiliateView {
  /** Relative share path for the marketer's link; the frontend prefixes its public origin. */
  referralPath: string;
}

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

export class AffiliateService {
  /**
   * @param repo   durable affiliate boundary (RPCs / in-memory mirror).
   * @param daraja M-Pesa provider used to dispatch the B2C payout on approval. Optional so the
   *               read-only/enrollment surface works without payments wired; `approvePayout`
   *               throws B2C_UNAVAILABLE if it's missing.
   */
  constructor(private readonly repo: AffiliateRepository, private readonly daraja?: DarajaClient) {}

  /** Idempotently enroll the caller as a marketer and return their referral terms. Throws USER_NOT_FOUND. */
  async enroll(userId: string): Promise<AffiliateEnrollment> {
    const a = await this.repo.enrollAffiliate(userId);
    return { ...a, referralPath: `/r/${a.referralCode}` };
  }

  /** Record a referral-link click (funnel stage 0). Tolerant: unknown/inactive code -> false. */
  recordClick(code: string, siteId?: string): Promise<boolean> {
    return this.repo.recordClick(code, siteId);
  }

  /** Accrue commission for one trading day (`YYYY-MM-DD`). `siteId` scopes to one brand (omit = all). Idempotent. Throws INVALID_PERIOD. */
  async accrueDaily(period: string, siteId?: string): Promise<AffiliateAccrualResult> {
    if (typeof period !== "string" || !PERIOD_RE.test(period)) throw new Error("INVALID_PERIOD");
    return this.repo.accrueCommissions(period, siteId);
  }

  /** Marketer dashboard summary for the caller. Throws NOT_AFFILIATE if not enrolled. */
  async summary(userId: string): Promise<AffiliateSummary> {
    const s = await this.repo.affiliateSummary(userId);
    if (!s) throw new Error("NOT_AFFILIATE");
    return s;
  }

  /** The caller's referred players (newest first, cursor-paginated). */
  listReferrals(userId: string, q: PageQuery): Promise<Page<ReferralRecord>> {
    return this.repo.listReferrals(userId, q);
  }

  /** The caller's daily commission history (newest first, cursor-paginated). */
  listCommissions(userId: string, q: PageQuery): Promise<Page<CommissionRecord>> {
    return this.repo.listCommissions(userId, q);
  }

  // ── Payouts (I4): request → approve (B2C dispatch) / reject → B2C result ──

  /** Marketer requests a payout of their available commission. Throws NO_AVAILABLE_COMMISSION / PAYOUT_PENDING. */
  requestPayout(userId: string): Promise<PayoutRequestResult> {
    return this.repo.requestPayout(userId);
  }

  /**
   * Finance admin approves a payout: flips requested→approved and dispatches the M-Pesa B2C
   * payment to the affiliate's phone. Idempotent at the repo (a non-'requested' payout returns
   * approved:false and no B2C call). Throws B2C_UNAVAILABLE if no provider is wired.
   */
  async approvePayout(payoutId: string, adminId: string): Promise<{ approved: boolean; conversationId?: string }> {
    const ap = await this.repo.approvePayout(payoutId, adminId);
    if (!ap.approved || ap.amountCents === null || ap.phone === null) return { approved: false };
    if (!this.daraja) throw new Error("B2C_UNAVAILABLE");
    const b2c = await this.daraja.b2cPayment({ amountCents: ap.amountCents, msisdn: ap.phone, remarks: "Affiliate payout" });
    return { approved: true, conversationId: b2c.conversationId };
  }

  /** Daraja B2C result handler for a payout (idempotent). Success ⇒ paid; failure ⇒ rejected + reservation released. */
  completePayout(payoutId: string, resultCode: number, conversationId: string | null, receipt: string | null, resultDesc: string | null, raw: unknown): Promise<PayoutCompleteResult> {
    return this.repo.completePayout(payoutId, resultCode, conversationId, receipt, resultDesc, raw);
  }

  /** Finance admin rejects a pre-dispatch payout request (releases the reservation). Idempotent. */
  rejectPayout(payoutId: string, adminId: string, reason?: string): Promise<boolean> {
    return this.repo.rejectPayout(payoutId, adminId, reason);
  }

  /** Resolve the brand a payout belongs to (null = unknown) — admin write-path scope guard (Task H). */
  siteOfPayout(payoutId: string): Promise<string | null> {
    return this.repo.siteOfPayout(payoutId);
  }
}

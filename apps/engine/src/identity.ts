import { randomUUID, randomInt } from "node:crypto";
import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from "@invest254/shared";
import type { Querier } from "./wallet.js";
import { type Page, type PageQuery, clampLimit, decodeKeyset, pageFrom } from "./paging.js";

/**
 * IdentityRepository: durable boundary for self-managed phone + password identity and the
 * basic-KYC profile. `register` maps to the 0015 `fn_register_user` RPC; `findByPhone` loads
 * the credential for login; `getProfile` reads the profile state. The in-memory implementation
 * mirrors the same contracts for tests; both are driven the same way by AuthService. Phones
 * passed in are already normalized MSISDN. (Age verification / basic KYC removed in 0018.)
 */

/** A newly registered identity. */
export interface RegisteredUser { userId: string; role: string; }

/** Stored credential + account state for a login attempt. */
export interface CredentialRecord { userId: string; role: string; status: string; passwordHash: string; siteId: string | null; }

/** Profile state for the `/me` view. */
export interface ProfileRow {
  userId: string; username: string; phone: string; role: string; status: string;
}

/** An affiliate (marketer) enrollment: the stable referral code + commission terms + current role. */
export interface AffiliateView {
  userId: string; referralCode: string; commissionRate: number; status: string; role: string;
}

/** Result of a daily commission-accrual run. */
export interface AffiliateAccrualResult { buckets: number; totalCommissionCents: number; }

/** Marketer dashboard summary (all monetary fields in cents). */
export interface AffiliateSummary {
  referralCode: string; referralPath: string; commissionRate: number; status: string;
  totalReferrals: number; activePlayers7d: number; activePlayers30d: number;
  turnoverCents: number; ggrCents: number;
  commissionAccruedCents: number; commissionPaidCents: number; availableCents: number;
  // Realtime "today" (EAT) figures for the live marketer performance panel.
  referralsToday: number; activePlayersToday: number; commissionTodayCents: number;
  // Funnel (docs/19): link clicks and first-time-depositors, completing Clicks → Registrations →
  // FTDs → Active → Commission. `ftdCount` = referred players with >=1 successful deposit.
  clicks: number; clicksToday: number; ftdCount: number;
}
/** One referred player as shown in the marketer's referrals list. */
export interface ReferralRecord { username: string; joinedAtMs: number; lifetimeGgrCents: number; }
/** One daily commission bucket as shown in the marketer's commission history. */
export interface CommissionRecord { period: string; ggrCents: number; commissionCents: number; status: string; createdAtMs: number; }

/** Result of a marketer payout request: the reserved amount + its payout id. */
export interface PayoutRequestResult { payoutId: string; amountCents: number; }
/** Result of an admin payout approval: the amount + the affiliate's phone for B2C dispatch. */
export interface PayoutApproveResult { approved: boolean; amountCents: number | null; phone: string | null; }
/** Result of applying an M-Pesa B2C payout result (idempotent). */
export interface PayoutCompleteResult { applied: boolean; status: string; }

/** A user as the admin back office sees it (J2). */
export interface AdminUserSnapshot {
  userId: string; username: string; phone: string; role: string; status: string;
  referredBy: string | null; createdAtMs: number; siteId: string | null;
}
/** An affiliate's commission terms for admin reads/mutations (J2). */
export interface AdminAffiliateSnapshot { userId: string; commissionRate: number; status: string; }
/** A settled play (turnover/GGR source) for admin aggregation (J2). */
export interface AdminPlaySnapshot { userId: string; stakeCents: number; payoutCents: number; }
/** A settled play with its trade-date period, for per-day/per-user reports (J4). */
export interface AdminReportPlay { userId: string; period: string; stakeCents: number; payoutCents: number; }
/** A commission bucket for admin accrued/paid aggregation (J2). */
export interface AdminCommissionSnapshot { commissionCents: number; status: string; }
/** A payout request as the admin approve/reject queue sees it (J6). */
export interface AdminPayoutSnapshot { payoutId: string; affiliateId: string; username: string; phone: string; amountCents: number; status: string; approvedBy: string | null; createdAtMs: number; }

/** Stored MFA state for an account. Secret + recovery hashes never leave the service layer. */
export interface MfaRecord { userId: string; secret: string; enabled: boolean; recoveryCodeHashes: string[]; }

/** One stored security answer: a catalog question key + the scrypt hash of the normalized answer (0097). */
export interface SecurityAnswerHash { questionKey: string; answerHash: string; }

export interface IdentityRepository {
  /**
   * Atomically create profile + wallet + credentials. An optional referral code (already
   * format-validated + upper-cased by the caller) attributes the new account to an active
   * affiliate (first-touch, permanent); an unknown/suspended code is ignored so a stale link
   * never blocks signup. Throws PHONE_TAKEN / USERNAME_TAKEN / REGISTRATION_CONFLICT.
   */
  register(phone: string, username: string, passwordHash: string, referralCode?: string, siteId?: string): Promise<RegisteredUser>;
  /**
   * Grant the one-time sign-up welcome bonus (migration 0094 fn_grant_welcome_bonus). Idempotent,
   * brand + config aware, and skips demo/marketer accounts. Returns the cents credited to
   * bonus_balance (0 = nothing granted). A business no-op returns 0 rather than throwing.
   */
  grantWelcomeBonus(userId: string): Promise<number>;
  /** Load credential + account state by (normalized) phone within a brand, or null. `siteId` scopes it (multi-tenant). */
  findByPhone(phone: string, siteId?: string): Promise<CredentialRecord | null>;
  /**
   * ALL accounts holding this (normalized) phone across every brand. A phone is unique only WITHIN
   * a brand, so a brand-agnostic caller (e.g. the marketer app, which is a single generic build and
   * cannot know the marketer's brand) uses this to authenticate by matching the password/PIN — the
   * credential itself identifies which brand's account is signing in. Newest last is irrelevant;
   * the caller verifies the secret against each.
   */
  findAllByPhone(phone: string): Promise<CredentialRecord[]>;
  /** Load the profile by user id, or null if not found. */
  getProfile(userId: string): Promise<ProfileRow | null>;
  /** Replace an account's password hash. False when there is no such credential row. */
  setPasswordHash(userId: string, passwordHash: string): Promise<boolean>;
  /** Load MFA state for an account, or null when enrolment was never begun. */
  getMfa(userId: string): Promise<MfaRecord | null>;
  /** Store (or replace) a pending TOTP secret + recovery-code hashes; leaves MFA disabled. */
  putMfaSecret(userId: string, secret: string, recoveryCodeHashes: string[]): Promise<void>;
  /** Mark MFA confirmed/enabled once a live code has proven device possession. */
  enableMfa(userId: string): Promise<void>;
  /** Remove a used recovery-code hash (single-use). False when it was already spent. */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  /** Turn MFA off and forget the secret + recovery codes. */
  disableMfa(userId: string): Promise<void>;
  /**
   * Replace ALL of a user's security answers with exactly the given set (0097). Hashes are computed
   * in the app layer (AuthService, scrypt); this is a pure durable write. Keys not in `answers` are
   * removed, so re-setting always leaves precisely the submitted set. Atomic (single statement).
   */
  setSecurityAnswers(userId: string, answers: SecurityAnswerHash[]): Promise<void>;
  /** Load a user's stored security answers (question key + hash); empty array when none set. */
  getSecurityAnswers(userId: string): Promise<SecurityAnswerHash[]>;
  /** Count how many security answers a user has stored (fast gate: >= 3 means "set"). */
  countSecurityAnswers(userId: string): Promise<number>;
  /**
   * Force-logout epoch in epoch-ms for a user, or null if never set (0097). The API verifier
   * compares a privileged token's `iat` against this to invalidate pre-logout sessions.
   */
  getSessionsValidAfterMs(userId: string): Promise<number | null>;
}

/**
 * AffiliateRepository: durable boundary for the marketer/affiliate domain — enrollment and
 * daily revenue-share accrual (dashboard reads + payouts extend this interface). Maps to the
 * migration 0017/0018 RPCs; the in-memory impl mirrors the same contracts for tests.
 */
export interface AffiliateRepository {
  /** Idempotently enroll the user as an affiliate (marketer) with a stable referral code. Throws USER_NOT_FOUND. */
  enrollAffiliate(userId: string): Promise<AffiliateView>;
  /** Accrue commission for one trading day (`YYYY-MM-DD`). `siteId` scopes it to one brand (null = all brands). Idempotent. */
  accrueCommissions(period: string, siteId?: string): Promise<AffiliateAccrualResult>;
  /** Marketer dashboard summary, or null if the user is not an enrolled affiliate. */
  affiliateSummary(userId: string): Promise<AffiliateSummary | null>;
  /** Record a referral-link click (tolerant: unknown/inactive code -> false, never throws). */
  recordClick(code: string, siteId?: string): Promise<boolean>;
  /** The affiliate's referred players (newest first, cursor-paginated). */
  listReferrals(userId: string, q: PageQuery): Promise<Page<ReferralRecord>>;
  /** The affiliate's daily commission history (newest first, cursor-paginated). */
  listCommissions(userId: string, q: PageQuery): Promise<Page<CommissionRecord>>;
  /**
   * Marketer requests a payout of all currently-available commission. Snapshots (reserves) the
   * covered accrued buckets onto the new payout. Throws NO_AVAILABLE_COMMISSION / PAYOUT_PENDING.
   */
  requestPayout(userId: string): Promise<PayoutRequestResult>;
  /** Admin approves a 'requested' payout; returns amount + affiliate phone for B2C dispatch. Idempotent. */
  approvePayout(payoutId: string, adminId: string): Promise<PayoutApproveResult>;
  /**
   * Apply the M-Pesa B2C result for a payout (idempotent): success => 'paid' (reserved buckets
   * move accrued->paid); failure => 'rejected' (reservation released, buckets stay accrued).
   */
  completePayout(payoutId: string, resultCode: number, conversationId: string | null, receipt: string | null, resultDesc: string | null, raw: unknown): Promise<PayoutCompleteResult>;
  /** Admin rejects a pre-dispatch ('requested') payout, releasing its reservation. Optional reason
   *  is stored for audit (0098). Idempotent. */
  rejectPayout(payoutId: string, adminId: string, reason?: string): Promise<boolean>;
  /** Resolve the brand a payout belongs to (admin write-path scope guard, docs/22 Task H). A legacy
   *  null site normalizes to the default brand; an unknown/untracked payout resolves to null — a
   *  null never blocks, so the site-aware RPC remains the ultimate guard (the in-memory mirror does
   *  not track a payout's site and always returns null). */
  siteOfPayout(payoutId: string): Promise<string | null>;
}

/** Re-raise the bare error code the RPCs raise instead of the wrapped pg message. */
function mapPgError(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? String(e);
  const m = msg.match(/(INVALID_PHONE|INVALID_USERNAME|INVALID_HASH|PHONE_TAKEN|USERNAME_TAKEN|REGISTRATION_CONFLICT|USER_NOT_FOUND|NO_AVAILABLE_COMMISSION|PAYOUT_PENDING|PAYOUT_NOT_FOUND)/);
  throw new Error(m ? m[1] : msg);
}

/** Normalize a pg date/timestamp value to an ISO `YYYY-MM-DD` string, or null. */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Normalize a pg timestamp value to epoch milliseconds. */
function toMs(v: unknown): number {
  return v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
}

/** Postgres-backed identity, calling the 0015/0016 RPCs + profile reads. */
export class PgIdentityRepository implements IdentityRepository, AffiliateRepository {
  constructor(private readonly q: Querier) {}
  async register(phone: string, username: string, passwordHash: string, referralCode?: string, siteId?: string): Promise<RegisteredUser> {
    try {
      // When a brand is given, pass it as the 5th arg; otherwise use the 4-arg form so the RPC's
      // p_site_id DEFAULT (the default site) applies rather than an explicit NULL (NOT NULL column).
      const r = siteId
        ? await this.q.query("select user_id, role from fn_register_user($1,$2,$3,$4,$5)", [phone, username, passwordHash, referralCode ?? null, siteId])
        : await this.q.query("select user_id, role from fn_register_user($1,$2,$3,$4)", [phone, username, passwordHash, referralCode ?? null]);
      const x = r.rows[0];
      return { userId: String(x.user_id), role: String(x.role) };
    } catch (e) { mapPgError(e); }
  }
  async grantWelcomeBonus(userId: string): Promise<number> {
    // Idempotent + config/brand aware; returns cents credited (0 = none). service-role RPC (0094).
    const r = await this.q.query("select public.fn_grant_welcome_bonus($1) as cents", [userId]);
    return Number(r.rows[0]?.cents ?? 0);
  }
  async enrollAffiliate(userId: string): Promise<AffiliateView> {
    try {
      const r = await this.q.query(
        "select referral_code, commission_rate, status, role from fn_affiliate_enroll($1)", [userId]);
      const x = r.rows[0];
      return {
        userId, referralCode: String(x.referral_code),
        commissionRate: Number(x.commission_rate), status: String(x.status), role: String(x.role),
      };
    } catch (e) { mapPgError(e); }
  }
  async accrueCommissions(period: string, siteId?: string): Promise<AffiliateAccrualResult> {
    const r = await this.q.query(
      "select buckets, total_commission from fn_accrue_affiliate_commissions($1,$2)", [period, siteId ?? null]);
    const x = r.rows[0];
    return { buckets: Number(x.buckets), totalCommissionCents: Number(x.total_commission) };
  }
  async affiliateSummary(userId: string): Promise<AffiliateSummary | null> {
    const r = await this.q.query(
      // Referral/earnings KPIs are sourced from the CURRENT commission model (deposit_commissions,
      // migration 0078/0081 + profiles.referred_by first-touch), UNIONed with the legacy `referrals`
      // table for back-compat. The old query read only `referrals`/`affiliate_commissions`, which the
      // live system no longer populates (site-owner + deposit-commission marketers have 0 there), so
      // every non-money KPI showed 0. `ef` = the distinct set of players this marketer earns from.
      // Money mirrors deposit_commissions; /me/referral remains authoritative for withdrawable balance.
      `with ef as (
         select referred_user as u, created_at as ts from deposit_commissions where beneficiary_user = $1
         union all select id as u, created_at as ts from profiles where referred_by = $1
         union all select referred_user as u, created_at as ts from referrals where affiliate_id = $1
       ), efg as (select u, min(ts) as first_ts from ef group by u)
       select a.referral_code, a.commission_rate, a.status,
         (select count(*) from efg) as total_referrals,
         (select count(distinct e.u) from efg e join positions p on p.user_id = e.u
           where p.opened_at >= now() - interval '7 days') as active7,
         (select count(distinct e.u) from efg e join positions p on p.user_id = e.u
           where p.opened_at >= now() - interval '30 days') as active30,
         (select coalesce(sum(p.stake),0) from efg e join positions p on p.user_id = e.u
           where p.status = 'settled') as turnover,
         coalesce((select sum(c.ggr) from affiliate_commissions c where c.affiliate_id = $1),0) as ggr,
         (select coalesce(sum(commission_amount),0) from deposit_commissions where beneficiary_user = $1 and status = 'accrued') as accrued,
         (select coalesce(sum(commission_amount),0) from deposit_commissions where beneficiary_user = $1 and status = 'paid') as paid,
         (select coalesce(sum(commission_amount),0) from deposit_commissions where beneficiary_user = $1 and status = 'accrued') as available,
         (select count(*) from efg where (first_ts at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date) as referrals_today,
         (select count(distinct e.u) from efg e join positions p on p.user_id = e.u
           where (p.opened_at at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date) as active_today,
         (select coalesce(sum(commission_amount),0) from deposit_commissions where beneficiary_user = $1
           and (created_at at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date) as commission_today,
         (select count(*) from affiliate_clicks k where k.affiliate_id = $1) as clicks,
         (select count(*) from affiliate_clicks k where k.affiliate_id = $1
           and (k.created_at at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date) as clicks_today,
         (select count(distinct referred_user) from deposit_commissions where beneficiary_user = $1) as ftd_count
       from affiliates a where a.user_id = $1`, [userId]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    // commissionAccruedCents counts all accrued buckets (reserved or not); availableCents counts
    // only unreserved ones (an in-flight payout snapshots its buckets via payout_id, excluding them).
    return {
      referralCode: String(x.referral_code), referralPath: `/r/${x.referral_code}`,
      commissionRate: Number(x.commission_rate), status: String(x.status),
      totalReferrals: Number(x.total_referrals), activePlayers7d: Number(x.active7), activePlayers30d: Number(x.active30),
      turnoverCents: Number(x.turnover), ggrCents: Number(x.ggr),
      commissionAccruedCents: Number(x.accrued), commissionPaidCents: Number(x.paid),
      availableCents: Number(x.available),
      referralsToday: Number(x.referrals_today ?? 0), activePlayersToday: Number(x.active_today ?? 0),
      commissionTodayCents: Number(x.commission_today ?? 0),
      clicks: Number(x.clicks ?? 0), clicksToday: Number(x.clicks_today ?? 0), ftdCount: Number(x.ftd_count ?? 0),
    };
  }
  async recordClick(code: string, siteId?: string): Promise<boolean> {
    const r = await this.q.query("select fn_affiliate_record_click($1,$2) as ok", [code, siteId ?? null]);
    return Boolean(r.rows[0]?.ok);
  }
  async requestPayout(userId: string): Promise<PayoutRequestResult> {
    try {
      const r = await this.q.query("select payout_id, amount from fn_affiliate_request_payout($1)", [userId]);
      const x = r.rows[0];
      return { payoutId: String(x.payout_id), amountCents: Number(x.amount) };
    } catch (e) { mapPgError(e); }
  }
  async approvePayout(payoutId: string, adminId: string): Promise<PayoutApproveResult> {
    try {
      const r = await this.q.query("select approved, amount, phone from fn_affiliate_approve_payout($1,$2)", [payoutId, adminId]);
      const x = r.rows[0];
      return { approved: Boolean(x.approved), amountCents: x.amount == null ? null : Number(x.amount), phone: x.phone == null ? null : String(x.phone) };
    } catch (e) { mapPgError(e); }
  }
  async completePayout(payoutId: string, resultCode: number, conversationId: string | null, receipt: string | null, resultDesc: string | null, raw: unknown): Promise<PayoutCompleteResult> {
    try {
      const r = await this.q.query(
        "select applied, status from fn_affiliate_complete_payout($1,$2,$3,$4,$5,$6)",
        [payoutId, resultCode, conversationId, receipt, resultDesc, JSON.stringify(raw ?? {})]);
      const x = r.rows[0];
      return { applied: Boolean(x.applied), status: String(x.status) };
    } catch (e) { mapPgError(e); }
  }
  async rejectPayout(payoutId: string, adminId: string, reason?: string): Promise<boolean> {
    try {
      const r = await this.q.query("select fn_affiliate_reject_payout($1,$2,$3) as ok", [payoutId, adminId, reason ?? null]);
      return Boolean(r.rows[0]?.ok);
    } catch (e) { mapPgError(e); }
  }
  async siteOfPayout(payoutId: string): Promise<string | null> {
    const r = await this.q.query("select site_id from affiliate_payouts where id = $1", [payoutId]);
    return r.rows.length ? String(r.rows[0].site_id ?? "00000000-0000-0000-0000-000000000001") : null;
  }
  async listReferrals(userId: string, q: PageQuery): Promise<Page<ReferralRecord>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select pr.username, r.created_at, r.id,
         coalesce((select sum(c.ggr) from affiliate_commissions c
                    where c.affiliate_id = r.affiliate_id and c.referred_user = r.referred_user),0) as lifetime_ggr
         from referrals r join profiles pr on pr.id = r.referred_user
        where r.affiliate_id = $1
          and ($2::timestamptz is null or (r.created_at, r.id) < ($2::timestamptz, $3::bigint))
        order by r.created_at desc, r.id desc
        limit $4`,
      [userId, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1]);
    const rows = r.rows.map((x) => ({
      username: String(x.username), joinedAtMs: toMs(x.created_at), lifetimeGgrCents: Number(x.lifetime_ggr),
      _id: String(x.id),
    }));
    const page = pageFrom(rows, limit, (t) => `${t.joinedAtMs}:${t._id}`);
    return { items: page.items.map(({ _id, ...rest }) => rest), nextCursor: page.nextCursor };
  }
  async listCommissions(userId: string, q: PageQuery): Promise<Page<CommissionRecord>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select c.period, c.ggr, c.commission, c.status, c.created_at, c.id
         from affiliate_commissions c
        where c.affiliate_id = $1
          and ($2::timestamptz is null or (c.created_at, c.id) < ($2::timestamptz, $3::bigint))
        order by c.created_at desc, c.id desc
        limit $4`,
      [userId, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1]);
    const rows = r.rows.map((x) => ({
      period: toIsoDate(x.period) ?? String(x.period), ggrCents: Number(x.ggr), commissionCents: Number(x.commission),
      status: String(x.status), createdAtMs: toMs(x.created_at), _id: String(x.id),
    }));
    const page = pageFrom(rows, limit, (t) => `${t.createdAtMs}:${t._id}`);
    return { items: page.items.map(({ _id, ...rest }) => rest), nextCursor: page.nextCursor };
  }
  async findByPhone(phone: string, siteId?: string): Promise<CredentialRecord | null> {
    const r = await this.q.query(
      `select p.id, p.role, p.status, p.site_id, c.password_hash
         from profiles p join user_credentials c on c.user_id = p.id
        where p.phone = $1 and ($2::uuid is null or p.site_id = $2)`, [phone, siteId ?? null]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return { userId: String(x.id), role: String(x.role), status: String(x.status), siteId: x.site_id == null ? null : String(x.site_id), passwordHash: String(x.password_hash) };
  }
  async findAllByPhone(phone: string): Promise<CredentialRecord[]> {
    // Every brand's account on this phone. Ordered by created_at so the tie-break (should two
    // brands ever share BOTH phone AND password) is deterministic — oldest first.
    const r = await this.q.query(
      `select p.id, p.role, p.status, p.site_id, c.password_hash
         from profiles p join user_credentials c on c.user_id = p.id
        where p.phone = $1
        order by p.created_at asc, p.id asc`, [phone]);
    return r.rows.map((x: Record<string, unknown>) => ({
      userId: String(x.id), role: String(x.role), status: String(x.status),
      siteId: x.site_id == null ? null : String(x.site_id), passwordHash: String(x.password_hash),
    }));
  }
  async getMfa(userId: string): Promise<MfaRecord | null> {
    const r = await this.q.query("select user_id, secret, enabled, recovery_codes from user_mfa where user_id = $1", [userId]);    if (!r.rows.length) return null;
    const x = r.rows[0];
    return {
      userId: String(x.user_id), secret: String(x.secret), enabled: Boolean(x.enabled),
      recoveryCodeHashes: (x.recovery_codes ?? []) as string[],
    };
  }
  async putMfaSecret(userId: string, secret: string, recoveryCodeHashes: string[]): Promise<void> {
    await this.q.query(
      `insert into user_mfa (user_id, secret, enabled, confirmed_at, recovery_codes)
         values ($1, $2, false, null, $3)
       on conflict (user_id) do update
         set secret = excluded.secret, enabled = false, confirmed_at = null,
             recovery_codes = excluded.recovery_codes`,
      [userId, secret, recoveryCodeHashes]);
  }
  async enableMfa(userId: string): Promise<void> {
    await this.q.query("update user_mfa set enabled = true, confirmed_at = now() where user_id = $1", [userId]);
  }
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const r = await this.q.query(
      `update user_mfa set recovery_codes = array_remove(recovery_codes, $2)
        where user_id = $1 and $2 = any(recovery_codes) returning user_id`,
      [userId, codeHash]);
    return r.rows.length > 0;
  }
  async disableMfa(userId: string): Promise<void> {
    await this.q.query("delete from user_mfa where user_id = $1", [userId]);
  }
  async setPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    const r = await this.q.query(
      "update user_credentials set password_hash = $2 where user_id = $1 returning user_id",
      [userId, passwordHash]);
    return r.rows.length > 0;
  }
  async getProfile(userId: string): Promise<ProfileRow | null> {
    const r = await this.q.query(
      "select id, username, phone, role, status from profiles where id = $1", [userId]);
    if (!r.rows.length) return null;
    return this.rowToProfile(r.rows[0]);
  }
  private rowToProfile(x: Record<string, unknown>): ProfileRow {
    return {
      userId: String(x.id), username: String(x.username), phone: String(x.phone), role: String(x.role), status: String(x.status),
    };
  }
  async setSecurityAnswers(userId: string, answers: SecurityAnswerHash[]): Promise<void> {
    // Single atomic statement: upsert the submitted (key, hash) pairs and delete any stored key not
    // in the new set, so the persisted set is EXACTLY `answers`. unnest() zips the two arrays.
    const keys = answers.map((a) => a.questionKey);
    const hashes = answers.map((a) => a.answerHash);
    await this.q.query(
      `with input as (
         select question_key, answer_hash
           from unnest($2::text[], $3::text[]) as t(question_key, answer_hash)
       ), del as (
         delete from user_security_answers
          where user_id = $1 and question_key not in (select question_key from input)
       )
       insert into user_security_answers (user_id, question_key, answer_hash)
       select $1, question_key, answer_hash from input
       on conflict (user_id, question_key)
         do update set answer_hash = excluded.answer_hash, updated_at = now()`,
      [userId, keys, hashes]);
  }
  async getSecurityAnswers(userId: string): Promise<SecurityAnswerHash[]> {
    const r = await this.q.query(
      "select question_key, answer_hash from user_security_answers where user_id = $1 order by question_key", [userId]);
    return r.rows.map((x: Record<string, unknown>) => ({ questionKey: String(x.question_key), answerHash: String(x.answer_hash) }));
  }
  async countSecurityAnswers(userId: string): Promise<number> {
    const r = await this.q.query("select count(*)::int as n from user_security_answers where user_id = $1", [userId]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async getSessionsValidAfterMs(userId: string): Promise<number | null> {
    const r = await this.q.query("select sessions_valid_after from profiles where id = $1", [userId]);
    if (!r.rows.length) return null;
    const v = r.rows[0].sessions_valid_after;
    return v == null ? null : toMs(v);
  }
}

interface MemUser {
  userId: string; phone: string; username: string; role: string; status: string;
  passwordHash: string; referredBy: string | null; createdAtMs: number; siteId: string | null;
}

/** Per-site identity key so the same phone/username can exist on different brands. */
const idKey = (v: string, siteId?: string | null): string => `${siteId ?? ""}:${v}`;

interface MemAffiliate { userId: string; referralCode: string; commissionRate: number; status: string; }
interface MemPlay { referredUser: string; period: string; stakeCents: number; payoutCents: number; openedAtMs: number; }
interface MemCommission { id: number; affiliateId: string; referredUser: string; period: string; ggr: number; commission: number; status: string; createdAtMs: number; payoutId: string | null; }
interface MemReferral { id: number; affiliateId: string; referredUser: string; createdAtMs: number; }
interface MemPayout { id: string; affiliateId: string; amount: number; status: string; approvedBy: string | null; conversationId: string | null; receipt: string | null; resultCode: number | null; createdAtMs: number; rejectReason?: string | null; }

/** In-memory identity store mirroring the RPC contracts (tests + dev). */
export class InMemoryIdentityRepository implements IdentityRepository, AffiliateRepository {
  private readonly byPhone = new Map<string, MemUser>();
  private readonly byId = new Map<string, MemUser>();
  private readonly usernames = new Set<string>();
  private readonly affiliates = new Map<string, MemAffiliate>();      // userId -> affiliate
  private readonly byReferralCode = new Map<string, string>();         // code -> userId
  private readonly referrals: MemReferral[] = [];
  private readonly plays: MemPlay[] = [];
  private readonly commissions: MemCommission[] = [];
  private readonly payouts = new Map<string, MemPayout>();              // payoutId -> payout
  private readonly mfa = new Map<string, { secret: string; enabled: boolean; recoveryCodeHashes: string[] }>();
  // 0097: per-user security answers (question key -> scrypt hash) + force-logout epoch (ms).
  private readonly securityAnswers = new Map<string, Map<string, string>>();
  private readonly sessionsValidAfter = new Map<string, number>();
  private seq = 0;
  /** Test knob: cents the in-memory welcome-bonus grant credits (default 0 = inert in tests). */
  welcomeBonusCents = 0;
  private readonly welcomeGranted = new Set<string>();
  /** Mirror of fn_grant_welcome_bonus: idempotent, returns cents granted (0 = none). */
  async grantWelcomeBonus(userId: string): Promise<number> {
    if (this.welcomeBonusCents <= 0 || this.welcomeGranted.has(userId)) return 0;
    this.welcomeGranted.add(userId);
    return this.welcomeBonusCents;
  }
  async register(phone: string, username: string, passwordHash: string, referralCode?: string, siteId?: string): Promise<RegisteredUser> {
    if (phone.length < 8) throw new Error("INVALID_PHONE");
    if (username.length < 3) throw new Error("INVALID_USERNAME");
    if (passwordHash.length < 20) throw new Error("INVALID_HASH");
    const pkey = idKey(phone, siteId);
    const ukey = idKey(username, siteId);
    if (this.byPhone.has(pkey)) throw new Error("PHONE_TAKEN");        // uniqueness is PER SITE
    if (this.usernames.has(ukey)) throw new Error("USERNAME_TAKEN");
    const u: MemUser = {
      userId: randomUUID(), phone, username, role: "player", status: "active",
      passwordHash, referredBy: null, createdAtMs: Date.now(), siteId: siteId ?? null,
    };
    this.byPhone.set(pkey, u); this.byId.set(u.userId, u); this.usernames.add(ukey);
    // First-touch, permanent attribution: an unknown/suspended code is silently ignored.
    if (referralCode) {
      const affUserId = this.byReferralCode.get(referralCode.toUpperCase());
      const aff = affUserId ? this.affiliates.get(affUserId) : undefined;
      if (aff && aff.status === "active" && aff.userId !== u.userId) {
        u.referredBy = aff.userId;
        this.referrals.push({ id: ++this.seq, affiliateId: aff.userId, referredUser: u.userId, createdAtMs: Date.now() });
      }
    }
    return { userId: u.userId, role: u.role };
  }
  async findByPhone(phone: string, siteId?: string): Promise<CredentialRecord | null> {
    const u = this.byPhone.get(idKey(phone, siteId));
    return u ? { userId: u.userId, role: u.role, status: u.status, siteId: u.siteId ?? null, passwordHash: u.passwordHash } : null;
  }
  async findAllByPhone(phone: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()]
      .filter((u) => u.phone === phone)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((u) => ({ userId: u.userId, role: u.role, status: u.status, siteId: u.siteId ?? null, passwordHash: u.passwordHash }));
  }
  async getMfa(userId: string): Promise<MfaRecord | null> {
    const m = this.mfa.get(userId);
    return m ? { userId, secret: m.secret, enabled: m.enabled, recoveryCodeHashes: [...m.recoveryCodeHashes] } : null;
  }
  async putMfaSecret(userId: string, secret: string, recoveryCodeHashes: string[]): Promise<void> {
    this.mfa.set(userId, { secret, enabled: false, recoveryCodeHashes: [...recoveryCodeHashes] });
  }
  async enableMfa(userId: string): Promise<void> {
    const m = this.mfa.get(userId);
    if (m) m.enabled = true;
  }
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const m = this.mfa.get(userId);
    if (!m) return false;
    const i = m.recoveryCodeHashes.indexOf(codeHash);
    if (i === -1) return false;
    m.recoveryCodeHashes.splice(i, 1);
    return true;
  }
  async disableMfa(userId: string): Promise<void> {
    this.mfa.delete(userId);
  }
  async setPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    const u = this.byId.get(userId);
    if (!u) return false;
    u.passwordHash = passwordHash;
    return true;
  }
  async getProfile(userId: string): Promise<ProfileRow | null> {
    const u = this.byId.get(userId);
    return u ? this.toProfile(u) : null;
  }
  async setSecurityAnswers(userId: string, answers: SecurityAnswerHash[]): Promise<void> {
    // Replace the whole set (mirror the Pg upsert-and-prune): the stored map becomes exactly `answers`.
    this.securityAnswers.set(userId, new Map(answers.map((a) => [a.questionKey, a.answerHash])));
  }
  async getSecurityAnswers(userId: string): Promise<SecurityAnswerHash[]> {
    const m = this.securityAnswers.get(userId);
    if (!m) return [];
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([questionKey, answerHash]) => ({ questionKey, answerHash }));
  }
  async countSecurityAnswers(userId: string): Promise<number> {
    return this.securityAnswers.get(userId)?.size ?? 0;
  }
  async getSessionsValidAfterMs(userId: string): Promise<number | null> {
    return this.sessionsValidAfter.get(userId) ?? null;
  }
  /** TEST-ONLY: elevate a user's role (registration always creates role='player'). */
  _setRole(userId: string, role: string): void {
    const u = this.byId.get(userId);
    if (u) u.role = role;
  }
  /** TEST-ONLY: stamp a user's force-logout epoch (ms), mirroring the 0097 SQL stamp. */
  _forceLogout(userId: string, atMs: number = Date.now()): void {
    this.sessionsValidAfter.set(userId, atMs);
  }
  async enrollAffiliate(userId: string): Promise<AffiliateView> {
    const u = this.byId.get(userId);
    if (!u) throw new Error("USER_NOT_FOUND");
    let aff = this.affiliates.get(userId);
    if (!aff) {
      let code: string;
      do { code = genReferralCode(); } while (this.byReferralCode.has(code));
      aff = { userId, referralCode: code, commissionRate: 0.2, status: "active" };
      this.affiliates.set(userId, aff);
      this.byReferralCode.set(code, userId);
      if (u.role === "player") u.role = "marketer"; // never downgrade a privileged role
    }
    return { userId, referralCode: aff.referralCode, commissionRate: aff.commissionRate, status: aff.status, role: u.role };
  }
  async accrueCommissions(period: string, _siteId?: string): Promise<AffiliateAccrualResult> {
    // In-memory affiliates are single-brand (one site per affiliate), so the site filter is a
    // no-op here; per-site correctness is exercised against Postgres in the DB e2e harness.
    let buckets = 0; let total = 0;
    for (const [affUserId, aff] of this.affiliates) {
      const referred = this.referrals.filter((r) => r.affiliateId === affUserId).map((r) => r.referredUser);
      for (const ru of referred) {
        const dayPlays = this.plays.filter((p) => p.referredUser === ru && p.period === period);
        if (dayPlays.length === 0) continue;
        const ggr = Math.max(0, dayPlays.reduce((s, p) => s + (p.stakeCents - p.payoutCents), 0));
        if (ggr <= 0) continue;
        const commission = Math.floor(ggr * aff.commissionRate);
        const existing = this.commissions.find((c) => c.affiliateId === affUserId && c.referredUser === ru && c.period === period);
        if (existing) {
          if (existing.status !== "accrued") continue; // paid/reversed buckets are never re-touched
          existing.ggr = ggr; existing.commission = commission;
        } else {
          this.commissions.push({ id: ++this.seq, affiliateId: affUserId, referredUser: ru, period, ggr, commission, status: "accrued", createdAtMs: Date.now(), payoutId: null });
        }
        buckets += 1; total += commission;
      }
    }
    return { buckets, totalCommissionCents: total };
  }
  /** Test/dev seam: record a settled play for a referred user on a trading day (drives accrual + turnover). */
  recordSettledPlay(referredUser: string, period: string, stakeCents: number, payoutCents: number, openedAtMs: number = Date.now()): void {
    this.plays.push({ referredUser, period, stakeCents, payoutCents, openedAtMs });
  }
  async affiliateSummary(userId: string): Promise<AffiliateSummary | null> {
    const aff = this.affiliates.get(userId);
    if (!aff) return null;
    const referred = this.referrals.filter((r) => r.affiliateId === userId).map((r) => r.referredUser);
    const refSet = new Set(referred);
    const now = Date.now();
    const playsOfReferred = this.plays.filter((p) => refSet.has(p.referredUser));
    const activeWithin = (days: number): number =>
      new Set(playsOfReferred.filter((p) => p.openedAtMs >= now - days * 86_400_000).map((p) => p.referredUser)).size;
    const turnover = playsOfReferred.reduce((s, p) => s + p.stakeCents, 0);
    const myCommissions = this.commissions.filter((c) => c.affiliateId === userId);
    const ggr = myCommissions.reduce((s, c) => s + c.ggr, 0);
    const accrued = myCommissions.filter((c) => c.status === "accrued").reduce((s, c) => s + c.commission, 0);
    const paid = myCommissions.filter((c) => c.status === "paid").reduce((s, c) => s + c.commission, 0);
    // available = accrued buckets not yet reserved by an in-flight payout (payout_id snapshot).
    const available = myCommissions.filter((c) => c.status === "accrued" && c.payoutId === null).reduce((s, c) => s + c.commission, 0);
    const myClicks = this.affiliateClicks.filter((cid) => cid === userId).length;
    return {
      referralCode: aff.referralCode, referralPath: `/r/${aff.referralCode}`,
      commissionRate: aff.commissionRate, status: aff.status,
      totalReferrals: referred.length, activePlayers7d: activeWithin(7), activePlayers30d: activeWithin(30),
      turnoverCents: turnover, ggrCents: ggr,
      commissionAccruedCents: accrued, commissionPaidCents: paid, availableCents: available,
      referralsToday: activeWithin(1), activePlayersToday: activeWithin(1), commissionTodayCents: 0,
      clicks: myClicks, clicksToday: myClicks, ftdCount: 0,
    };
  }
  /** In-memory click log (affiliate userId per click); mirrors fn_affiliate_record_click tolerance. */
  private readonly affiliateClicks: string[] = [];
  async recordClick(code: string, _siteId?: string): Promise<boolean> {
    const c = (code ?? "").trim().toLowerCase();
    if (!c) return false;
    for (const [uid, aff] of this.affiliates) {
      if (aff.referralCode.toLowerCase() === c && aff.status === "active") { this.affiliateClicks.push(uid); return true; }
    }
    return false;
  }
  async listReferrals(userId: string, q: PageQuery): Promise<Page<ReferralRecord>> {
    const rows = this.referrals
      .filter((r) => r.affiliateId === userId)
      .map((r) => ({
        username: this.byId.get(r.referredUser)?.username ?? "unknown",
        joinedAtMs: r.createdAtMs,
        lifetimeGgrCents: this.commissions
          .filter((c) => c.affiliateId === userId && c.referredUser === r.referredUser)
          .reduce((s, c) => s + c.ggr, 0),
        _ts: r.createdAtMs, _id: String(r.id),
      }));
    return stripKeys(memPage(rows, q));
  }
  async listCommissions(userId: string, q: PageQuery): Promise<Page<CommissionRecord>> {
    const rows = this.commissions
      .filter((c) => c.affiliateId === userId)
      .map((c) => ({
        period: c.period, ggrCents: c.ggr, commissionCents: c.commission, status: c.status, createdAtMs: c.createdAtMs,
        _ts: c.createdAtMs, _id: String(c.id),
      }));
    return stripKeys(memPage(rows, q));
  }
  async requestPayout(userId: string): Promise<PayoutRequestResult> {
    for (const p of this.payouts.values()) {
      if (p.affiliateId === userId && (p.status === "requested" || p.status === "approved")) throw new Error("PAYOUT_PENDING");
    }
    const reserved = this.commissions.filter((c) => c.affiliateId === userId && c.status === "accrued" && c.payoutId === null);
    const amount = reserved.reduce((s, c) => s + c.commission, 0);
    if (amount <= 0) throw new Error("NO_AVAILABLE_COMMISSION");
    const id = randomUUID();
    this.payouts.set(id, { id, affiliateId: userId, amount, status: "requested", approvedBy: null, conversationId: null, receipt: null, resultCode: null, createdAtMs: Date.now() });
    for (const c of reserved) c.payoutId = id;   // snapshot the covered buckets
    return { payoutId: id, amountCents: amount };
  }
  async approvePayout(payoutId: string, adminId: string): Promise<PayoutApproveResult> {
    const p = this.payouts.get(payoutId);
    if (!p) throw new Error("PAYOUT_NOT_FOUND");
    if (p.status !== "requested") return { approved: false, amountCents: null, phone: null };
    p.status = "approved"; p.approvedBy = adminId;
    return { approved: true, amountCents: p.amount, phone: this.byId.get(p.affiliateId)?.phone ?? null };
  }
  async completePayout(payoutId: string, resultCode: number, conversationId: string | null, receipt: string | null, _resultDesc: string | null, _raw: unknown): Promise<PayoutCompleteResult> {
    const p = this.payouts.get(payoutId);
    if (!p) throw new Error("PAYOUT_NOT_FOUND");
    if (p.status === "paid" || p.status === "rejected") return { applied: false, status: p.status }; // terminal
    if (p.status !== "approved") return { applied: false, status: p.status };                        // result only valid post-approval
    p.conversationId = conversationId; p.receipt = receipt; p.resultCode = resultCode;
    if (resultCode === 0) {
      p.status = "paid";
      for (const c of this.commissions) if (c.payoutId === payoutId && c.status === "accrued") c.status = "paid";
      return { applied: true, status: "paid" };
    }
    p.status = "rejected";
    for (const c of this.commissions) if (c.payoutId === payoutId && c.status === "accrued") c.payoutId = null; // release
    return { applied: true, status: "rejected" };
  }
  async rejectPayout(payoutId: string, adminId: string, reason?: string): Promise<boolean> {
    const p = this.payouts.get(payoutId);
    if (!p) throw new Error("PAYOUT_NOT_FOUND");
    if (p.status !== "requested") return false;
    p.status = "rejected"; p.approvedBy = adminId; p.rejectReason = reason ?? null;
    for (const c of this.commissions) if (c.payoutId === payoutId && c.status === "accrued") c.payoutId = null; // release
    return true;
  }
  // The in-memory mirror doesn't track a payout's brand, so it can't resolve one — return null,
  // which the write-path guard treats as "don't block" (the site-aware RPC is the real guard).
  async siteOfPayout(_payoutId: string): Promise<string | null> { return null; }
  private toProfile(u: MemUser): ProfileRow {
    return {
      userId: u.userId, username: u.username, phone: u.phone, role: u.role, status: u.status,
    };
  }
  /** Test seam: flip an account's status (active | suspended | banned). */
  setStatus(phone: string, status: string): void {
    const u = this.byPhone.get(idKey(phone));
    if (u) u.status = status;
  }
  /** Test seam: the affiliate a user was attributed to at signup, or null. */
  referredByOf(userId: string): string | null {
    return this.byId.get(userId)?.referredBy ?? null;
  }
  /** Test seam: how many referrals an affiliate has accrued. */
  referralCount(affiliateId: string): number {
    return this.referrals.filter((r) => r.affiliateId === affiliateId).length;
  }

  // ── Admin back office snapshots & mutations (J2) ─────────────────────────
  /** All users as admin snapshots. */
  adminUsers(): AdminUserSnapshot[] {
    return [...this.byId.values()].map((u) => this.toAdminUser(u));
  }
  /** One user snapshot, or null. */
  adminUser(userId: string): AdminUserSnapshot | null {
    const u = this.byId.get(userId);
    return u ? this.toAdminUser(u) : null;
  }
  /** Flip an account's status by id (the admin repo enforces the RPC guards before calling this). */
  adminSetStatus(userId: string, status: string): void {
    const u = this.byId.get(userId);
    if (u) u.status = status;
  }
  /** Test/admin seam: set a user's role (role management is a DB concern in production). */
  adminSetRole(userId: string, role: string): void {
    const u = this.byId.get(userId);
    if (u) u.role = role;
  }
  /** Test/admin seam: edit a user's phone/username (item 6). Null leaves the field unchanged. */
  adminSetContact(userId: string, phone: string | null, username: string | null): void {
    const u = this.byId.get(userId);
    if (!u) return;
    if (phone != null) u.phone = phone;
    if (username != null) u.username = username;
  }
  /** All affiliates' commission terms. */
  adminAffiliates(): AdminAffiliateSnapshot[] {
    return [...this.affiliates.values()].map((a) => ({ userId: a.userId, commissionRate: a.commissionRate, status: a.status }));
  }
  /** One affiliate's commission terms, or null. */
  adminAffiliate(userId: string): AdminAffiliateSnapshot | null {
    const a = this.affiliates.get(userId);
    return a ? { userId: a.userId, commissionRate: a.commissionRate, status: a.status } : null;
  }
  /** Set an affiliate's commission rate (the admin repo enforces the RPC guards first). */
  adminSetCommissionRate(userId: string, rate: number): void {
    const a = this.affiliates.get(userId);
    if (a) a.commissionRate = rate;
  }
  /** All settled plays (turnover/GGR aggregation). */
  adminPlays(): AdminPlaySnapshot[] {
    return this.plays.map((p) => ({ userId: p.referredUser, stakeCents: p.stakeCents, payoutCents: p.payoutCents }));
  }
  /** All settled plays with their trade-date period (per-day/per-user reports, J4). */
  adminReportPlays(): AdminReportPlay[] {
    return this.plays.map((p) => ({ userId: p.referredUser, period: p.period, stakeCents: p.stakeCents, payoutCents: p.payoutCents }));
  }
  /** Settled plays for one user. */
  adminPlaysOf(userId: string): AdminPlaySnapshot[] {
    return this.plays.filter((p) => p.referredUser === userId).map((p) => ({ userId: p.referredUser, stakeCents: p.stakeCents, payoutCents: p.payoutCents }));
  }
  /** All commission buckets (accrued/paid aggregation). */
  adminCommissions(): AdminCommissionSnapshot[] {
    return this.commissions.map((c) => ({ commissionCents: c.commission, status: c.status }));
  }
  /** Count of in-flight payout requests (requested|approved). */
  adminPendingPayoutCount(): number {
    let n = 0;
    for (const p of this.payouts.values()) if (p.status === "requested" || p.status === "approved") n += 1;
    return n;
  }
  /** All payout requests (optionally filtered by status) as admin queue snapshots (J6). */
  adminListPayouts(status?: string): AdminPayoutSnapshot[] {
    const out: AdminPayoutSnapshot[] = [];
    for (const p of this.payouts.values()) {
      if (status !== undefined && p.status !== status) continue;
      const u = this.byId.get(p.affiliateId);
      out.push({
        payoutId: p.id, affiliateId: p.affiliateId,
        username: u?.username ?? p.affiliateId, phone: u?.phone ?? "",
        amountCents: p.amount, status: p.status, approvedBy: p.approvedBy, createdAtMs: p.createdAtMs,
      });
    }
    return out;
  }
  private toAdminUser(u: MemUser): AdminUserSnapshot {
    return {
      userId: u.userId, username: u.username, phone: u.phone, role: u.role, status: u.status,
      referredBy: u.referredBy, createdAtMs: u.createdAtMs, siteId: u.siteId ?? null,
    };
  }
}

/** Generate a referral code from the canonical alphabet (in-memory mirror of the DB generator). */
function genReferralCode(): string {
  let s = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) s += REFERRAL_CODE_ALPHABET.charAt(randomInt(REFERRAL_CODE_ALPHABET.length));
  return s;
}

/** In-memory keyset pagination over `(_ts desc, _id desc)` rows, mirroring the Pg keyset reads. */
function memPage<T extends { _ts: number; _id: string }>(all: T[], q: PageQuery): Page<T> {
  const limit = clampLimit(q.limit);
  const cur = decodeKeyset(q.cursor);
  const sorted = [...all].sort((a, b) => (b._ts - a._ts) || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  const filtered = cur ? sorted.filter((x) => x._ts < cur.tsMs || (x._ts === cur.tsMs && x._id < cur.id)) : sorted;
  return pageFrom(filtered, limit, (t) => `${t._ts}:${t._id}`);
}

/** Drop the internal `_ts`/`_id` keyset fields from a paginated result's items. */
function stripKeys<T extends { _ts: number; _id: string }>(page: Page<T>): Page<Omit<T, "_ts" | "_id">> {
  return { items: page.items.map(({ _ts, _id, ...rest }) => rest), nextCursor: page.nextCursor };
}

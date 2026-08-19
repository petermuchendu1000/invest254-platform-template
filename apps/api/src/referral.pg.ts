import type {
  ReferralRepo, ReferralSummary, CommissionRow, CommissionPayoutRow, AdminCommissionPayoutRow,
} from "./app.referral.js";

/** Minimal query surface (node-postgres Pool/Client satisfy this). */
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const ms = (v: unknown): number => (v == null ? 0 : new Date(v as string).getTime());
const msN = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

function toPayout(r: any): CommissionPayoutRow {
  return {
    id: String(r.id), amountCents: num(r.amount_cents), status: String(r.status),
    requestedAtMs: ms(r.requested_at), approvedAtMs: msN(r.approved_at),
    paidAtMs: msN(r.paid_at), paidRef: r.paid_ref ?? null, note: r.note ?? null,
  };
}

/**
 * Postgres-backed referral/commission repository (deposit-based differential-unilevel model,
 * migrations 0078/0079). Every mutation is a single atomic RPC; the guards (BELOW_MIN,
 * PAYOUT_PENDING, INVALID_STATE) live in the database.
 */
export function makePgReferralRepo(query: Query): ReferralRepo {
  return {
    async myReferral(userId): Promise<ReferralSummary> {
      const { rows } = await query(
        `select p.referral_code,
                (p.role = 'marketer') as is_marketer,
                (select count(*) from public.profiles c where c.referred_by = p.id) as total_referrals,
                (select coalesce(sum(commission_amount),0) from public.deposit_commissions dc where dc.beneficiary_user = p.id) as earned,
                b.held_cents, b.paid_cents, b.available_cents
           from public.profiles p, public.fn_commission_balance(p.id) b
          where p.id = $1`, [userId]);
      const r = rows[0] ?? {};
      const code = r.referral_code ?? null;
      const { rows: mrows } = await query("select public.fn_commission_min_cents() as m", []);
      return {
        referralCode: code,
        referralPath: code ? `/r/${code}` : null,
        isMarketer: Boolean(r.is_marketer),
        totalReferrals: num(r.total_referrals),
        earnedCents: num(r.earned),
        heldCents: num(r.held_cents),
        paidCents: num(r.paid_cents),
        availableCents: num(r.available_cents),
        minPayoutCents: num(mrows[0]?.m),
      };
    },

    async listMyCommissions(userId, limit): Promise<CommissionRow[]> {
      const { rows } = await query(
        `select dc.id, dc.deposit_tx_id, dc.referred_user, rp.username as referred_username,
                dc.position, dc.beneficiary_role, dc.rate, dc.deposit_amount, dc.commission_amount, dc.status, dc.created_at
           from public.deposit_commissions dc
           left join public.profiles rp on rp.id = dc.referred_user
          where dc.beneficiary_user = $1
          order by dc.created_at desc, dc.id desc limit $2`, [userId, limit]);
      return rows.map((r) => ({
        id: num(r.id), depositTxId: String(r.deposit_tx_id),
        referredUser: String(r.referred_user), referredUsername: r.referred_username ?? null,
        position: num(r.position), role: String(r.beneficiary_role), rate: Number(r.rate),
        depositAmountCents: num(r.deposit_amount), commissionCents: num(r.commission_amount),
        status: String(r.status), createdAtMs: ms(r.created_at),
      }));
    },

    async requestPayout(userId): Promise<CommissionPayoutRow> {
      const { rows } = await query("select * from public.fn_request_commission_payout($1)", [userId]);
      return toPayout(rows[0]);
    },

    async listMyPayouts(userId, limit): Promise<CommissionPayoutRow[]> {
      const { rows } = await query(
        "select * from public.commission_payouts where beneficiary_user = $1 order by requested_at desc limit $2",
        [userId, limit]);
      return rows.map(toPayout);
    },

    async listPayouts(siteId, status, limit): Promise<AdminCommissionPayoutRow[]> {
      const { rows } = await query(
        `select cp.*, pr.username, pr.phone
           from public.commission_payouts cp
           join public.profiles pr on pr.id = cp.beneficiary_user
          where ($1::uuid is null or cp.site_id = $1)
            and ($2::text is null or cp.status = $2)
          order by cp.requested_at desc limit $3`, [siteId ?? null, status ?? null, limit]);
      return rows.map((r) => ({
        ...toPayout(r), beneficiaryUser: String(r.beneficiary_user),
        username: r.username ?? null, phone: r.phone ?? null, siteId: String(r.site_id),
      }));
    },

    async siteOfPayout(id): Promise<string | null> {
      const { rows } = await query("select site_id from public.commission_payouts where id = $1", [id]);
      return rows.length ? String(rows[0].site_id) : null;
    },

    async approvePayout(id, adminId): Promise<CommissionPayoutRow> {
      const { rows } = await query("select * from public.fn_approve_commission_payout($1, $2)", [id, adminId]);
      return toPayout(rows[0]);
    },

    async markPaid(id, adminId, ref): Promise<CommissionPayoutRow> {
      const { rows } = await query("select * from public.fn_mark_commission_payout_paid($1, $2, $3)", [id, adminId, ref ?? null]);
      return toPayout(rows[0]);
    },

    async rejectPayout(id, adminId, reason): Promise<CommissionPayoutRow> {
      const { rows } = await query("select * from public.fn_reject_commission_payout($1, $2, $3)", [id, adminId, reason ?? null]);
      return toPayout(rows[0]);
    },
  };
}

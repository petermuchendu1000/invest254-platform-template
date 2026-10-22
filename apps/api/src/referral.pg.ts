import type {
  ReferralRepo, ReferralSummary, CommissionRow, CommissionPayoutRow, AdminCommissionPayoutRow,
} from "./app.referral.js";

/** Minimal query surface (node-postgres Pool/Client satisfy this). */
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

// ── Ranged marketer money statement (the /dashboard money table) ────────────────────────────────
//
// IDENTITY. Every table read below is keyed by the AFFILIATE marketer — a `profiles` row with
// role='marketer', whose id is the token subject on the `auth, site, marketer` gate in
// app.affiliate.ts. It is NOT the `public.marketers` till-app entity (own table, own PIN login,
// token subject a `marketers.id`, money in `marketer_wallets`). Confirmed against the schema:
//   - deposit_commissions.beneficiary_user  uuid not null references public.profiles(id)  (0078:29, hard FK)
//   - commission_payouts.beneficiary_user   uuid not null references public.profiles(id)  (0079:14, hard FK)
//   - marketer_expenses.marketer_user_id    profiles.id by contract (0068:10; no FK, but 0154's
//     fn_admin_add_marketer_expense resolves `select site_id ... from public.profiles where id = p_marketer`,
//     and 0105 re-keyed stray marketer_profiles.id values to profiles.id)
//   - marketer_advance_requests.marketer_user_id  "affiliate profiles.id (same key as marketer_expenses)" (0122:22)
// fn_commission_balance(p_user) keys on exactly those three columns, so one id space covers the lot.
//
// RANGE CONVENTION — reused verbatim from the admin money reports (the house convention for a
// money report), `reportRange` in app.admin.ts:112-126 + `PgAdminRepo.reportDaily` in
// apps/engine/src/admin.ts:1104-1138:
//   * bounds are inclusive `YYYY-MM-DD` calendar dates, i.e. [from, to] — NOT half-open;
//   * `null` on a side means unbounded on that side (so "all time" is both sides null);
//   * the day boundary is `(ts at time zone 'Africa/Nairobi')::date` — the brand's own day, EAT
//     (UTC+3, no DST) — applied to the timestamp column itself, exactly as reportDaily does
//     (`($1::date is null or (created_at at time zone 'Africa/Nairobi')::date >= $1::date)`).
// The enum that selects a window, and its rejection of an unknown value, lives in the route.
// Nothing client-supplied is ever interpolated: the dates arrive as $2/$3 bound parameters and are
// cast in SQL with `::date`.
//
// WHICH TIMESTAMP PER TABLE (the deposit's own timestamp vs the commission row's already matters
// elsewhere here, so it is spelled out):
//   * deposit_commissions.created_at — the COMMISSION ROW's instant, not `transactions.created_at`.
//     The row is inserted inside fn_complete_deposit -> fn_pay_referral_commissions (0078:157), i.e.
//     at deposit SETTLEMENT. transactions.created_at is STK *initiation*, which can be minutes or
//     (on a retried/late callback) days earlier, and an unsettled deposit earns nothing at all. The
//     marketer earns when the deposit settles, so settlement is the axis. It is also the only
//     timestamp the commission row carries.
//   * marketer_expenses.created_at — its only timestamp, and the second column of
//     idx_marketer_expenses_user (0068:17), so a per-marketer range is index-served.
//   * marketer_advance_requests.created_at — request time (indexed, 0122:25). `decided_at` is
//     reused as the CANCEL timestamp too (0122:68), so it is not a clean decision axis.
//   * commission_payouts — two different columns on purpose: money that LEFT in the window is
//     ranged on `paid_at`, money still held is ranged on `requested_at` (a pending request has no
//     paid_at). fn_commission_balance itself is status-based and time-blind, which is precisely why
//     these windowed figures are reported separately from the lifetime ladder.
//
// BUGLOG #23: every total here is its own SQL aggregate over the SAME predicate as the list beside
// it. No total is ever `reduce(items)` — `commissions`/`expenses`/`advances` are limit-capped
// display PAGES and summing one under-counts silently past the limit (the recorded failure: 150
// expense rows reported 10,000 against a true 59,000).

/** Inclusive EAT calendar-date bounds; `null` is unbounded on that side (admin `reportRange`). */
export interface MoneyRangeBounds { from: string | null; to: string | null }

/** Windowed money, as real SQL aggregates over the range (never a page sum — BUGLOG #23). */
export interface MarketerMoneyWindow {
  /** Commission accrued IN the window on the same predicate fn_commission_balance earns on
   *  (beneficiary_role='marketer' and status='accrued'), so it is a true subset of lifetime earned. */
  earnedCents: number;
  earnedCount: number;
  /** Any OTHER deposit_commissions row in the window (a promoted player's instant 5%, status='paid').
   *  Reported separately because it funds nothing in fn_commission_balance (BUGLOG #23 defect 3). */
  otherCommissionCents: number;
  /** Every logged expense in the window — INCLUDING category='advance' rows, which is the copy of an
   *  approved advance that actually reduces the withdrawable. */
  expensesCents: number;
  expensesCount: number;
  /** Advances REQUESTED in the window, by current status. `advancesApprovedCents` is informational:
   *  the approved advance is already counted once in `expensesCents` (0122:94-103 logs it as a
   *  marketer_expenses row linked by expense_id), so it must never be added to the money arithmetic. */
  advancesApprovedCents: number;
  advancesPendingCents: number;
  advancesCount: number;
  /** Commission payouts marked paid in the window (ranged on paid_at). */
  payoutsPaidCents: number;
  /** Payouts requested in the window and still held (requested|approved; ranged on requested_at). */
  payoutsPendingCents: number;
}

/** The lifetime ladder — the exact four terms of fn_commission_balance plus the full expense sum. */
export interface MarketerMoneyLifetime {
  earnedCents: number;
  expensesCents: number;
  paidCents: number;
  heldCents: number;
  availableCents: number;
}

/** One logged expense row (same shape the dashboard already renders). */
export interface MoneyExpenseRow {
  id: string; category: string; amountCents: number; note: string | null;
  createdAtMs: number; createdBy: string | null;
}
/** One advance request row (same shape the dashboard already renders). */
export interface MoneyAdvanceRow {
  id: string; amountCents: number; reason: string | null;
  status: "requested" | "approved" | "rejected" | "cancelled";
  decisionNote: string | null; decidedAtMs: number | null; expenseId: string | null; createdAtMs: number;
}

export interface MarketerMoneyStatement {
  window: MarketerMoneyWindow;
  lifetime: MarketerMoneyLifetime;
  /** Display PAGES (limit-capped). The totals above are NOT derived from these. */
  commissions: CommissionRow[];
  expenses: MoneyExpenseRow[];
  advances: MoneyAdvanceRow[];
}

/** The ranged money statement behind `GET /affiliate/money`. */
export interface MarketerMoneyRepo {
  marketerMoney(userId: string, range: MoneyRangeBounds, limit: number): Promise<MarketerMoneyStatement>;
}

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
export function makePgReferralRepo(query: Query): ReferralRepo & MarketerMoneyRepo {
  /**
   * The inclusive EAT day-bound predicate, for one timestamp column, as SQL text.
   *
   * `col` is a hard-coded column reference from the callers below — never anything the client sent.
   * The two DATES are bound parameters ($2/$3), cast with `::date`, exactly as reportDaily does.
   */
  const inEatRange = (col: string) =>
    `($2::date is null or (${col} at time zone 'Africa/Nairobi')::date >= $2::date)
     and ($3::date is null or (${col} at time zone 'Africa/Nairobi')::date <= $3::date)`;

  return {
    async myReferral(userId): Promise<ReferralSummary> {
      const { rows } = await query(
        `select p.referral_code,
                (p.role = 'marketer') as is_marketer,
                (select count(*) from public.profiles c where c.referred_by = p.id) as total_referrals,
                (select coalesce(sum(commission_amount),0) from public.deposit_commissions dc where dc.beneficiary_user = p.id) as earned,
                b.earned_cents as marketer_earned, b.held_cents, b.paid_cents, b.available_cents
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
        marketerEarnedCents: num(r.marketer_earned),
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

    async marketerMoney(userId, range, limit): Promise<MarketerMoneyStatement> {
      const bounds = [userId, range.from, range.to];
      // Five reads, one snapshot. Each TOTAL is its own aggregate over the same predicate as the
      // page beside it — never a sum of the page (BUGLOG #23).
      const [totals, life, comm, exp, adv] = await Promise.all([
        query(
          `select
             (select coalesce(sum(dc.commission_amount),0) from public.deposit_commissions dc
               where dc.beneficiary_user = $1 and dc.beneficiary_role = 'marketer' and dc.status = 'accrued'
                 and ${inEatRange("dc.created_at")}) as earned,
             (select count(*) from public.deposit_commissions dc
               where dc.beneficiary_user = $1 and dc.beneficiary_role = 'marketer' and dc.status = 'accrued'
                 and ${inEatRange("dc.created_at")}) as earned_n,
             (select coalesce(sum(dc.commission_amount),0) from public.deposit_commissions dc
               where dc.beneficiary_user = $1
                 and not (dc.beneficiary_role = 'marketer' and dc.status = 'accrued')
                 and ${inEatRange("dc.created_at")}) as other_comm,
             (select coalesce(sum(e.amount_cents),0) from public.marketer_expenses e
               where e.marketer_user_id = $1 and ${inEatRange("e.created_at")}) as expenses,
             (select count(*) from public.marketer_expenses e
               where e.marketer_user_id = $1 and ${inEatRange("e.created_at")}) as expenses_n,
             (select coalesce(sum(a.amount_cents),0) from public.marketer_advance_requests a
               where a.marketer_user_id = $1 and a.status = 'approved' and ${inEatRange("a.created_at")}) as adv_approved,
             (select coalesce(sum(a.amount_cents),0) from public.marketer_advance_requests a
               where a.marketer_user_id = $1 and a.status = 'requested' and ${inEatRange("a.created_at")}) as adv_pending,
             (select count(*) from public.marketer_advance_requests a
               where a.marketer_user_id = $1 and ${inEatRange("a.created_at")}) as adv_n,
             (select coalesce(sum(p.amount_cents),0) from public.commission_payouts p
               where p.beneficiary_user = $1 and p.status = 'paid' and ${inEatRange("p.paid_at")}) as payouts_paid,
             (select coalesce(sum(p.amount_cents),0) from public.commission_payouts p
               where p.beneficiary_user = $1 and p.status in ('requested','approved')
                 and ${inEatRange("p.requested_at")}) as payouts_held`, bounds),
        // Lifetime, authoritative and deliberately UN-ranged: the hero's "Available to withdraw" is
        // a lifetime balance. fn_commission_balance takes only (p_user uuid) and floors at 0 over all
        // time; fn_marketer_expenses_total is the full-sum expense RPC from migration 0121.
        query(
          `select b.earned_cents, b.held_cents, b.paid_cents, b.available_cents,
                  public.fn_marketer_expenses_total($1::uuid) as expenses_cents
             from public.fn_commission_balance($1::uuid) b`, [userId]),
        query(
          `select dc.id, dc.deposit_tx_id, dc.referred_user, rp.username as referred_username,
                  dc.position, dc.beneficiary_role, dc.rate, dc.deposit_amount, dc.commission_amount,
                  dc.status, dc.created_at
             from public.deposit_commissions dc
             left join public.profiles rp on rp.id = dc.referred_user
            where dc.beneficiary_user = $1 and ${inEatRange("dc.created_at")}
            order by dc.created_at desc, dc.id desc limit $4`, [...bounds, limit]),
        query(
          `select e.id, e.category, e.amount_cents, e.note, e.created_at, e.created_by
             from public.marketer_expenses e
            where e.marketer_user_id = $1 and ${inEatRange("e.created_at")}
            order by e.created_at desc, e.id desc limit $4`, [...bounds, limit]),
        query(
          `select a.id, a.amount_cents, a.reason, a.status, a.decision_note, a.decided_at,
                  a.expense_id, a.created_at
             from public.marketer_advance_requests a
            where a.marketer_user_id = $1 and ${inEatRange("a.created_at")}
            order by a.created_at desc, a.id desc limit $4`, [...bounds, limit]),
      ]);
      const t = totals.rows[0] ?? {};
      const b = life.rows[0] ?? {};
      return {
        window: {
          earnedCents: num(t.earned), earnedCount: num(t.earned_n),
          otherCommissionCents: num(t.other_comm),
          expensesCents: num(t.expenses), expensesCount: num(t.expenses_n),
          advancesApprovedCents: num(t.adv_approved), advancesPendingCents: num(t.adv_pending),
          advancesCount: num(t.adv_n),
          payoutsPaidCents: num(t.payouts_paid), payoutsPendingCents: num(t.payouts_held),
        },
        lifetime: {
          earnedCents: num(b.earned_cents), expensesCents: num(b.expenses_cents),
          paidCents: num(b.paid_cents), heldCents: num(b.held_cents),
          availableCents: num(b.available_cents),
        },
        commissions: comm.rows.map((r) => ({
          id: num(r.id), depositTxId: String(r.deposit_tx_id),
          referredUser: String(r.referred_user), referredUsername: r.referred_username ?? null,
          position: num(r.position), role: String(r.beneficiary_role), rate: Number(r.rate),
          depositAmountCents: num(r.deposit_amount), commissionCents: num(r.commission_amount),
          status: String(r.status), createdAtMs: ms(r.created_at),
        })),
        expenses: exp.rows.map((r) => ({
          id: String(r.id), category: String(r.category), amountCents: num(r.amount_cents),
          note: r.note ?? null, createdAtMs: ms(r.created_at), createdBy: r.created_by ?? null,
        })),
        advances: adv.rows.map((r) => ({
          id: String(r.id), amountCents: num(r.amount_cents), reason: r.reason ?? null,
          status: String(r.status) as MoneyAdvanceRow["status"],
          decisionNote: r.decision_note ?? null, decidedAtMs: msN(r.decided_at),
          expenseId: r.expense_id ? String(r.expense_id) : null, createdAtMs: ms(r.created_at),
        })),
      };
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

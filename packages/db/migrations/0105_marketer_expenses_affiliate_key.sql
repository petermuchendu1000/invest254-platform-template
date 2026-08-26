-- 0105_marketer_expenses_affiliate_key.sql — attach marketer expenses to the affiliate identity and
-- net them out of the marketer's withdrawable commission balance.
--
-- Bug (BUGLOG #14): the admin "Marketer expenses" tab (marketer-finance) logged expenses keyed by the
-- marketer-APP identity (marketer_profiles.id), but the ONLY marketer-facing reader — the website
-- dashboard's GET /affiliate/expenses and the commission balance — key on the affiliate profiles.id
-- (migration 0068's documented contract). Same person, two id spaces → logged expenses/advances never
-- appeared on the marketer's dashboard and never affected their money.
--
-- Operator decision: ALL logged expenses reduce the marketer's withdrawable ("Available to withdraw"
-- = earned − held − paid − expenses, floored at 0). Advances are cash already paid to the marketer;
-- promo/data/airtime/other are costs carried on their behalf — all recovered from commission.
--
-- This migration:
--   (1) fn_commission_balance now subtracts the marketer's total logged expenses from available
--       (floored at 0). available = (earned − expenses) − held − paid, which is timing-safe and never
--       double-counts (paid amounts are already net at the time they were requested). Since the payout
--       request RPC reads available_cents, payouts are automatically capped at the net figure.
--   (2) Re-keys existing marketer_expenses rows that were mis-keyed to a marketer_profiles.id back to
--       the matching affiliate profiles.id (canonical fn_phone_sig9 + same site + role='marketer',
--       deterministic oldest match). Rows for app-only marketers with no website marketer account are
--       left untouched (nothing can display them). Idempotent: profiles.id rows never match a
--       marketer_profiles.id, so re-running is a no-op.
-- Additive & idempotent. No schema changes. (The list-side affiliate_user_id resolution lives in the
-- API query; see apps/api/src/marketers.pg.ts.)

-- (1) Net expenses out of the withdrawable balance.
create or replace function public.fn_commission_balance(p_user uuid)
returns table(earned_cents bigint, held_cents bigint, paid_cents bigint, available_cents bigint)
language sql stable security definer set search_path to 'public'
as $fn$
  with acc as (
    select coalesce(sum(commission_amount),0)::bigint as earned
      from public.deposit_commissions
     where beneficiary_user = p_user and beneficiary_role = 'marketer' and status = 'accrued'
  ),
  po as (
    select coalesce(sum(amount_cents) filter (where status in ('requested','approved')),0)::bigint as held,
           coalesce(sum(amount_cents) filter (where status = 'paid'),0)::bigint as paid
      from public.commission_payouts where beneficiary_user = p_user
  ),
  ex as (
    select coalesce(sum(amount_cents),0)::bigint as expenses
      from public.marketer_expenses where marketer_user_id = p_user
  )
  select acc.earned, po.held, po.paid,
         greatest(acc.earned - po.held - po.paid - ex.expenses, 0)::bigint
    from acc, po, ex
$fn$;

-- (2) Re-key mis-keyed expense rows (marketer_profiles.id -> affiliate profiles.id).
update public.marketer_expenses e
   set marketer_user_id = pr.id
  from public.marketer_profiles mp
  cross join lateral (
    select p.id
      from public.profiles p
     where public.fn_phone_sig9(p.phone) = public.fn_phone_sig9(mp.phone)
       and p.site_id = mp.site_id
       and p.role = 'marketer'
     order by p.created_at asc
     limit 1
  ) pr
 where e.marketer_user_id = mp.id;

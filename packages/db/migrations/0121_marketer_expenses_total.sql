-- 0121_marketer_expenses_total.sql — authoritative full-sum of a marketer's logged expenses.
--
-- Bug (BUGLOG #23): the marketer dashboard and the admin "Expenses" tab computed the expense TOTAL
-- by summing the returned PAGE of expense rows (`GET /affiliate/expenses` and
-- `GET /admin/affiliate/expenses` reduce the limit-capped `items` array, default limit=100). The
-- authoritative withdrawable math (`fn_commission_balance`) instead sums EVERY expense row in SQL.
-- So once a marketer accrues more than the page limit of expense rows, the DISPLAYED expense total
-- (and the derived "Net after expenses") silently under-counts and no longer reconciles with
-- "Available to withdraw", which is already net of the full expense sum. Money figures that don't tie
-- out erode marketer trust and can mask advances.
--
-- Fix: a dedicated total RPC that mirrors the `ex` CTE in `fn_commission_balance` EXACTLY, so the
-- expense total shown to a marketer is the same number that reduces their withdrawable — always, at
-- any row count. Read-only, SECURITY DEFINER (parity with fn_marketer_expenses so both the admin view
-- and the marketer's own dashboard resolve regardless of RLS). Additive & idempotent; no schema change.
create or replace function public.fn_marketer_expenses_total(p_marketer uuid)
returns bigint
language sql stable security definer set search_path = public
as $fn$
  select coalesce(sum(amount_cents), 0)::bigint
    from public.marketer_expenses
   where marketer_user_id = p_marketer
$fn$;

revoke all on function public.fn_marketer_expenses_total(uuid) from public, anon, authenticated;
grant execute on function public.fn_marketer_expenses_total(uuid) to service_role;

-- 0098_affiliate_payout_reject_reason.sql — capture WHY an affiliate (GGR) payout was rejected.
--
-- Until now fn_affiliate_reject_payout(uuid,uuid) recorded only that a 'requested' payout was
-- rejected (status='rejected', approved_by=admin) and released the reservation (the snapshotted
-- accrued commission buckets are un-linked → they return to the marketer's AVAILABLE balance, so
-- they can request a fresh payout). No money moves — reject is strictly pre-dispatch.
--
-- This adds an audit trail for the decision: rejected_by / rejected_at / reject_reason, and a 3-arg
-- fn overload that stores an optional reason. Behaviour is otherwise byte-for-byte identical, so the
-- existing money semantics (reservation release, requested-only guard, idempotent no-op otherwise)
-- are unchanged. Additive + idempotent.

alter table public.affiliate_payouts add column if not exists rejected_by   uuid;
alter table public.affiliate_payouts add column if not exists rejected_at   timestamptz;
alter table public.affiliate_payouts add column if not exists reject_reason text;

-- Add a 3-arg (reason) overload ALONGSIDE the existing 2-arg fn from 0019. We deliberately do NOT
-- drop the 2-arg version and the 3-arg has NO default argument — so there is no call ambiguity, and
-- the currently-running API (which calls the 2-arg fn) keeps working during the deploy window. The
-- new API calls the 3-arg fn. Behaviour is identical apart from storing the reason. Zero-downtime.
create or replace function public.fn_affiliate_reject_payout(p_payout uuid, p_admin uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public
as $fn$
declare v_status text;
begin
  select ap.status into v_status from affiliate_payouts ap where ap.id = p_payout for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_status <> 'requested' then return false; end if;   -- only a pre-dispatch request can be rejected
  update affiliate_payouts
     set status        = 'rejected',
         approved_by   = p_admin,                          -- kept for back-compat (existing readers)
         rejected_by   = p_admin,
         rejected_at   = now(),
         reject_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_payout;
  -- Release the reservation: accrued buckets snapshotted onto this payout return to available.
  update affiliate_commissions set payout_id = null where payout_id = p_payout and status = 'accrued';
  return true;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_affiliate_reject_payout(uuid, uuid, text) from public, anon, authenticated;
  grant  execute on function public.fn_affiliate_reject_payout(uuid, uuid, text) to service_role;
end $g$;

-- ── Revert (manual) ──────────────────────────────────────────────────────────────────────────
--   drop function if exists public.fn_affiliate_reject_payout(uuid, uuid, text);
--   alter table public.affiliate_payouts drop column if exists reject_reason, drop column if exists rejected_at, drop column if exists rejected_by;
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 0079_commission_payouts.sql — a SEPARATE payout stream for deposit-referral commissions.
--
-- Distinct from the native GGR affiliate payout queue (affiliate_payouts) so the two money streams
-- never conflate. Lifecycle: marketer REQUESTS (balance must be >= KES 500) -> admin APPROVES ->
-- admin marks PAID (manual M-Pesa for now; paybill automation later). Reject releases the hold.
--
-- Balance model (high-water-mark, no per-row linking):
--   available(user) = SUM(accrued marketer deposit_commissions) - SUM(non-rejected commission_payouts)
-- Players are paid instantly to their game wallet (status='paid' in deposit_commissions), so they
-- have no accrued marketer balance and nothing to request.

create table if not exists public.commission_payouts (
  id           uuid primary key default gen_random_uuid(),
  beneficiary_user uuid not null references public.profiles(id),
  site_id      uuid not null references public.sites(id),
  amount_cents bigint not null check (amount_cents > 0),
  status       text   not null default 'requested'
                 check (status in ('requested','approved','paid','rejected')),
  note         text,
  requested_at timestamptz not null default now(),
  approved_by  uuid,  approved_at timestamptz,
  paid_by      uuid,  paid_at timestamptz, paid_ref text,
  rejected_by  uuid,  rejected_at timestamptz, reject_reason text
);
create index if not exists ix_commpayout_beneficiary on public.commission_payouts(beneficiary_user, status);
create index if not exists ix_commpayout_site_status  on public.commission_payouts(site_id, status);
grant select on public.commission_payouts to service_role;

-- Minimum requestable balance: KES 500.
create or replace function public.fn_commission_min_cents() returns bigint language sql immutable as $$ select 50000::bigint $$;

-- A user's referral-commission balance snapshot (marketer accrued minus non-rejected payouts).
create or replace function public.fn_commission_balance(p_user uuid)
returns table(earned_cents bigint, held_cents bigint, paid_cents bigint, available_cents bigint)
language sql stable security definer set search_path = public as $fn$
  with acc as (
    select coalesce(sum(commission_amount),0)::bigint as earned
      from public.deposit_commissions
     where beneficiary_user = p_user and beneficiary_role = 'marketer' and status = 'accrued'
  ),
  po as (
    select coalesce(sum(amount_cents) filter (where status in ('requested','approved')),0)::bigint as held,
           coalesce(sum(amount_cents) filter (where status = 'paid'),0)::bigint as paid
      from public.commission_payouts where beneficiary_user = p_user
  )
  select acc.earned, po.held, po.paid, (acc.earned - po.held - po.paid)::bigint
    from acc, po
$fn$;

-- Marketer requests a payout of their full available balance (>= KES 500). Guards double-request.
create or replace function public.fn_request_commission_payout(p_user uuid)
returns public.commission_payouts
language plpgsql security definer set search_path = public as $fn$
declare v_avail bigint; v_site uuid; v_row public.commission_payouts;
begin
  if exists (select 1 from public.commission_payouts
              where beneficiary_user = p_user and status in ('requested','approved')) then
    raise exception 'PAYOUT_PENDING';
  end if;
  select available_cents into v_avail from public.fn_commission_balance(p_user);
  if coalesce(v_avail,0) < public.fn_commission_min_cents() then raise exception 'BELOW_MIN'; end if;
  select site_id into v_site from public.profiles where id = p_user;
  insert into public.commission_payouts(beneficiary_user, site_id, amount_cents, status)
    values (p_user, v_site, v_avail, 'requested') returning * into v_row;
  return v_row;
end;
$fn$;

-- Admin approve / mark-paid / reject (site-scoped guard is enforced in the app layer; RPCs are atomic).
create or replace function public.fn_approve_commission_payout(p_id uuid, p_admin uuid)
returns public.commission_payouts language plpgsql security definer set search_path = public as $fn$
declare v_row public.commission_payouts;
begin
  update public.commission_payouts set status='approved', approved_by=p_admin, approved_at=now()
    where id=p_id and status='requested' returning * into v_row;
  if not found then raise exception 'INVALID_STATE'; end if;
  return v_row;
end; $fn$;

create or replace function public.fn_mark_commission_payout_paid(p_id uuid, p_admin uuid, p_ref text)
returns public.commission_payouts language plpgsql security definer set search_path = public as $fn$
declare v_row public.commission_payouts;
begin
  update public.commission_payouts set status='paid', paid_by=p_admin, paid_at=now(), paid_ref=nullif(btrim(coalesce(p_ref,'')),'')
    where id=p_id and status in ('requested','approved') returning * into v_row;
  if not found then raise exception 'INVALID_STATE'; end if;
  return v_row;
end; $fn$;

create or replace function public.fn_reject_commission_payout(p_id uuid, p_admin uuid, p_reason text)
returns public.commission_payouts language plpgsql security definer set search_path = public as $fn$
declare v_row public.commission_payouts;
begin
  update public.commission_payouts set status='rejected', rejected_by=p_admin, rejected_at=now(), reject_reason=nullif(btrim(coalesce(p_reason,'')),'')
    where id=p_id and status in ('requested','approved') returning * into v_row;
  if not found then raise exception 'INVALID_STATE'; end if;
  return v_row;
end; $fn$;

revoke all on function public.fn_request_commission_payout(uuid), public.fn_approve_commission_payout(uuid,uuid),
  public.fn_mark_commission_payout_paid(uuid,uuid,text), public.fn_reject_commission_payout(uuid,uuid,text),
  public.fn_commission_balance(uuid) from public, anon, authenticated;
grant execute on function public.fn_request_commission_payout(uuid), public.fn_approve_commission_payout(uuid,uuid),
  public.fn_mark_commission_payout_paid(uuid,uuid,text), public.fn_reject_commission_payout(uuid,uuid,text),
  public.fn_commission_balance(uuid) to service_role;

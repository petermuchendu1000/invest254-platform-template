-- 0102_marketer_self_demo_topup.sql — marketer SELF-SERVICE demo (funny-money) top-up.
--
-- AUTONOMY (removes a superadmin/admin friction point): marketers previously had to WAIT for an admin
-- to credit their operating wallet (fn_marketer_credit) before they could demo the platform. The
-- marketer wallet (marketer_wallets.balance_cents) is SIMULATED funny money — it never touches real
-- cash or M-Pesa B2C (fn_marketer_credit/withdraw only move this virtual wallet + a ledger row), so
-- self-service is zero real-cash risk. This RPC lets a marketer top their OWN wallet UP TO a policy
-- cap, atomically (row-locked), idempotent-by-construction (no-op once at/above the cap), audited in
-- marketer_ledger. It NEVER reduces a balance and hard-limits the cap as defence-in-depth.
-- Additive, idempotent (create-or-replace). Money-neutral for real cash.

create or replace function public.fn_marketer_topup_demo(p_marketer_id uuid, p_cap_cents bigint)
returns bigint
language plpgsql
as $fn$
declare cur bigint; add_cents bigint; new_bal bigint; mstatus text;
begin
  -- Hard cap ceiling (defence-in-depth): the API passes a server-side policy cap; never allow a caller
  -- to request an unbounded top-up. KES 1,000,000 demo is far beyond any legitimate demo need.
  if p_cap_cents is null or p_cap_cents <= 0 or p_cap_cents > 100000000 then
    raise exception 'INVALID_CAP';
  end if;
  select status into mstatus from public.marketers where id = p_marketer_id;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;
  if mstatus <> 'active' then raise exception 'MARKETER_NOT_ACTIVE:%', mstatus; end if;

  select balance_cents into cur from public.marketer_wallets where marketer_id = p_marketer_id for update;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;

  if cur >= p_cap_cents then
    return cur;                       -- already at/above cap: idempotent no-op (safe to spam the button)
  end if;
  add_cents := p_cap_cents - cur;     -- top UP to the cap (never reduces)
  new_bal := cur + add_cents;
  update public.marketer_wallets set balance_cents = new_bal, updated_at = now() where marketer_id = p_marketer_id;
  insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
    values (p_marketer_id, 'credit', add_cents, new_bal,
            'self_demo_topup:' || to_char(now(), 'YYYYMMDDHH24MISS'),
            jsonb_build_object('source', 'self_service_demo'));
  return new_bal;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_marketer_topup_demo(uuid,bigint) from public, anon, authenticated;
  grant execute on function public.fn_marketer_topup_demo(uuid,bigint) to service_role;
end $g$;

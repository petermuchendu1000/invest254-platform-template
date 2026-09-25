-- 0169_demo_money_guards.sql — DEMO-2: demo money never leaves; a new demo account opens funded.
--
-- 1. fn_create_withdrawal refuses DEMO_ACCOUNT while the wallet is in demo mode. Before this, a player
--    in demo mode saw the demo balance in the withdraw sheet and a withdrawal silently debited the REAL
--    bucket (BUGLOG #82). Marketers never reach this function (the API sends them to the demo transfer
--    and the function already refuses them).
-- 2. fn_topup_demo_account takes the target from the API, so a USD brand opens at $10,000 (converted
--    to KES cents at the live rate) and a KES brand at KES 10,000. Bounded server-side; the API is the
--    only caller (service_role).
--
-- INVARIANTS (packages/db/_testkit/e2e_account_demo_mode.py, section E/G). Additive + idempotent.

begin;

create or replace function public.fn_create_withdrawal(p_user uuid, p_amount bigint, p_phone text, p_min bigint, p_site_id uuid)
 returns table(tx_id uuid, new_balance bigint)
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_bal bigint; v_id uuid; v_registered text; v_mode text;
begin
  if public.fn_is_marketer_account(p_user) then raise exception 'MARKETER_NO_REAL_WITHDRAWAL'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_amount < p_min then raise exception 'BELOW_MIN'; end if;
  -- F-49: pay out only to the account's registered number.
  select phone into v_registered from profiles where id = p_user;
  if v_registered is null
     or right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9) <> right(regexp_replace(v_registered, '\D', '', 'g'), 9)
     or length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 9 then
    raise exception 'PAYOUT_PHONE_MISMATCH';
  end if;
  select real_balance, account_mode into v_bal, v_mode from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  -- DEMO-2: the row is locked, so a switch to demo cannot race past this check.
  if v_mode = 'demo' then raise exception 'DEMO_ACCOUNT'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set real_balance = real_balance - p_amount where user_id = p_user and site_id = p_site_id
    returning real_balance into v_bal;
  insert into transactions(user_id, site_id, kind, amount, status, provider, phone)
    values (p_user, p_site_id, 'withdrawal', p_amount, 'pending', 'mpesa', p_phone) returning id into v_id;
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, p_site_id, 'withdrawal', -p_amount, 'real', 'transactions', v_id::text);
  return query select v_id, v_bal;
end;
$function$;
revoke all on function public.fn_create_withdrawal(uuid,bigint,text,bigint,uuid) from public, anon, authenticated;
grant execute on function public.fn_create_withdrawal(uuid,bigint,text,bigint,uuid) to service_role;

-- The 2-arg form is replaced by one with a target (default = the old KES 10,000), so existing
-- two-argument calls keep working and resolve to exactly one function.
drop function if exists public.fn_topup_demo_account(uuid, uuid);
create or replace function public.fn_topup_demo_account(p_user uuid, p_site_id uuid, p_target bigint default 1000000)
 returns bigint language plpgsql security definer set search_path to 'public'
as $$
declare v_target bigint := coalesce(p_target, 1000000); v_bal bigint; v_new bigint;
begin
  if v_target < 100000 or v_target > 10000000000 then raise exception 'INVALID_AMOUNT'; end if;  -- KES 1,000 .. KES 100M
  select demo_balance into v_bal from public.wallets
    where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal >= v_target then return v_bal; end if;         -- already funded -> no-op (can't be farmed)
  update public.wallets set demo_balance = v_target, updated_at = now()
    where user_id = p_user and site_id = p_site_id returning demo_balance into v_new;
  insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, p_site_id, 'adjustment', v_target - v_bal, 'demo', null, null,
            jsonb_build_object('reason', 'self_topup_demo_mode'));
  return v_new;
end;
$$;
revoke all on function public.fn_topup_demo_account(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.fn_topup_demo_account(uuid,uuid,bigint) to service_role;

commit;

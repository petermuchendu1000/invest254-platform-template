-- 0086_marketer_unification.sql — converge every DEMO/money path on the ONE canonical predicate
-- fn_is_marketer_account (migration 0084), and route admin funding of a marketer to the demo bucket.
--
-- After 0084 the pool exemption (engine loadIsMarketer), the money routing (open/settle/create_
-- withdrawal), and the finance/RTP exclusion (marketer_account_ids view) all resolve "is this a demo
-- account?" through fn_is_marketer_account. Two paths still used their OWN narrower phone match:
--   1. fn_marketer_game_withdraw looked up the marketers row with a `^254`-only normalisation, so a
--      phone stored bare (7XXXXXXXX) or as +254… could be classed marketer by fn_is_marketer_account
--      yet NOT found here — stranding the withdrawal (game-withdraw says "not marketer", then
--      fn_create_withdrawal blocks it). Re-match on the SAME significant-9-digits rule.
--   2. fn_admin_adjust_balance_kind / fn_admin_clear_balance moved 'real' money; for a demo account
--      that must be the demo_balance (marketers play on demo, real is frozen at 0). Route it.
-- Additive, idempotent, revertible.

-- ── shared normaliser: significant 9 digits (matches fn_is_marketer_account) ────────────────────────
create or replace function public.fn_phone_sig9(p text)
returns text language sql immutable as $fn$
  select right(regexp_replace(coalesce(p,''), '[^0-9]', '', 'g'), 9)
$fn$;

-- ── 1. fn_marketer_game_withdraw: find the marketers row via the canonical significant-9 match ──────
create or replace function public.fn_marketer_game_withdraw(p_user uuid, p_amount bigint)
 returns table(is_marketer boolean, tx_id uuid, new_balance bigint, mpesa_balance bigint)
 language plpgsql security definer set search_path = 'public'
as $function$
declare v_phone text; v_pstatus text; v_mid uuid; v_mstatus text; v_bal bigint; v_id uuid; v_mpesa bigint;
begin
  select phone, status into v_phone, v_pstatus from profiles where id = p_user;
  if v_phone is null then raise exception 'WALLET_NOT_FOUND'; end if;

  -- canonical cohort match (same rule as fn_is_marketer_account / marketer_account_ids)
  select id, status into v_mid, v_mstatus from marketers
    where public.fn_phone_sig9(phone) = public.fn_phone_sig9(v_phone)
      and length(public.fn_phone_sig9(v_phone)) = 9
    order by id limit 1;
  if v_mid is null then
    return query select false, null::uuid, null::bigint, null::bigint;
    return;
  end if;
  if v_pstatus is distinct from 'active' or v_mstatus is distinct from 'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select demo_balance into v_bal from wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set demo_balance = demo_balance - p_amount where user_id = p_user returning demo_balance into v_bal;

  insert into transactions(user_id, kind, amount, status, provider, phone)
    values (p_user, 'withdrawal', p_amount, 'success', 'internal', public.fn_phone_sig9(v_phone)) returning id into v_id;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, 'withdrawal', -p_amount, 'demo', 'transactions', v_id::text);

  v_mpesa := public.fn_marketer_credit(v_mid, p_amount, 'game:'||v_id::text,
               jsonb_build_object('source','game_withdrawal','tx', v_id::text));
  return query select true, v_id, v_bal, v_mpesa;
end;
$function$;

-- ── 2a. fn_admin_adjust_balance_kind: a marketer's 'real' adjustment lands in the demo bucket ───────
create or replace function public.fn_admin_adjust_balance_kind(
  p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_kind text, p_reason text
) returns table(user_id uuid, kind text, amount bigint, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_new bigint; v_action bigint; v_demo boolean; v_kind_eff text;
begin
  if p_actor_role not in ('admin','superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_kind not in ('real','bonus') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;

  v_demo := (p_kind = 'real') and public.fn_is_marketer_account(p_target);
  v_kind_eff := case when v_demo then 'demo' when p_kind = 'real' then 'real' else 'bonus' end;

  if v_kind_eff = 'demo' then
    select w.demo_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = wallets.demo_balance + p_amount where wallets.user_id = p_target returning wallets.demo_balance into v_new;
  elsif v_kind_eff = 'real' then
    select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set real_balance = wallets.real_balance + p_amount where wallets.user_id = p_target returning wallets.real_balance into v_new;
  else
    select w.bonus_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set bonus_balance = wallets.bonus_balance + p_amount where wallets.user_id = p_target returning wallets.bonus_balance into v_new;
  end if;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.adjust', 'user', p_target::text,
            jsonb_build_object('kind', v_kind_eff, 'requested_kind', p_kind, 'amount', p_amount, 'reason', p_reason, 'before', v_bal, 'after', v_new))
    returning id into v_action;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_target, 'adjustment', p_amount, v_kind_eff, 'admin_actions', v_action::text,
            jsonb_build_object('reason', p_reason, 'actor', p_actor));
  return query select p_target, v_kind_eff, p_amount, v_new;
end;
$fn$;

-- ── 2b. fn_admin_clear_balance: a marketer's 'real'/'both' clear zeroes the demo bucket ─────────────
create or replace function public.fn_admin_clear_balance(
  p_actor uuid, p_actor_role text, p_target uuid, p_kind text, p_reason text
) returns table(user_id uuid, real_balance bigint, bonus_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_real bigint; v_bonus bigint; v_demo bigint; v_action bigint; v_is_demo boolean; v_spend_kind text;
begin
  if p_actor_role not in ('admin','superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_kind not in ('real','bonus','both') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;

  select w.real_balance, w.bonus_balance, w.demo_balance into v_real, v_bonus, v_demo from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  v_is_demo := public.fn_is_marketer_account(p_target);
  v_spend_kind := case when v_is_demo then 'demo' else 'real' end;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.clear', 'user', p_target::text,
            jsonb_build_object('kind', p_kind, 'reason', p_reason, 'before_real', v_real, 'before_bonus', v_bonus, 'before_demo', v_demo, 'spend_kind', v_spend_kind))
    returning id into v_action;

  -- 'real'/'both' clears the account's SPENDABLE bucket: demo for a marketer, else real.
  if p_kind in ('real','both') then
    if v_is_demo and v_demo <> 0 then
      update wallets set demo_balance = 0 where wallets.user_id = p_target;
      insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (p_target, 'adjustment', -v_demo, 'demo', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
    elsif (not v_is_demo) and v_real <> 0 then
      update wallets set real_balance = 0 where wallets.user_id = p_target;
      insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (p_target, 'adjustment', -v_real, 'real', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
    end if;
  end if;
  if p_kind in ('bonus','both') and v_bonus <> 0 then
    update wallets set bonus_balance = 0 where wallets.user_id = p_target;
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', -v_bonus, 'bonus', 'admin_actions', v_action::text, jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
  end if;

  select w.real_balance, w.bonus_balance, w.demo_balance into v_real, v_bonus, v_demo from wallets w where w.user_id = p_target;
  -- return the SPENDABLE balance in the real_balance slot (mirrors getBalance surfacing demo for marketers)
  return query select p_target, case when v_is_demo then v_demo else v_real end, v_bonus;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_phone_sig9(text) from public, anon, authenticated;
  grant  execute on function public.fn_phone_sig9(text) to service_role, authenticated;
  revoke all on function public.fn_marketer_game_withdraw(uuid,bigint) from public;
  grant  execute on function public.fn_marketer_game_withdraw(uuid,bigint) to service_role;
  grant  execute on function public.fn_admin_adjust_balance_kind(uuid,text,uuid,bigint,text,text) to authenticated, service_role;
  grant  execute on function public.fn_admin_clear_balance(uuid,text,uuid,text,text) to authenticated, service_role;
end $g$;

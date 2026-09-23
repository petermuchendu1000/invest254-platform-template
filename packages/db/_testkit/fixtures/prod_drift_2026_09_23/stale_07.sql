CREATE OR REPLACE FUNCTION public.fn_marketer_topup_demo(p_user uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_target bigint := 1000000; v_bal bigint; v_site uuid; v_new bigint;
begin
  if not public.fn_is_marketer_account(p_user) then raise exception 'NOT_A_DEMO_ACCOUNT'; end if;
  select demo_balance, site_id into v_bal, v_site from public.wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal >= v_target then return v_bal; end if;   -- already funded → no-op (can't be farmed)
  update public.wallets set demo_balance = v_target where user_id = p_user returning demo_balance into v_new;
  insert into public.ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, v_site, 'adjustment', v_target - v_bal, 'demo', null, null,
            jsonb_build_object('reason', 'self_topup_demo'));
  return v_new;
end;
$function$


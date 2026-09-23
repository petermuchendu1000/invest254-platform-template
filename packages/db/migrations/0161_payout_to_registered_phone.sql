-- 0161_payout_to_registered_phone.sql — F-49 (BUGLOG #64).
--
-- Password reset for PLAYERS is phone-only (no OTP) while ALLOW_UNVERIFIED_PASSWORD_RESET is on — it is,
-- in production (probed 2026-09-23). Anyone who knows a player's phone number could reset the password,
-- sign in, and request a withdrawal to THEIR OWN M-Pesa number (the form allowed "Change number").
-- Money-side fix, independent of how an attacker got in: a real-money withdrawal is paid ONLY to the
-- account's registered phone. Compared on the significant 9 digits so 07…/2547…/+2547… all match.
-- Production evidence: 74 withdrawals ever, 2 to another number, 0 of those paid.
-- Body = the live definition (0084) + the phone check. Idempotent.

create or replace function public.fn_create_withdrawal(p_user uuid, p_amount bigint, p_phone text, p_min bigint, p_site_id uuid)
 returns table(tx_id uuid, new_balance bigint)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_bal bigint; v_id uuid; v_registered text;
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
  select real_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
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

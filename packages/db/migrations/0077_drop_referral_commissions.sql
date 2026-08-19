-- 0077_drop_referral_commissions.sql — remove the deposit-based multi-level referral-commission
-- engine that was applied to the live DB out-of-band (it never existed in this repo).
--
-- What this reverts:
--   * fn_complete_deposit had a `perform fn_pay_referral_commissions(...)` hook injected into it.
--     We restore the canonical (0048) body WITHOUT that hook. The deposit-CONFIRMED pg_notify is a
--     SEPARATE trigger (0071) and is deliberately left intact.
--   * drops fn_pay_referral_commissions(uuid) and the deposit_commissions ledger table.
--
-- NOT touched (native affiliate program): affiliate_commissions, affiliate_payouts, referrals,
-- fn_gen_referral_code, fn_admin_set_commission_rate, fn_accrue_affiliate_commissions.
--
-- Safe: deposit_commissions holds 0 rows at cutover (no paid commissions to unwind). Idempotent.

-- ── 1) restore the clean, site-aware fn_complete_deposit (0048), sans the commission hook ────────
create or replace function public.fn_complete_deposit(
  p_checkout text, p_result_code int, p_result_desc text, p_receipt text, p_raw jsonb
) returns table(applied boolean, status text, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_tx public.transactions%rowtype; v_bal bigint;
begin
  select * into v_tx from transactions where checkout_request_id = p_checkout and kind = 'deposit' for update;
  if not found then raise exception 'TX_NOT_FOUND'; end if;
  if v_tx.status in ('success','failed') then
    select real_balance into v_bal from wallets where user_id = v_tx.user_id;
    return query select false, v_tx.status, v_bal; return;
  end if;
  if p_result_code = 0 then
    update transactions set status='success', result_code=p_result_code, result_desc=p_result_desc,
           mpesa_receipt=p_receipt, raw_callback=p_raw where id = v_tx.id;
    update wallets set real_balance = real_balance + v_tx.amount where user_id = v_tx.user_id
      returning real_balance into v_bal;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (v_tx.user_id, v_tx.site_id, 'deposit', v_tx.amount, 'real', 'transactions', v_tx.id::text,
              jsonb_build_object('receipt', p_receipt));
    return query select true, 'success', v_bal; return;
  else
    update transactions set status='failed', result_code=p_result_code, result_desc=p_result_desc,
           raw_callback=p_raw where id = v_tx.id;
    select real_balance into v_bal from wallets where user_id = v_tx.user_id;
    return query select true, 'failed', v_bal; return;
  end if;
end;
$fn$;

-- ── 2) drop the commission engine's function + table ─────────────────────────────────────────────
drop function if exists public.fn_pay_referral_commissions(uuid);
drop table if exists public.deposit_commissions;

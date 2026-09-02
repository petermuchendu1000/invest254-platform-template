-- 0109_ungate_marketer_game_withdraw.sql — demo/"funny money" game→wallet transfer is INSTANT again.
--
-- CONTEXT (Issue 1 correction): migration 0108 gated the marketer (internal-rail) game→wallet
-- transfer behind admin approval and routed it to the approval channels. That path moves an account's
-- NON-withdrawable DEMO balance into the marketer's simulated M-Pesa wallet purely for social proof —
-- it never touches real cash, so it must NOT require approval and must NEVER ride the Telegram/email
-- approval channel. Only REAL money — player M-Pesa withdrawals and marketer COMMISSION payouts —
-- needs the superadmin's approval.
--
-- THIS MIGRATION:
--   1) Redefines fn_marketer_game_withdraw to settle INSTANTLY again (debit demo + credit the marketer
--      wallet + write a status='success' row in one call), keeping the canonical fn_phone_sig9 cohort
--      match introduced in 0086/0108.
--   2) Leaves fn_approve_withdrawal / fn_reject_withdrawal (0108) UNCHANGED — they still correctly
--      drive the real-money M-Pesa rail (pending → processing → B2C, and reject → refund real).
--   3) One-time completes any internal-rail withdrawals left PENDING by 0108: it credits the marketer
--      wallet the transfer intended and marks the row 'success', clearing the moderation queue.
-- Idempotent + safe to re-apply (create-or-replace; the backfill is scoped to internal+pending rows).

-- ── 1. INSTANT settle (restore pre-0108 behaviour, canonical cohort match) ──────────────────────
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
    -- Not a marketer/demo account: caller falls back to the normal (real M-Pesa) withdrawal.
    return query select false, null::uuid, null::bigint, null::bigint;
    return;
  end if;
  if v_pstatus is distinct from 'active' or v_mstatus is distinct from 'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select demo_balance into v_bal from wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set demo_balance = demo_balance - p_amount where user_id = p_user returning demo_balance into v_bal;

  -- INSTANT: settle immediately (status='success') and credit the marketer wallet in the same call.
  insert into transactions(user_id, kind, amount, status, provider, phone)
    values (p_user, 'withdrawal', p_amount, 'success', 'internal', public.fn_phone_sig9(v_phone)) returning id into v_id;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, 'withdrawal', -p_amount, 'demo', 'transactions', v_id::text);

  v_mpesa := public.fn_marketer_credit(v_mid, p_amount, 'game:'||v_id::text,
               jsonb_build_object('source','game_withdrawal','tx', v_id::text));

  return query select true, v_id, v_bal, coalesce(v_mpesa, 0);
end;
$function$;

-- ── 2. Backfill: complete internal-rail withdrawals left PENDING by 0108 ─────────────────────────
do $$
declare r record; v_mid uuid;
begin
  for r in
    select * from transactions
     where kind = 'withdrawal' and status = 'pending' and provider = 'internal'
     for update
  loop
    select id into v_mid from marketers
      where public.fn_phone_sig9(phone) = r.phone and length(r.phone) = 9
      order by id limit 1;
    if v_mid is not null then
      -- Credit the transfer the marketer intended (idempotent on ref 'game:<tx>').
      perform public.fn_marketer_credit(v_mid, r.amount, 'game:'||r.id::text,
        jsonb_build_object('source','game_withdrawal','tx', r.id::text, 'note','0109_backfill'));
      update transactions set status = 'success' where id = r.id;
    else
      -- No marketer match (shouldn't happen for internal rows): refund the held demo balance so the
      -- row is not stranded, and reverse it out of the queue.
      update wallets set demo_balance = demo_balance + r.amount where user_id = r.user_id;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
        values (r.user_id, r.site_id, 'withdrawal_reversal', r.amount, 'demo', 'transactions', r.id::text);
      update transactions set status = 'reversed' where id = r.id;
    end if;
  end loop;
end $$;
